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
 * The js_compile rule: compile the TypeScript and JavaScript sources in `srcs`
 * to JavaScript and declarations under `build/`, against the packages and
 * flags in `deps`. `resources` are files the sources import that are not
 * compiled (stylesheets), named to the compiler so those imports resolve;
 * `declarations` are declarations another compile emitted for some of the
 * sources, which are compiled against and neither checked nor emitted.
 * `package_name` is the name the sources import themselves by,
 * `module_extension` the extension the emitted JavaScript takes, and
 * `rewrite_imports` renames import specifiers. The output follows the
 * `JS_TARGET` global (which must name one module format) and `BUILD_TYPE`; the
 * source-mode flags in `deps` relax strictness or state the sources' ES level.
 *
 * The compiler is the `TSC_DRIVER` program, fabr's TypeScript driver, which
 * carries the compiler as one of its own dependencies. It is staged under its
 * own directory so its packages are not visible to the sources, and runs with
 * its cwd at the workspace root. The packages in `deps` reach it as a PnP
 * table over the cache's tree pool, so only the sources are staged. The rule
 * yields a `js:exec` action collecting `build/**`, which compiles only what
 * changed since the last successful build of the same target key. With no
 * sources it yields no files.
 */

import {
  Computable,
  COVERAGE,
  COVERAGE_ON,
  defineRule,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  Flag,
  MemoryFile,
  Name,
  PackageFileSet,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import {
  esLevelOrder,
  JSTarget,
  parseJSTarget,
  resolveJsxImportSource,
  resolveSourceMode,
  emitsSourceMap,
  resolveSourceVersion,
  usesDom,
} from "../JSPackage";
import { PNP } from "../Layout";
import { createNodeExecAction } from "../NodeExecAction";
import { assertOnePackagePerName } from "../PnPManifest";
import { describeUnit } from "../Description";
import {
  CHANGES_FILE,
  CHANGES_FLAG,
  DEPS_REPORT_FILE,
  DEPS_REPORT_FLAG,
  SOURCE_DECLARATIONS_FLAG,
  SOURCE_PATHS_FILE,
  SOURCE_PATHS_FLAG,
  STATE_DIR,
  STATE_DIR_FLAG,
} from "@fabr-build/js-tools";
import { NPM_FORMAT } from "../NPMProtocol";

/** The `js_compile` rule. */
export default defineRule({
  requirements(context) {
    return {
      build: {
        srcs: context.getFileProperty("srcs"),
        deps: context.getPackageProperty("deps", undefined, NPM_FORMAT),
        resources: context.getFileProperty("resources"),
        declarations: context.getFileProperty("declarations"),
      },
      result: "files",
    };
  },
  evaluateMaterialized(context, inputs) {
    return compileTypescript(context, inputs);
  },
  /* Describe the compile as the compilation unit an editor's TypeScript server is given. */
  describe(context, requirements) {
    return requirements
      .describeAll()
      .then(inputs => compileSetup(context, inputs))
      .then(setup => (setup === undefined ? EMPTY_FILESET : describeUnit(setup)));
  },
});

/** Where the driver's install is staged in the working directory, apart from src/ and build/. */
const TOOL_DIR = ".tools/tsc";

/**
 * The compile's layout: sources under `src/`, emitted output under `build/`.
 * A consumer that stages the compiled tree beside its sources (the test
 * install) uses the same pair, so a source map entry tsc wrote relative from
 * `build/` back to `src/` still resolves.
 */
export const COMPILE_SRC_DIR = "src";
export const COMPILE_OUT_DIR = "build";

/** @return the automatic-runtime jsx mode: `react-jsxdev` (source positions,
 * `<source>/jsx-dev-runtime`) for a debug build, else `react-jsx`. */
export function jsxModeFor(buildType: string | undefined): "react-jsx" | "react-jsxdev" {
  return buildType === "debug" ? "react-jsxdev" : "react-jsx";
}

/**
 * @return the tsconfig `paths` mapping the package's own name to its sources
 * (`@scope/pkg/sub` -> `./src/sub`), relative and extensionless so tsc applies
 * its usual extension search. A self-import is resolved by the PnP table's self
 * row; these serve the declaration emitter, which reads `paths` when it writes
 * a specifier for a type it cannot otherwise name. Do not add `baseUrl`: every
 * bare specifier would then also resolve against the source root, admitting
 * imports (`from "lib/thing"`) that resolve nowhere at runtime.
 */
function selfReferencePaths(packageName: string): Record<string, string[]> {
  return { [packageName]: ["./src/index"], [`${packageName}/*`]: ["./src/*"] };
}

/** @return the `lib` list: the source level, plus `dom` and `dom.iterable` where
 * the sources use the DOM (TypeScript 6 merged `dom.iterable` into `dom`, leaving
 * the name an empty lib; before 6 it is a lib of its own). */
function libFor(level: string, hasDom: boolean): string[] {
  return hasDom ? [level, "dom", "dom.iterable"] : [level];
}

/**
 * @return `{ useDefineForClassFields: false }` where the sources declare an ES
 * level below es2022 and the emit target is es2022 or later, otherwise no
 * option (also where the sources declare no level). From es2022 tsc emits an
 * uninitialized field declaration as a class field set to `undefined` after
 * `super()` returns, which overwrites a value a base constructor assigned
 * (`Object.assign(this, data)`).
 */
function defineClassFieldsOverride(sourceVersion: string | undefined, target: string): Record<string, unknown> {
  if (sourceVersion === undefined) {
    return {};
  }
  const definesFields = (level: string): boolean => esLevelOrder(level) >= 2022;
  return !definesFields(sourceVersion) && definesFields(target) ? { useDefineForClassFields: false } : {};
}

/**
 * @return true if the emit target is below es2015, where `for..of` and spread
 * need `downlevelIteration`, otherwise false. Without it tsc emits an index
 * loop, which refuses a Map, Set or generator (TS2802) and iterates a string
 * by UTF-16 code unit.
 */
function needsDownlevelIteration(target: string): boolean {
  return esLevelOrder(target) < 2015;
}

/**
 * @return the names, sorted and without the `@types/` prefix, of the `@types`
 * packages among the direct `deps`: what tsc's automatic inclusion would find
 * by scanning `node_modules/@types`, which a compile through a PnP table has
 * no directory for.
 */
function automaticTypes(deps: FileSet[]): string[] {
  return deps
    .filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet && dep.packageName.startsWith("@types/"))
    .map(dep => dep.packageName.substring("@types/".length))
    .sort();
}

/**
 * Make the tsconfig a compile runs under: strict, emitting JavaScript and
 * declarations from `src/` to `build/` at `jsTarget`'s ES level and module
 * format, and including every TypeScript and JavaScript extension. JavaScript
 * sources are compiled to `target` and importable from TypeScript, but not
 * type-checked. `lib` is `sourceVersion` where given, else the emit level.
 * Where `jsx` is given the automatic JSX transform is emitted, importing
 * `<importSource>/jsx-runtime`, which the target must carry as a dep (see
 * resolveJsxImportSource). `modeOverlay` is applied last, over every other
 * option. `moduleResolution` is left for the driver to choose.
 */
export function makeTsConfig(
  jsTarget: JSTarget,
  jsx?: { mode: string; importSource: string },
  modeOverlay: Record<string, unknown> = {},
  buildType?: string,
  packageName?: string,
  sourceVersion?: string,
  /** True if the sources declare the `dom` flag (see usesDom). */
  hasDom = false,
  /** The `@types` packages to include (see {@link automaticTypes}); omitted,
   * tsc's own scan applies. */
  types?: string[],
  /** True to emit JS source maps; by default, where the build type carries them. */
  sourceMaps = emitsSourceMap(buildType)
): Record<string, unknown> {
  return {
    compilerOptions: {
      declaration: true,
      /* No declarationMap: a `.d.ts.map` resolves only against a shipped `src/`
       * tree (`inlineSources` does not embed sources in it), and none is
       * shipped. */
      outDir: COMPILE_OUT_DIR,
      rootDir: COMPILE_SRC_DIR,
      /* Strict, unless the source-mode flags in `deps` relax it through
       * `modeOverlay`. */
      strict: true,
      /* Dependencies' `.d.ts` files are not checked, `import data from
       * "./x.json"` is allowed, and a default import of a CommonJS module
       * (`import express from "express"`) works as it does in Node. The
       * `ts/no_es_module_interop` source-mode flag turns interop off, for
       * sources written with `import * as x` of a callable module. */
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      /* Accept .js/.jsx as compile inputs (downleveled to `target`, and
       * importable from .ts), but never typecheck them. */
      allowJs: true,
      checkJs: false,
      /* Let a non-JS import be typed by a `{base}.d.{ext}.ts` declaration beside
       * it (TS 5.0+), so `import styles from "./x.module.scss"` gets its class
       * names' type. This only makes the import resolve; what the output names
       * in its place is the `rewrite_imports` property's. */
      allowArbitraryExtensions: true,
      target: jsTarget.version,
      ...(needsDownlevelIteration(jsTarget.version) ? { downlevelIteration: true } : {}),
      /* `lib` is what the sources may use, `target` what is emitted: the
       * sources' declared level, else the emit level. */
      lib: libFor(sourceVersion ?? jsTarget.version, hasDom),
      ...defineClassFieldsOverride(sourceVersion, jsTarget.version),
      ...(types ? { types } : {}),
      /* One compile emits one module format: a `dual` package is two compiles,
       * each pinned to a format by its caller (checked in compileSetup). */
      module: jsTarget.module === "esm" ? "esnext" : "commonjs",
      /* Leave `moduleResolution` out: the right value depends on the compiler
       * version, which only the driver knows (`resolutionFor`; before
       * TypeScript 6 a CommonJS emit cannot use `bundler`, TS5095, and from 6
       * `node10` is an error, TS5107). The driver keeps a value the tsconfig
       * states. */
      ...(packageName ? { paths: selfReferencePaths(packageName) } : {}),
      /* JS source maps where asked for (a debuggable build, or one measured for
       * coverage), with the TypeScript sources embedded (`inlineSources`) so a
       * map needs no shipped `src/` tree. tsc writes the `//# sourceMappingURL=`
       * comment whenever `sourceMap` is on. */
      ...(sourceMaps ? { sourceMap: true, inlineSources: true } : {}),
      ...(jsx ? { jsx: jsx.mode, jsxImportSource: jsx.importSource } : {}),
      /* Force formatted diagnostics: tsc ignores FORCE_COLOR and checks only its
       * own TTY. This also overrides NO_COLOR in the driver's environment;
       * unwanted codes are stripped when the output is rendered. */
      pretty: true,
      /* Source-mode relaxations last, so they override the defaults above
       * (e.g. `strict: false`, `noImplicitAny: false`). */
      ...modeOverlay,
    },
    exclude: ["node_modules"],
    /* Every extension classifyJsSource routes here: one left out would leave
     * its sources uncompiled with no error. */
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

/** Where the {@link importRewrites} document is staged. */
const REWRITES_FILE = "rewrite-imports.json";

/** The driver flag naming that document; must match the driver's own
 * REWRITES_FLAG (tsc-driver.ts). */
const REWRITES_FLAG = "--rewrite-imports";

/** Where the names of the `resources` files are staged, and the driver flag
 * naming them. Stage the names, not the files: the compiler only asks whether a
 * file is there, and the bytes would key the compile on every stylesheet's
 * content. */
const RESOURCES_FILE = "resources.json";
const RESOURCES_FLAG = "--resources";

/** Where the `declarations` property's files are staged. */
const DECLARATIONS_DIR = ".fabr-declarations";

/**
 * Convert the `rewrite_imports` rules into the driver's document: an ordered
 * list of pattern/replacement pairs, the first match winning. Returns undefined
 * where there are none, and then neither the file nor the flag is passed.
 * Throws a FabrError for a rule using an alias. Keep the rules as patterns,
 * not resolved against the sources: the document is in the action's key, and
 * one entry per stylesheet would make each new stylesheet rebuild the whole
 * compile.
 */
export function importRewrites(rewrites: Name[]): Array<{ pattern: string; replacement: string }> | undefined {
  const rules = rewrites.flatMap(name => {
    const renameTo = name.getRenameTo();
    if (renameTo === undefined) {
      return [];
    }
    const { pattern, replacement, excludes } = name.toRenameRule(renameTo);
    if (excludes !== undefined) {
      /* An aliased selector's base matches the pattern but must not be
       * renamed, which the driver cannot be told. Only a hand-written value
       * can carry an alias. */
      throw new FabrError(`js_compile: a 'rewrite_imports' rule may not use an alias ('${name.toString()}')`);
    }
    return [{ pattern, replacement }];
  });
  return rules.length === 0 ? undefined : rules;
}

/** A compile's requirements, materialized. */
interface CompileInputs {
  srcs: FileSet[];
  deps: FileSet[];
  resources: FileSet[];
  declarations: FileSet[];
}

/** What a compile is made of, worked out from its requirements and its configuration. */
export interface ICompileSetup {
  /** The tsconfig the compile runs with. */
  tsconfig: Record<string, unknown>;
  /** The sources, as the compile stages them under `src/`. */
  srcs: FileSet;
  /** The direct dependencies, packages and flags. */
  deps: FileSet[];
  /** The package the sources may import themselves as. */
  packageName?: string;
  moduleExtension?: string;
  rewrites?: Array<{ pattern: string; replacement: string }>;
  /** The files the sources import that are not compiled. */
  resources: FileSet;
  /** The declarations another compile emitted for some of `srcs`. */
  declarations: FileSet;
}

/** @return the names of `resources`, sorted, as the compile's driver is told them. */
function resourceNamesOf(resources: FileSet): string[] {
  return [...resources].map(([name]) => name).sort();
}

/** Work out the compile `inputs` make in `context`'s configuration, or undefined
 * where they hold no sources. Throws where `JS_TARGET` is `dual` or two packages
 * in `deps` share a name. */
function compileSetup(
  context: TargetContext,
  { srcs: srcSets, deps, resources, declarations }: CompileInputs
): Computable<ICompileSetup | undefined> {
  if (srcSets.every(srcs => srcs.isEmpty())) {
    return Computable.resolve(undefined);
  }
  return Computable.forAll(
    [
      context.getGlobalString("JS_TARGET"),
      context.getGlobalString("BUILD_TYPE"),
      context.getProperty("package_name"),
      context.getProperty("module_extension"),
      context.getRewriteRules("rewrite_imports"),
      context.getGlobalString(COVERAGE),
    ],
    (target, buildType, packageNameProp, moduleExtensionProp, rewriteRules, coverage) => {
      assertOnePackagePerName(deps);
      /* The source-mode flags (strictness relaxations, the ES level) are among
       * `deps`. */
      const depFlags = deps.filter((dep): dep is Flag => dep instanceof Flag);
      const jsTarget = parseJSTarget(target);
      if (jsTarget.module === "dual") {
        /* Every caller pins a format (js_package makes one compile per format,
         * the test and bundle paths force theirs), so this is a rule's bug, not
         * a user's error. */
        throw new FabrError("js_compile cannot emit a dual target: its caller must pin a module format");
      }
      const packageName = packageNameProp?.toString();
      const moduleExtension = moduleExtensionProp?.toString();
      const srcs = FileSet.unionAll(...srcSets);
      /* The compilerOptions the flags set; empty leaves the strict tsconfig as
       * it is. */
      const modeOverlay = resolveSourceMode(depFlags);
      /* The ES level these sources are written against (an `es<level>` flag
       * among deps), which drives `lib` and the class-field semantics. */
      const sourceVersion = resolveSourceVersion(depFlags);
      /* A .tsx/.jsx source needs a jsxImportSource, found among the direct
       * deps; a compile without JSX has none. */
      const hasJsx = [...srcs].some(([name]) => {
        const lower = name.toLowerCase();
        return lower.endsWith(".tsx") || lower.endsWith(".jsx");
      });
      /* The rules redirecting an import to the file it names, which the
       * driver applies both to resolve the specifier and to write it in the
       * output. A compile with none passes no file and no flag, so its key is
       * unchanged. */
      const rewrites = importRewrites(rewriteRules);
      /* The files the sources import that are not compiled; the driver is
       * told their names so those imports resolve. */
      const resourceSet = FileSet.unionAll(...(resources ?? []));
      const setup = (jsxImportSource: string): ICompileSetup => {
        const jsx = jsxImportSource ? { mode: jsxModeFor(buildType), importSource: jsxImportSource } : undefined;
        const tsconfig = makeTsConfig(
          jsTarget,
          jsx,
          modeOverlay,
          buildType,
          packageName,
          sourceVersion,
          usesDom(depFlags),
          automaticTypes(deps),
          emitsSourceMap(buildType) || coverage === COVERAGE_ON
        );
        return {
          tsconfig,
          srcs,
          deps,
          packageName,
          moduleExtension,
          rewrites,
          resources: resourceSet,
          declarations: FileSet.unionAll(...declarations),
        };
      };
      return hasJsx ? resolveJsxImportSource(deps).then(setup) : setup("");
    }
  );
}

function compileTypescript(context: TargetContext, inputs: CompileInputs): Computable<RuleResult> {
  return compileSetup(context, inputs).then(setup =>
    setup === undefined ? EMPTY_FILESET : context.getGlobalRunnable("TSC_DRIVER").then(driver => compileAction(setup, driver))
  );
}

/** Make the compile action for `setup`, run by `driver`. */
function compileAction(
  { tsconfig, srcs, deps, packageName, moduleExtension, rewrites, resources, declarations }: ICompileSetup,
  driver: RunnableFileSet
): RuleResult {
  const resourceNames = resourceNamesOf(resources);
  const workspace = {
    [COMPILE_SRC_DIR]: srcs,
    /* Staged as content: which of them changed tells the driver which
     * sources' interfaces changed. */
    ...(declarations.isEmpty() ? {} : { [DECLARATIONS_DIR]: declarations }),
    /* The driver's own install, with the compiler (`${TYPESCRIPT}`) among
     * its dependencies in its node_modules. */
    [TOOL_DIR]: driver,
  };
  /* The generated configuration, staged beside the sources but keyed as
   * configuration: each distinct tsconfig (a test compile pinned to a format,
   * a release build) has a target key and incremental base of its own, and a
   * change to it never appears among the changed files, where the driver
   * could trace it to no source and would compile everything. */
  const config = FileSet.layout({
    "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
    ...(rewrites ? { [REWRITES_FILE]: MemoryFile.from(JSON.stringify(rewrites)) } : {}),
    ...(resourceNames.length === 0 ? {} : { [RESOURCES_FILE]: MemoryFile.from(JSON.stringify(resourceNames)) }),
  });
  /* The driver launches from its own directory (its packages resolve
   * there), with its cwd at the workspace root, which `include` and package
   * lookups resolve against.
   *
   * The packages are passed as they are, with the layout named: on a miss
   * the step writes their PnP table, so evaluation stages nothing. */
  /* The ES-module format of a dual package emits `.mjs` so its tree can ship
   * beside the CommonJS format's. The driver does the renaming, because the
   * specifiers it writes have to name the renamed siblings. */
  const emitExtension = moduleExtension ? ["--emit-extension", moduleExtension] : [];
  const rewriteFlag = rewrites ? [REWRITES_FLAG, REWRITES_FILE] : [];
  const resourcesFlag = resourceNames.length === 0 ? [] : [RESOURCES_FLAG, RESOURCES_FILE];
  const declarationsFlag = declarations.isEmpty() ? [] : [SOURCE_DECLARATIONS_FLAG, DECLARATIONS_DIR];
  return createNodeExecAction(
    FileSet.layout(workspace),
    deps,
    driver.toCommandLine(
      [
        ...emitExtension,
        ...rewriteFlag,
        ...resourcesFlag,
        ...declarationsFlag,
        DEPS_REPORT_FLAG,
        DEPS_REPORT_FILE,
        STATE_DIR_FLAG,
        STATE_DIR,
        CHANGES_FLAG,
        CHANGES_FILE,
        SOURCE_PATHS_FLAG,
        SOURCE_PATHS_FILE,
      ],
      { base: TOOL_DIR }
    ),
    `${COMPILE_OUT_DIR}:**`,
    {
      layout: PNP,
      label: "compile",
      config,
      /* The four locations the argv above names, which the step stages and
       * collects. The driver reports which declaration files it read, and the
       * entry is keyed on those instead of on the whole of `deps`. Given the
       * last successful build of this target key (its state, its output and
       * what changed since), it checks and emits only what the change
       * reaches. */
      depsReport: DEPS_REPORT_FILE,
      stateDir: STATE_DIR,
      changes: CHANGES_FILE,
      sourcePaths: SOURCE_PATHS_FILE,
      /* The sources' own package name is a row of the PnP table, so a
       * self-import resolves as an import of any package does. */
      self: packageName ? { name: packageName, location: `./${COMPILE_SRC_DIR}/` } : undefined,
    }
  );
}
