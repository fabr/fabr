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
 * `{ srcs = FILES; deps = FILES }`. `deps` is the node_modules the sources are
 * compiled against (package deps + any @types, already resolved by the caller
 * so materialization here is a no-op). It resolves its *own*
 * toolchain — `TSC` (a build tool, independent of what it compiles) as a
 * **runnable** (`BUILD_OPERATION=run`), so it needn't know how to launch it —
 * and its own `JS_TARGET`, derives the tsconfig, and lays out the working
 * directory. The tool is **mounted apart** from the workspace (under `TOOL_DIR`,
 * not merged into `node_modules`): the tool's own dependencies must not collide
 * with — nor be visible to — the sources' `node_modules`. It runs with cwd at
 * the workspace root and yields the `exec` action (output: `build/**`).
 */


import { Computable, createExecAction, FileSet, MemoryFile, RuleRegistration, RuleResult, TargetContext } from "@fabr-build/core";
import { assembleScopedNodeModules, JSTarget, parseJSTarget, resolveJsxImportSource, resolveSourceMode } from "../JSPackage";

/** Where the toolchain is mounted in the working dir — disjoint from src/node_modules/build. */
const TOOL_DIR = ".tools/tsc";

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
 */
function selfReferencePaths(packageName: string): Record<string, string[]> {
  return { [packageName]: ["./src/index"], [`${packageName}/*`]: ["./src/*"] };
}

export function makeTsConfig(
  jsTarget: JSTarget,
  jsx?: { mode: string; importSource: string },
  modeOverlay: Record<string, unknown> = {},
  buildType?: string,
  packageName?: string
): Record<string, unknown> {
  return {
    compilerOptions: {
      declaration: true,
      /* No declarationMap: a `.d.ts.map` can only resolve against a shipped
       * `src/` tree (unlike a JS map, `inlineSources` does NOT embed sources
       * into it), which we don't ship — so it would only ever dangle. Editor
       * go-to-definition into the `.ts` awaits a future ship-source flag. */
      outDir: "build",
      rootDir: "src",
      /* Strict by default (fabr's own code and modern TS); a target relaxes it
       * per its `deps` source-mode flags, folded in via `modeOverlay` below. */
      strict: true,
      /* Ecosystem-baseline options every real tsconfig sets: skip typechecking
       * dependency .d.ts (a broken third-party type can't fail the build, and
       * it's faster), allow `import data from "./x.json"`, and interop default
       * imports of CJS modules (`import express from "express"` — matching Node's
       * actual ESM/CJS runtime semantics and what esbuild always does). A target
       * written for classic interop (`import * as x` of a callable module) opts
       * out via the `ts/no_esmodule_interop` source-mode flag. */
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      /* Accept .js/.jsx as compile inputs (downleveled to `target`, and
       * importable from .ts), but never typecheck them. */
      allowJs: true,
      checkJs: false,
      target: jsTarget.version,
      lib: jsTarget.environment === "browser" ? [jsTarget.version, "dom"] : [jsTarget.version],
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
      context.getGlobalRunnable("TSC"),
      context.getGlobalString("BUILD_TYPE"),
      context.getFlags("deps"),
      context.getProperty("package_name"),
    ],
    ({ srcs: srcSets, deps }, target, tsc, buildType, depFlags, packageNameProp) => {
      const packageName = packageNameProp?.toString();
      const srcs = FileSet.unionAll(...srcSets);
      /* Source-mode flags (strictness relaxations) ride among `deps` like any
       * other dep — read here with getFlags and recognized into a compilerOptions
       * overlay (the flag→option table lives with the tsconfig it feeds). Empty
       * (the default) leaves the strict tsconfig unchanged. The materialized
       * `deps` above carries the packages; a flag materializes to nothing. */
      const modeOverlay = resolveSourceMode(depFlags);
      /* js_compile owns its node_modules layout (only it needs it) and its JSX
       * runtime: both read the ordered direct deps directly. A .tsx/.jsx source
       * needs a jsxImportSource (auto-detected from the deps); a JSX-free compile
       * omits it. */
      const hasJsx = [...srcs].some(([name]) => {
        const lower = name.toLowerCase();
        return lower.endsWith(".tsx") || lower.endsWith(".jsx");
      });
      const build = (jsxImportSource: string): RuleResult => {
        const jsx = jsxImportSource ? { mode: jsxModeFor(buildType), importSource: jsxImportSource } : undefined;
        const tsconfig = makeTsConfig(parseJSTarget(target), jsx, modeOverlay, buildType, packageName);
        const workingDir = FileSet.layout({
          node_modules: assembleScopedNodeModules(deps),
          src: srcs,
          "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
          [TOOL_DIR]: tsc,
        });
        /* The tool launches from its own mount (its deps resolve there); cwd is the
         * workspace root, so `include`/`node_modules` resolve against the sources. */
        return createExecAction(workingDir, tsc.toCommandLine([], { base: TOOL_DIR }), "build:**", "compile");
      };
      return hasJsx ? resolveJsxImportSource(deps).then(build) : build("");
    }
  );
}

export const jsCompileRule: RuleRegistration = { type: "js_compile", constraints: {}, evaluate: compileTypescript };
