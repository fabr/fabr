/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
 *
 * This file is part of Fabr.
 *
 * Fabr is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Fabr is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Fabr. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * The js_compile rule: the one TS-compile path, a self-contained target
 * `{ srcs = FILES; deps = FILES }`. `deps` are the dependencies the sources are
 * compiled against (package deps + any @types, already resolved by the caller
  * so materialization here is a no-op). It resolves its *own* toolchain as a
 * **runnable** (`BUILD_OPERATION=run`), so it needn't know how to launch it:
 * fabr's TypeScript **driver** (TSC_DRIVER, internal), which carries the pinned
 * compiler as one of its own dependencies — the compiler's own CLI cannot be
 * told where packages are, and this one can. It resolves its own `JS_TARGET`,
 * derives the tsconfig, and lays out the working directory. The tool is
 * **mounted apart** from the workspace (under `TOOL_DIR`): its dependencies
 * must not collide with — nor be visible to — the sources'. It runs with cwd at
 * the workspace root and yields the `exec` action (output: `build/**`).
 *
 * The dependencies reach the compiler as a generated PnP manifest over the
 * cache's tree pool, so a compile stages only its own sources however large its
 * closure — there is no tree to build.
 */


import {
  Computable,
  FileSet,
  MemoryFile,
  PackageFileSet,
  RuleRegistration,
  RuleResult,
  TargetContext,
} from "@fabr-build/core";
import {
  esLevelOrder,
  JSTarget,
  parseJSTarget,
  resolveJsxImportSource,
  resolveSourceMode,
  resolveSourceVersion,
  usesDom,
} from "../JSPackage";
import { createNodeExecAction, PNP } from "../NodeExecAction";

/** Where the toolchain is mounted in the working dir — disjoint from src/node_modules/build. */
const TOOL_DIR = ".tools/tsc";

/**
 * The compile's own layout: sources under `src/`, emitted output under `build/`.
 *
 * Exported because it is not private to this rule after all — a consumer that
 * mounts the compiled tree ALONGSIDE its sources has to reproduce the same
 * pairing, or the `sources` paths tsc writes into each `.js.map` (relative from
 * outDir back to rootDir) resolve to nothing. The test install does exactly
 * that, which is what lets a stack frame — and jest's code frame — name the
 * original TypeScript.
 */
export const COMPILE_SRC_DIR = "src";
export const COMPILE_OUT_DIR = "build";

/** The automatic-runtime jsx mode: the dev variant (source-position
 * instrumentation, `<src>/jsx-dev-runtime`) for a debug build, else production. */
export function jsxModeFor(buildType: string | undefined): "react-jsx" | "react-jsxdev" {
  return buildType === "debug" ? "react-jsxdev" : "react-jsx";
}

/**
 * The tsconfig the compile runs under. `include` matches `.ts`/`.tsx` and
 * `.js`/`.jsx` (all routed to this compile), so none is silently ignored. `.js`
 * comes in via `allowJs`: tsc downlevels it to `target` (a package's own JS
 * honors JS_TARGET) and includes it in the program (a `.ts` can import a local
 * `.js`), while `checkJs` stays off — JS is transpiled, not typechecked, so
 * untyped JS can't fail the build. When a `jsx` runtime is given, the automatic
 * transform is emitted — a JSX source's code imports `<jsxImportSource>/jsx-runtime`,
 * so the target must carry that runtime as a dep (auto-detected, see resolveJsxImportSource).
 */
/** BUILD_TYPEs that carry JS source maps: full debugging (`debug`) and
 * optimized-but-debuggable (`relwithdebinfo`); `release` strips them. The
 * default BUILD_TYPE is `debug` (STD.fabr), so a plain build is debuggable. */
function emitsSourceMap(buildType: string | undefined): boolean {
  return buildType === "debug" || buildType === "relwithdebinfo";
}

/**
 * The `paths` entries that let a package's sources import their own package
 * name (`@scope/pkg/sub` -> `src/sub`). Node resolves an installed package's
 * own name through node_modules; these sources are not installed anywhere yet,
 * so the mapping stands in for that until they are.
 *
 * Deliberately NOT `baseUrl`: that would additionally make every bare specifier
 * try the source root, quietly admitting root-relative imports (`from
 * "lib/thing"`) that resolve nowhere at runtime. `paths` alone is resolved
 * against the tsconfig's own directory (TS 4.1+), which is the scope wanted.
 * Targets are relative (TS requires that without a baseUrl) and extensionless,
 * so tsc applies its usual extension search.
 *
 * Not what resolves a self-reference any more — the manifest's self row does
 * that, before any `paths` lookup happens. It stays for the DECLARATION
 * EMITTER, which consults `paths` when synthesizing a specifier for a type it
 * cannot otherwise name; that is not resolution, and nothing else supplies it.
 */
function selfReferencePaths(packageName: string): Record<string, string[]> {
  return { [packageName]: ["./src/index"], [`${packageName}/*`]: ["./src/*"] };
}

/** The `lib` list: the source level, plus the DOM when emitting for a browser. */
function libFor(level: string, hasDom: boolean): string[] {
  return hasDom ? [level, "dom"] : [level];
}

/**
 * `useDefineForClassFields` defaults to true from target ES2022, which changes
 * what is EMITTED: an uninitialized field declaration becomes a real class
 * field, defined (as `undefined`) after `super()` returns. Sources written
 * before that semantic — anything populating fields from a base constructor,
 * `Object.assign(this, data)` being the common shape — have those values
 * silently overwritten, and TypeScript only warns (TS2612) for the subset that
 * shadow a base property.
 *
 * So when the source predates define semantics and the emit target does not,
 * keep assignment semantics: the source's own declared level says which
 * semantic it was written for. Nothing is forced when no level is declared —
 * the target's tsc default stands.
 */
function defineClassFieldsOverride(sourceVersion: string | undefined, target: string): Record<string, unknown> {
  if (sourceVersion === undefined) {
    return {};
  }
  const definesFields = (level: string): boolean => esLevelOrder(level) >= 2022;
  return !definesFields(sourceVersion) && definesFields(target) ? { useDefineForClassFields: false } : {};
}

/**
 * Below es2015 there is no native iteration protocol, and tsc's default emit
 * for `for..of` and spread is an index loop: correct for an array, wrong for
 * every other iterable — a Map/Set/generator is rejected outright (TS2802) and
 * a string is silently mis-iterated over UTF-16 code units. `downlevelIteration`
 * emits the real protocol instead, and has no effect from es2015 up, so it is
 * derived from the emit target rather than offered as a flag: no source wants
 * the index loop.
 */
function needsDownlevelIteration(target: string): boolean {
  return esLevelOrder(target) < 2015;
}

/**
 * The `@types` packages a compile includes without being asked — tsc's own
 * automatic inclusion, which scans `node_modules/@types` and so finds nothing
 * when there is no tree to scan. Stating the list explicitly reproduces the
 * rule exactly (the DIRECT dependencies that are types packages; a transitive
 * one was never automatic either) and is what a compiler reading the manifest
 * needs, since it has no directory to enumerate.
 */
function automaticTypes(deps: FileSet[]): string[] {
  return deps
    .filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet && dep.packageName.startsWith("@types/"))
    .map(dep => dep.packageName.substring("@types/".length))
    .sort();
}

export function makeTsConfig(
  jsTarget: JSTarget,
  jsx?: { mode: string; importSource: string },
  modeOverlay: Record<string, unknown> = {},
  buildType?: string,
  packageName?: string,
  sourceVersion?: string,
  /** Whether the sources declared the `dom` flag — see usesDom. */
  hasDom = false,
  /** The automatic `@types` inclusions, where the compiler cannot discover them
   * for itself (see {@link automaticTypes}); omitted under the classic layout,
   * where tsc's own scan is authoritative. */
  types?: string[]
): Record<string, unknown> {
  return {
    compilerOptions: {
      declaration: true,
      /* No declarationMap: a `.d.ts.map` can only resolve against a shipped
       * `src/` tree (unlike a JS map, `inlineSources` does NOT embed sources
       * into it), which we don't ship — so it would only ever dangle. Editor
       * go-to-definition into the `.ts` awaits a future ship-source flag. */
      outDir: COMPILE_OUT_DIR,
      rootDir: COMPILE_SRC_DIR,
      /* Strict by default (fabr's own code and modern TS); a target relaxes it
       * per its `deps` source-mode flags, folded in via `modeOverlay` below. */
      strict: true,
      /* Ecosystem-baseline options every real tsconfig sets: skip typechecking
       * dependency .d.ts (a broken third-party type can't fail the build, and
       * it's faster), allow `import data from "./x.json"`, and interop default
       * imports of CJS modules (`import express from "express"` — matching Node's
       * actual ESM/CJS runtime semantics and what esbuild always does). A target
       * written for classic interop (`import * as x` of a callable module) opts
       * out via the `ts/no_es_module_interop` source-mode flag. */
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      /* Accept .js/.jsx as compile inputs (downleveled to `target`, and
       * importable from .ts), but never typecheck them. */
      allowJs: true,
      checkJs: false,
      target: jsTarget.version,
      ...(needsDownlevelIteration(jsTarget.version) ? { downlevelIteration: true } : {}),
      /* `lib` is what the SOURCE may use, `target` what is EMITTED: different
       * questions, so a target that declares its source level gets that,
       * falling back to the emit level when it declares none. */
      lib: libFor(sourceVersion ?? jsTarget.version, hasDom),
      ...defineClassFieldsOverride(sourceVersion, jsTarget.version),
      ...(types ? { types } : {}),
      module: jsTarget.module === "esm" ? "esnext" : "commonjs",
      moduleResolution: "node",
      ...(packageName ? { paths: selfReferencePaths(packageName) } : {}),
      /* JS source maps for debuggable builds; `release` omits them. `inlineSources`
       * embeds the original TS into each `.js.map`, so the maps are self-contained
       * and debuggable at runtime without shipping a `src/` tree. tsc always writes
       * the `//# sourceMappingURL=` link comment when `sourceMap` is on. */
      ...(emitsSourceMap(buildType) ? { sourceMap: true, inlineSources: true } : {}),
      ...(jsx ? { jsx: jsx.mode, jsxImportSource: jsx.importSource } : {}),
      /* tsc ignores FORCE_COLOR (it only checks its own TTY), so formatted
       * diagnostics must be forced here; unwanted codes are stripped at
       * render time. Note this also overrides the child's NO_COLOR. */
      pretty: true,
      /* Source-mode relaxations last, so they override the defaults above
       * (e.g. `strict: false`, `noImplicitAny: false`). */
      ...modeOverlay,
    },
    exclude: ["node_modules"],
    /* Every extension classifyJsSource routes here — an omission would leave the
     * source silently uncompiled rather than failing. */
    include: [
      "./src/**/*.ts",
      "./src/**/*.mts",
      "./src/**/*.cts",
      "./src/**/*.tsx",
      "./src/**/*.js",
      "./src/**/*.mjs",
      "./src/**/*.cjs",
      "./src/**/*.jsx",
    ],
  };
}

function compileTypescript(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSetProperties(["srcs", "deps"]),
      context.getGlobalString("JS_TARGET"),
      context.getGlobalRunnable("TSC_DRIVER"),
      context.getGlobalString("BUILD_TYPE"),
      context.getFlags("deps"),
      context.getProperty("package_name"),
    ],
    ({ srcs: srcSets, deps }, target, driver, buildType, depFlags, packageNameProp) => {
      const packageName = packageNameProp?.toString();
      const srcs = FileSet.unionAll(...srcSets);
      /* Source-mode flags (strictness relaxations) ride among `deps` like any
       * other dep — read here with getFlags and recognized into a compilerOptions
       * overlay (the flag→option table lives with the tsconfig it feeds). Empty
       * (the default) leaves the strict tsconfig unchanged. The materialized
       * `deps` above carries the packages; a flag materializes to nothing. */
      const modeOverlay = resolveSourceMode(depFlags);
      /* The ES level these sources are written against (an `es<level>` flag
       * among deps), which drives `lib` and the class-field semantics. */
      const sourceVersion = resolveSourceVersion(depFlags);
      /* js_compile owns how its dependencies reach the compiler (only it needs
       * to) and its JSX runtime: both read the ordered direct deps directly. A
       * .tsx/.jsx source needs a jsxImportSource (auto-detected from the deps);
       * a JSX-free compile omits it. */
      const hasJsx = [...srcs].some(([name]) => {
        const lower = name.toLowerCase();
        return lower.endsWith(".tsx") || lower.endsWith(".jsx");
      });
      const build = (jsxImportSource: string): RuleResult => {
        const jsx = jsxImportSource ? { mode: jsxModeFor(buildType), importSource: jsxImportSource } : undefined;
        const tsconfig = makeTsConfig(
          parseJSTarget(target),
          jsx,
          modeOverlay,
          buildType,
          packageName,
          sourceVersion,
          usesDom(depFlags),
          automaticTypes(deps)
        );
        const workspace = {
          [COMPILE_SRC_DIR]: srcs,
          "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
          /* The driver's own install, compiler included: `typescript` is one of
           * its declared dependencies, so it sits in the install's node_modules
           * and the driver requires it from there. One mount, one pin
           * (${TYPESCRIPT}) governing what compiles the sources. */
          [TOOL_DIR]: driver,
        };
        /* The tool launches from its own mount (its deps resolve there); cwd is
         * the workspace root, so `include` and dependency resolution alike
         * resolve against the staged workspace.
         *
         * The dependencies go over UNASSEMBLED, with the layout named rather
         * than built: composition is a table the step generates on a miss, so
         * evaluation stages nothing and a hit costs nothing. */
        return createNodeExecAction(
          FileSet.layout(workspace),
          deps,
          driver.toCommandLine([], { base: TOOL_DIR }),
          `${COMPILE_OUT_DIR}:**`,
          {
            layout: PNP,
            label: "compile",
            /* The sources' own package identity is a row like any other, which
             * is how a package's references to itself resolve without the
             * compiler ever searching for them. */
            ...(packageName ? { self: { name: packageName, location: `./${COMPILE_SRC_DIR}/` } } : {}),
          }
        );
      };
      return hasJsx ? resolveJsxImportSource(deps).then(build) : build("");
    }
  );
}

export const jsCompileRule: RuleRegistration = { type: "js_compile", constraints: {}, evaluate: compileTypescript };
