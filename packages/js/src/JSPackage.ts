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
 * Helpers shared by the js rules: JS target parsing, source classification and
 * source-mode flags, the compile that builds the `js_compile` sub-target, and
 * a package's bins and runnable.
 */

import { posix } from "path";
import {
  BUILD_OVERRIDE,
  Constraints,
  FabrError,
  SubTargetInputs,
  CANONICAL,
  Computable,
  mapComputable,
  ConflictError,
  EMPTY_FILESET,
  FileSet,
  FileSetRef,
  Flag,
  IFile,
  isCanonicalFileName,
  isJsonObject,
  MemoryFile,
  Name,
  PackageFileSet,
  parseJson,
  readJsonFile,
  ResolutionContext,
  RunnableFileSet,
  SymlinkFile,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import { assembleNodeModules } from "./NodeModules";
import { compileCssSources, cssImportRewrites, partitionCssOutput } from "./CSSCompile";
import { type ExportsValue, resolveExports } from "@fabr-build/js-tools";

/** A parsed JS_TARGET ({@link parseJSTarget}). */
export interface JSTarget {
  /** The ES level, canonically spelled ({@link canonicalEsLevel}). */
  version: string;
  /** `dual`: ES modules and CommonJS both, which only a published package
   *  ships; elsewhere it reads as `esm` ({@link soleModuleFormat}). */
  module: "esm" | "commonjs" | "dual";
  environment: "node" | "browser";
}

/** A JS target with one module format, as every single compile is built for. */
export type PinnedJSTarget = JSTarget & { module: "esm" | "commonjs" };

/**
 * The extensions of a built JavaScript module and of the declaration beside
 * it. An ordinary source emits the plain pair, and a source that pins its own
 * module format (`.mts`, `.cts`) the matching pinned pair. A dual package's
 * ES-module files take the ESM pair; its CommonJS files keep the plain one.
 */
export const JS_EXTENSION = ".js";
export const TYPE_EXTENSION = ".d.ts";
export const ESM_JS_EXTENSION = ".mjs";
export const ESM_TYPE_EXTENSION = ".d.mts";
export const CJS_JS_EXTENSION = ".cjs";
export const CJS_TYPE_EXTENSION = ".d.cts";

/**
 * @return true if an emitted name is of the ES-module family (`.mjs`,
 * `.mjs.map`, `.d.mts`), otherwise false. A dual package takes these files from
 * its ES-module compile and every other file from its CommonJS compile
 * ({@link dualFormatOutputs}), so an `.mts` source's output comes from the
 * ES-module compile and a `.cts` source's from the CommonJS one.
 */
export function isEsmFormatOutput(name: string): boolean {
  return name.endsWith(ESM_JS_EXTENSION) || name.endsWith(`${ESM_JS_EXTENSION}.map`) || name.endsWith(ESM_TYPE_EXTENSION);
}

/** A file directly under `bin/`, as {@link binByConvention} claims bins. */
const BIN_ENTRY = /^bin\/[^/]+$/;

/** Strip a file's artifact suffix — the `.map` of a source map, then the
 *  module or declaration extension — so one module's JavaScript,
 *  declaration and map all answer the same stem. */
function artifactStem(name: string): string {
  const unmapped = name.endsWith(".map") ? name.slice(0, -".map".length) : name;
  const suffix = /\.d\.[cm]?ts$/.exec(unmapped) ?? /\.[cm]?js$/.exec(unmapped);
  return suffix === null ? unmapped : unmapped.slice(0, -suffix[0].length);
}

/**
 * Reduce the CommonJS and ES-module compiles of a dual package to the files it
 * ships, returned as [CommonJS part, ES-module part]: from the CommonJS compile
 * everything but the ES-module family, from the ES-module compile only that
 * family ({@link isEsmFormatOutput}).
 *
 * A bin ships in one format only: the ES-module compile's bin files are dropped
 * where the CommonJS part has a bin of the same stem, and kept where it has
 * none (a bin from an `.mts` source).
 */
export function dualFormatOutputs(commonjs: FileSet, esm: FileSet): FileSet[] {
  const primary = commonjs.remap(name => (isEsmFormatOutput(name) ? undefined : name));
  const claimed = new Set(
    [...primary]
      .map(([name]) => name)
      .filter(name => BIN_ENTRY.test(name))
      .map(artifactStem)
  );
  const secondary = esm.remap(name =>
    isEsmFormatOutput(name) && !(BIN_ENTRY.test(name) && claimed.has(artifactStem(name))) ? name : undefined
  );
  return [primary, secondary];
}

/** Get the one module format a target's module reads as where a single
 * artifact is produced (a runnable install, a bundle): `dual` reads as esm. */
export function soleModuleFormat(module: JSTarget["module"]): "esm" | "commonjs" {
  return module === "commonjs" ? "commonjs" : "esm";
}

/** ECMAScript version names (es5, es2018, esnext) accepted as a JS target's
 * version component. */
const ES_VERSION = /^es(next|\d+)$/;

/**
 * Spell an ES level canonically: `es6` (tsc's alias, and how JS.fabr's default
 * JS_TARGET is written) as `es2015`, so either spelling makes the same tsconfig.
 */
export function canonicalEsLevel(version: string): string {
  return version === "es6" ? "es2015" : version;
}

/**
 * Parse a JS target `<esversion>[-commonjs|-esm|-dual][-node|-browser]`
 * (`es2018-esm`, `es6-esm-browser`, `es2022-dual`), the module defaulting to
 * commonjs and the environment to node, the version canonically spelled.
 * Throws on a version that is no ES version, an unknown module or environment,
 * or extra components.
 */
export function parseJSTarget(target: string): JSTarget {
  const [version, module = "commonjs", environment = "node", ...rest] = target.split("-");
  if (rest.length > 0) {
    throw new FabrError(`Malformed JS target '${target}': expected '<esversion>[-commonjs|-esm|-dual][-node|-browser]'`);
  }
  if (!ES_VERSION.test(version)) {
    throw new FabrError(`Malformed JS target '${target}': '${version}' is not an ECMAScript version (es5, es2018, esnext)`);
  }
  if (module !== "commonjs" && module !== "esm" && module !== "dual") {
    throw new FabrError(`Malformed JS target '${target}': module must be 'commonjs', 'esm' or 'dual', not '${module}'`);
  }
  if (environment !== "node" && environment !== "browser") {
    throw new FabrError(`Malformed JS target '${target}': environment must be 'node' or 'browser', not '${environment}'`);
  }
  return { version: canonicalEsLevel(version), module, environment };
}

/** Write a JS target with all three components, as {@link parseJSTarget}
 * reads it back. */
export function formatJSTarget(target: JSTarget): string {
  return `${target.version}-${target.module}-${target.environment}`;
}

/**
 * Make a minimal `package.json` whose `type` matches `module`, so node loads an
 * install's `.js` files in that format: for the installs fabr stages to run
 * compiled output (a test install, a js_script). `extra` fields (a test
 * install's name) come first, and `type` overrides any of theirs. A caller with
 * a `dual` target reduces it with {@link soleModuleFormat} first.
 */
export function moduleTypeFile(module: "esm" | "commonjs", extra: Record<string, unknown> = {}): MemoryFile {
  return MemoryFile.from(JSON.stringify({ ...extra, type: module === "esm" ? "module" : "commonjs" }));
}

/** The conditions {@link hasPackageExport} resolves a subpath under: those of
 * every format and environment, so the answer does not depend on how the
 * package is imported. */
const PROBE_CONDITIONS = new Set(["types", "import", "require", "module-sync", "node", "browser"]);

/**
 * @return true if a package provides the given subpath (`./jsx-runtime`),
 * otherwise false: its `exports` map resolves the subpath to a file, and the
 * package holds that file (a wildcard such as `"./*": "./*"`, as markdown-it
 * has, maps every subpath). A package with no manifest,
 * no map, or an unreadable manifest or map provides none.
 */
export function hasPackageExport(pkg: PackageFileSet, subpath: string): Computable<boolean> {
  return (
    pkg
      .get("package.json")
      .then(manifest => (manifest === undefined ? false : publishedFile(pkg, manifest, subpath)))
      /* An unreadable manifest or invalid map answers false; it is reported
       * where the package is built or resolved. */
      .catch(() => false)
  );
}

/** @return true if `pkg`'s map publishes `subpath` and the package holds the
 * file that resolves to, otherwise false. */
function publishedFile(pkg: PackageFileSet, manifest: IFile, subpath: string): Computable<boolean> {
  return readJsonFile(manifest, toJsonObject).then(json => {
    /* `null` reads as no map at all (node falls back to `main`), so it exposes
     * nothing through this route either. */
    const exports = json.exports as ExportsValue | undefined;
    const target = exports === undefined || exports === null ? undefined : resolveExports(exports, subpath, PROBE_CONDITIONS);
    return target === undefined ? false : pkg.get(target.slice(2)).then(file => file !== undefined);
  });
}

/**
 * @return true if a dependency provides the JSX automatic runtime, otherwise
 * false: it publishes `./jsx-runtime` ({@link hasPackageExport}) and is not an
 * `@types/*` package.
 *
 * TODO: move to a declared capability in JS.fabr once the model can declare
 * capabilities.
 */
function providesJsxRuntime(pkg: PackageFileSet): Computable<boolean> {
  if (pkg.packageName.startsWith("@types/")) {
    return Computable.resolve(false);
  }
  return hasPackageExport(pkg, "./jsx-runtime");
}

/** Find the `jsxImportSource` for a TSX compile: the name of the one package
 * among `directDeps` that provides the JSX runtime. Rejects where none or
 * several do. */
export function resolveJsxImportSource(directDeps: FileSet[]): Computable<string> {
  const packages = directDeps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
  return Computable.forAll(
    packages.map(pkg => providesJsxRuntime(pkg).then(provides => (provides ? pkg.packageName : undefined))),
    (...found) => {
      const providers = found.filter((name): name is string => name !== undefined);
      if (providers.length === 0) {
        throw new FabrError("No JSX runtime specified in dependencies, and is needed to compile TSX files");
      }
      if (providers.length > 1) {
        throw new FabrError(`Multiple JSX runtimes in dependencies (${providers.join(", ")}); a target may depend on at most one`);
      }
      return providers[0];
    }
  );
}

/**
 * The `compilerOptions` each source-mode flag sets, by the flag's qualified
 * name ({@link Flag.name}); the flags are declared in JS.fabr, and a target
 * lists them in its `deps`. The compile is strict by default, and these
 * relax it or select a source dialect (CommonJS interop, legacy decorators).
 *
 * A flag is named for the option it sets, snake_cased: `no_` turns one off, a
 * bare name turns one on, and `allow_` turns off one of tsc's negative options
 * (`noImplicitAny`). The fragments are merged over the default options
 * ({@link resolveSourceMode}); a flag not listed here sets nothing.
 */
const SOURCE_MODE_OPTIONS: Record<string, Record<string, unknown>> = {
  "ts/no_strict": { strict: false },
  "ts/allow_implicit_any": { noImplicitAny: false },
  "ts/allow_implicit_this": { noImplicitThis: false },
  "ts/no_strict_null_checks": { strictNullChecks: false },
  "ts/no_strict_property_initialization": { strictPropertyInitialization: false },
  "ts/no_strict_function_types": { strictFunctionTypes: false },
  "ts/no_strict_bind_call_apply": { strictBindCallApply: false },
  "ts/no_use_unknown_in_catch_variables": { useUnknownInCatchVariables: false },
  "ts/no_es_module_interop": { esModuleInterop: false },
  /* Set only where the flag is present: a compiler before TypeScript 5.6 does
   * not know the option. */
  "ts/allow_unchecked_side_effect_imports": { noUncheckedSideEffectImports: false },
  /* Keep `useDefineForClassFields` off with legacy decorators: a property
   * decorator's accessor is on the prototype, and a class field defined on the
   * instance (es2022+ emit) would hide it. */
  "ts/experimental_decorators": { experimentalDecorators: true, useDefineForClassFields: false },
  /* tsc requires experimentalDecorators with this; the flag `provides` it (JS.fabr). */
  "ts/emit_decorator_metadata": { emitDecoratorMetadata: true },
};

/** @return the rank of an ES level, es5 < es2015 < … < esnext, `es6` ranking as
 * `es2015`; 0, the lowest, for a name that is no ES level. */
export function esLevelOrder(version: string): number {
  const level = canonicalEsLevel(version);
  const parsed = ES_VERSION.exec(level);
  if (!parsed) {
    return 0;
  }
  return parsed[1] === "next" ? Number.MAX_SAFE_INTEGER : Number(parsed[1]);
}

/**
 * @return true if the flags, with what they provide, include `dom`, otherwise
 * false. It decides both the `dom` lib in the compile and whether `fabr test`
 * runs the suite under jsdom; JS_TARGET's environment decides neither.
 */
export function usesDom(flags: Flag[]): boolean {
  return flagClosure(flags).some(flag => flag.name === "dom");
}

/**
 * @return how the packages the target's tests load are laid out: as a PnP
 * table where its flags (with what they provide) include `layout/pnp`, else as
 * a `node_modules` tree. Throws where they include both layout flags.
 */
export function layoutOf(flags: Flag[]): "pnp" | "node_modules" {
  const names = new Set(flagClosure(flags).map(flag => flag.name));
  if (names.has("layout/pnp") && names.has("layout/node_modules")) {
    throw new FabrError("A target can't be both layout/pnp and layout/node_modules");
  }
  return names.has("layout/pnp") ? "pnp" : "node_modules";
}

/**
 * @return true if the flags, with what they provide, include `js/node_globals`
 * (the sources use node's runtime globals), otherwise false. A browser bundle
 * binds those globals to the shim packages the target mounts.
 */
export function usesNodeGlobals(flags: Flag[]): boolean {
  return flagClosure(flags).some(flag => flag.name === "js/node_globals");
}

/**
 * Find the ES level a target's sources are written against: the highest of its
 * `es<level>` flags (`es2021`, `esnext`, …), with what they provide,
 * canonically spelled ({@link canonicalEsLevel}); undefined with none.
 */
export function resolveSourceVersion(flags: Flag[]): string | undefined {
  const highest = flagClosure(flags)
    .map(flag => flag.name)
    .filter(name => ES_VERSION.test(name))
    .reduce<string | undefined>(
      (best, name) => (best === undefined || esLevelOrder(name) > esLevelOrder(best) ? name : best),
      undefined
    );
  return highest === undefined ? undefined : canonicalEsLevel(highest);
}

/**
 * Merge the `compilerOptions` that the flags, with what they provide, set
 * ({@link SOURCE_MODE_OPTIONS}); a later flag wins a shared key. Empty where
 * none sets anything.
 */
export function resolveSourceMode(flags: Flag[]): Record<string, unknown> {
  return Object.assign({}, ...flagClosure(flags).map(flag => SOURCE_MODE_OPTIONS[flag.name]));
}

/**
 * Collect every flag the given ones reach through `provides`, each once, in
 * pre-order: a flag before what it provides, the given flags in their order.
 */
function flagClosure(flags: Flag[]): Flag[] {
  const seen = new Set<Flag>();
  const walk = (flag: Flag): Flag[] => {
    if (seen.has(flag)) {
      return [];
    }
    seen.add(flag);
    return [flag, ...flag.provides.flatMap(walk)];
  };
  return flags.flatMap(walk);
}

/**
 * @return true if the BUILD_TYPE emits source maps (`debug`, the default, and
 * `relwithdebinfo`), otherwise false. Read by the JavaScript and the
 * stylesheet compiles.
 */
export function emitsSourceMap(buildType: string | undefined): boolean {
  return buildType === "debug" || buildType === "relwithdebinfo";
}

/** The build step a source belongs to ({@link classifySourceByExt}). */
export type JsSourceKind = "ts" | "dts" | "js" | "jsx" | "css" | "json" | "copy";

/**
 * A declaration file name, as TypeScript defines one: `x.d.ts`, `x.d.mts`,
 * `x.d.cts`, and the arbitrary-extension form `x.d.<ext>.ts` (`logo.d.svg.ts`
 * declares what importing `logo.svg` yields).
 *
 * tsc-driver.ts has its own copy of this pattern; change the two together.
 */
export const DECLARATION_FILE = /\.d\.(?:[cm]?ts|[^./]+\.ts)$/;

/**
 * Classify a source file by the build step that consumes it, by extension
 * (case-insensitive):
 * - `ts` (`.ts`, `.tsx`, `.mts`, `.cts`), `js` (`.js`, `.mjs`, `.cjs`) and
 *   `jsx`: compiled by js_compile. Only `ts` and `jsx` require a compile
 *   ({@link requiresCompile}).
 * - `dts`: a declaration file ({@link DECLARATION_FILE}), a compile input that
 *   emits nothing and is also passed through.
 * - `css` (`.css`, `.scss`, `.sass`): the css pipeline.
 * - `json`: a compile input (js_compile sets `resolveJsonModule`) that is also
 *   passed through.
 * - `copy`: everything else, a resource no step consumes (templates, `.sh`,
 *   images).
 *
 * Map extensions to roles here only.
 */
export function classifySourceByExt(path: string): JsSourceKind {
  const lower = path.toLowerCase();
  const extidx = lower.lastIndexOf(".");
  if (extidx !== -1) {
    const ext = lower.substring(extidx + 1);
    switch (ext) {
      case "ts":
      case "mts":
      case "cts":
        if (DECLARATION_FILE.test(lower)) {
          return "dts";
        }
      /* fallthrough */
      case "tsx":
        return "ts";
      case "js":
      case "mjs":
      case "cjs":
        return "js";
      case "jsx":
        return "jsx";
      case "scss":
      case "sass":
      case "css":
        return "css";
      case "json":
        return "json";
    }
  }
  return "copy";
}

/** A source tree split by {@link classifySourceByExt}, one set per kind. */
export interface IJsSources {
  ts: FileSet;
  js: FileSet;
  dts: FileSet;
  jsx: FileSet;
  css: FileSet;
  json: FileSet;
  copy: FileSet;
}

/** Split a source tree by {@link classifySourceByExt}. */
export function classifySources(sources: FileSet): IJsSources {
  const groups = sources.partition(classifySourceByExt);
  return {
    ts: groups.ts ?? EMPTY_FILESET,
    js: groups.js ?? EMPTY_FILESET,
    dts: groups.dts ?? EMPTY_FILESET,
    jsx: groups.jsx ?? EMPTY_FILESET,
    css: groups.css ?? EMPTY_FILESET,
    json: groups.json ?? EMPTY_FILESET,
    copy: groups.copy ?? EMPTY_FILESET,
  };
}

/** Collect the sources js_compile takes: `ts`, `js`, `jsx`, `dts` and `json`. */
export function compileInputs(sources: IJsSources): FileSet {
  return FileSet.unionAll(sources.ts, sources.js, sources.jsx, sources.dts, sources.json);
}

/**
 * @return true if a tree has TypeScript or JSX, which only a compile can
 * handle, otherwise false. Plain JavaScript can be used as written
 * ({@link ICompileOptions.transpileJs}).
 */
export function requiresCompile(sources: IJsSources): boolean {
  return !sources.ts.isEmpty() || !sources.jsx.isEmpty();
}

/**
 * Collect the sources a build passes through unchanged: `copy`, `dts` and
 * `json`. The last two are compile inputs as well ({@link compileInputs}).
 */
export function passthroughFiles(sources: IJsSources): FileSet {
  return FileSet.unionAll(sources.copy, sources.dts, sources.json);
}

/**
 * Collect the resources among the given dependency sets: their `copy`, `json`
 * and `css` files, which a compile does not output, for a runnable install to
 * carry beside the compiled entry. Stylesheets are taken as written, not
 * compiled.
 */
export function resourceFiles(sets: FileSet[]): FileSet {
  return FileSet.unionAll(
    ...sets.map(set => {
      const classified = classifySources(set);
      return FileSet.unionAll(classified.copy, classified.json, classified.css);
    })
  );
}

/** The parts {@link compileContents} builds a source tree into. */
export interface ICompiledContents {
  /** The classified sources, with the css step's generated compile inputs
   * added. Says whether there were compilable sources, which an empty
   * `compiled` does not. */
  sources: IJsSources;
  /** The js_compile output, less the compiler's copies of plain JavaScript
   * where `transpileJs` is false; empty when there was nothing to compile. */
  compiled: FileSet;
  /** The css pipeline's stylesheets (compiled, scoped plain CSS); empty when
   * there were none. */
  css: FileSet;
  /** The sources passed through ({@link passthroughFiles}), plus the plain
   * JavaScript where `transpileJs` is false, less the files the compile output
   * and any declaration the css step generated, for the caller to place. */
  passthrough: FileSet;
  /** What js_compile was given as `srcs` ({@link compileSrcsOf}); empty when
   * nothing was compiled. For a caller that stages the sources beside the
   * output (a test install). */
  compileSrcs: FileSet;
  /** The `rewrite_imports` rules the compile ran under, each pairing a source
   * name with the built file that answers it: the caller's
   * {@link ICompileOptions.rewriteImports}, then the css pipeline's where there
   * were stylesheets. */
  rewrites: Name[];
  /** The part of {@link compiled} built from source deps rather than the
   * target's own sources ({@link depDerivedOutputs}). */
  depOutputs: FileSet;
}

/**
 * Drop the compiler's copy of each plain-JavaScript input, the emitted file of
 * the input's own name and its `.map`. A `.jsx` input's output has another
 * name, so it is kept.
 */
function withoutTranspiledJs(compiled: FileSet, js: FileSet): FileSet {
  const emitted = new Set([...js].map(([name]) => name));
  return compiled.remap(name => {
    const source = name.endsWith(".map") ? name.slice(0, -".map".length) : name;
    return emitted.has(source) ? undefined : name;
  });
}

/** Strip a compiled name's extension chain, so an output can be traced to the
 * source it came from: `x.js`, `x.d.ts` and `x.js.map` all stem to `x`, as does
 * the `x.ts` that produced them. */
function outputStem(name: string): string {
  return name.replace(/\.(d\.[cm]?ts|[cm]?[jt]sx?)(\.map)?$/i, "");
}

/**
 * Select the compiler's output for source deps ({@link sourceDepsOf}): each
 * output whose stem ({@link outputStem}) is a source dep's file's and none of
 * the target's own compile inputs'. A package leaves these out; a test install
 * keeps them to run.
 */
function depDerivedOutputs(compiled: FileSet, sources: IJsSources, directDeps: FileSet[]): FileSet {
  const own = new Set([...compileInputs(sources)].map(([name]) => outputStem(name)));
  const stems = new Set(
    sourceDepsOf(directDeps)
      .flatMap(set => [...set].map(([name]) => outputStem(name)))
      .filter(stem => !own.has(stem))
  );
  return stems.size === 0 ? EMPTY_FILESET : compiled.remap(name => (stems.has(outputStem(name)) ? name : undefined));
}

/** Options for {@link compileContents} and {@link compileJsSources}. */
export interface ICompileOptions {
  /** The package name the sources may import themselves by (js_compile's
   * `package_name`). */
  packageName?: string;
  /**
   * Whether {@link compileContents} outputs plain JavaScript compiled to
   * JS_TARGET (default true) or as written (false, for js_bundle, whose bundler
   * compiles it). Where false, a tree with no TypeScript or JSX is not
   * compiled at all, and one with them is compiled with its JavaScript as input,
   * the compiler's copies dropped and the files as written passed through.
   * {@link compileJsSources} ignores it.
   */
  transpileJs?: boolean;
  /** Constraints for the compile, over `BUILD_OVERRIDE` (such as the test
   * pipeline's JS_TARGET with its framework's module format). */
  constraints?: Constraints;
  /**
   * The extension the compile's `.js` output takes instead (`.mjs`, for a dual
   * package's ES-module compile; js_compile's `module_extension`). Pass it to
   * the compile rather than renaming its output: the emitted specifiers must
   * name the renamed files.
   */
  moduleExtension?: string;
  /**
   * What each imported non-JS resource is called in the output tree:
   * js_compile's `rewrite_imports`, as substituted names. {@link compileContents}
   * adds the css step's rules to these.
   */
  rewriteImports?: Name[];
  /**
   * The output files no step compiles: js_compile's `resources`. An import of
   * one resolves as an empty module. {@link compileContents} sets it to the css
   * step's stylesheets and the `copy` sources.
   */
  resources?: FileSet;
  /**
   * Declarations another compile emitted for some of the sources (js_compile's
   * `declarations`; a package's own, for its tests' compile). Those sources are
   * compiled against, and neither checked nor emitted.
   */
  declarations?: FileSet;
  /**
   * The compile sub-target's label (default "Compiling", or "Describing" where
   * `describe`). It is part of the sub-target's identity
   * ({@link BuildAction.targetKey}), so a compile under another label keeps an
   * incremental base of its own.
   */
  label?: string;
  /** Describe the compile instead of building it: the compile then yields its
   * description. */
  describe?: boolean;
}

/**
 * Add the css step's compile inputs (its `.js` and `.ts` outputs, the
 * css-module shims among them, classified) to a classification, every kind
 * but `css`.
 */
function withGeneratedSources(classified: IJsSources, added: IJsSources): IJsSources {
  return {
    ts: FileSet.unionAll(classified.ts, added.ts),
    js: FileSet.unionAll(classified.js, added.js),
    dts: FileSet.unionAll(classified.dts, added.dts),
    jsx: FileSet.unionAll(classified.jsx, added.jsx),
    css: classified.css,
    json: FileSet.unionAll(classified.json, added.json),
    copy: FileSet.unionAll(classified.copy, added.copy),
  };
}

/**
 * Build a source tree into its parts ({@link ICompiledContents}), for the
 * caller to place: classify the sources, compile the stylesheets with the css
 * pipeline (sass_compile, then css_postcss), then compile the code with
 * {@link compileJsSources}.
 *
 * The css step runs first, and the code compile takes its `.js` and `.ts`
 * outputs (the css-module shims) as sources, its import rewrites, and its stylesheets
 * as `resources` (by name only). The CSS itself does not reach the compile, so
 * a change to a stylesheet that keeps its class names leaves the compile's key
 * unchanged.
 *
 * `deps` are the compile's deps; the packages among them are also what the
 * stylesheets may load from. The code compile is skipped, `compiled` empty,
 * where there is nothing to compile, or where `transpileJs` is false and the
 * tree has no TypeScript or JSX.
 */
export function compileContents(
  context: TargetContext,
  sources: FileSet,
  deps: FileSet[],
  options: ICompileOptions = {}
): Computable<ICompiledContents> {
  const classified = classifySources(sources);
  const keepSourceJs = options.transpileJs === false;
  const css = compileCssSources(
    context,
    classified.css,
    deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet),
    options.packageName
  );
  return css.then(lowered => {
    /* The `.js` and `.ts` outputs go into the compile; the rest is output. */
    const { compileInputs, content } = partitionCssOutput(lowered);
    const generated = classifySources(compileInputs);
    const augmented = withGeneratedSources(classified, generated);
    const rewrites = [...(options.rewriteImports ?? []), ...(classified.css.isEmpty() ? [] : cssImportRewrites())];
    const compiled =
      keepSourceJs && !requiresCompile(augmented)
        ? undefined
        : compileJsSources(context, augmented, deps, {
            ...options,
            rewriteImports: rewrites,
            resources: FileSet.unionAll(content, augmented.copy),
          });
    return (compiled ?? Computable.resolve(EMPTY_FILESET)).then(built => {
      const emitted = keepSourceJs ? withoutTranspiledJs(built, augmented.js) : built;
      return {
        sources: augmented,
        compiled: emitted,
        css: content,
        rewrites,
        /* Subtract what the compile output: tsc copies each JSON an emitted
         * module imports into its output, and the same name from two files
         * would conflict. Subtract any declaration the css step generated,
         * which only this compile uses. */
        passthrough: (keepSourceJs ? FileSet.unionAll(passthroughFiles(augmented), augmented.js) : passthroughFiles(augmented))
          .minus(emitted)
          .minus(generated.dts),
        compileSrcs: compileSrcsOf(augmented, deps) ?? EMPTY_FILESET,
        depOutputs: depDerivedOutputs(emitted, augmented, deps),
      };
    });
  });
}

/**
 * Compile classified sources by building the `js_compile` sub-target, under
 * `BUILD_OVERRIDE` with `options.constraints` over it, and get its output (or,
 * with `options.describe`, its description). Returns undefined where there is
 * nothing to compile ({@link compileSrcsOf}).
 *
 * The sub-target's `srcs` are the compile inputs ({@link compileInputs}) and
 * the source deps; its `deps` are the packages and flags among `directDeps`
 * ({@link mountedDeps}). `directDeps` are the deps the sources may import by
 * name, resolved by the caller's collection point: a package only another
 * dependency requires is visible only to that dependency, so importing it
 * fails to compile. Plain JavaScript is compiled to JS_TARGET too, and a `.ts`
 * may import a local `.js`. The caller places what is not compiled
 * ({@link passthroughFiles}).
 */
export function compileJsSources(
  context: TargetContext,
  sources: IJsSources,
  directDeps: FileSet[],
  options: ICompileOptions = {}
): Computable<FileSet> | undefined {
  const srcs = compileSrcsOf(sources, directDeps);
  if (srcs === undefined) {
    return undefined;
  }
  const inputs: SubTargetInputs = {
    srcs,
    deps: mountedDeps(directDeps),
    ...(options.packageName ? { package_name: options.packageName } : {}),
    ...(options.moduleExtension ? { module_extension: options.moduleExtension } : {}),
    ...(options.rewriteImports?.length ? { rewrite_imports: options.rewriteImports } : {}),
    ...(options.resources !== undefined && !options.resources.isEmpty() ? { resources: options.resources } : {}),
    ...(options.declarations !== undefined && !options.declarations.isEmpty() ? { declarations: options.declarations } : {}),
  };
  const subTargetOptions = {
    label: options.label ?? (options.describe ? "Describing" : "Compiling"),
    constraints: BUILD_OVERRIDE.with(options.constraints),
  };
  return options.describe
    ? context.describeSubTarget("js_compile", inputs, subTargetOptions).then(described => described ?? EMPTY_FILESET)
    : context.subTarget("js_compile", inputs, subTargetOptions);
}

/** Select the deps that are plain source rather than a package or a flag:
 * compiled with the target's own sources, and never passed through. */
export function sourceDepsOf(directDeps: FileSet[]): FileSet[] {
  return directDeps.filter(dep => !(dep instanceof PackageFileSet) && !(dep instanceof Flag));
}

/**
 * Collect what js_compile is given as `srcs`: the compile inputs
 * ({@link compileInputs}) and the source deps. Undefined where there is no
 * TypeScript, JavaScript, JSX or source dep (declarations and JSON alone emit
 * nothing).
 */
export function compileSrcsOf(sources: IJsSources, directDeps: FileSet[]): FileSet | undefined {
  const sourceDeps = sourceDepsOf(directDeps);
  if (sources.ts.isEmpty() && sources.js.isEmpty() && sources.jsx.isEmpty() && sourceDeps.length === 0) {
    return undefined;
  }
  return FileSet.unionAll(compileInputs(sources), ...sourceDeps);
}

/**
 * Select the deps js_compile takes as `deps`: the packages, its dependency
 * table, and the source-mode flags, which it reads back with `getFlags`. Every
 * other dep is source ({@link sourceDepsOf}) and joins `srcs` instead, so a
 * `.ts` source dep's output is in the compiled tree (which a js_package
 * subtracts, {@link depDerivedOutputs}).
 */
function mountedDeps(directDeps: FileSet[]): FileSet[] {
  return directDeps.filter(dep => dep instanceof PackageFileSet || dep instanceof Flag);
}

/** Strip a file's final extension: `a/foo.test.ts` → `a/foo.test`. */
export function stripExtension(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

/** @return the files without a root `package.json`. */
export function stripPackageJson(files: FileSet): FileSet {
  return files.remap(name => (name === "package.json" ? undefined : name));
}

/**
 * @return the sources a target's compile is given: `sources` without the
 * `package.json` at their root, which seeds the generated manifest and is no
 * input of the compile. Throws where a `package.json` is below the root: a
 * target builds one package, so no other manifest is read.
 */
export function compileSourcesOf(sources: FileSet): FileSet {
  for (const [name] of sources) {
    if (name !== "package.json" && posix.basename(name) === "package.json") {
      throw new FabrError(`'${name}' is a package.json below the package's root`).withHelp(
        "a target builds one package, and only a package.json at its root is read, to seed the one fabr generates: remove this one from its sources"
      );
    }
  }
  return stripPackageJson(sources);
}

/**
 * Get the package's bins by convention, command → path: each file directly
 * under `bin/` except declarations and source maps, named by its file name less
 * the last extension (`bin/fabr.js` → `fabr`). A generated package.json's `bin`
 * is written from this. Throws a {@link ConflictError}, each side named by its
 * path, where two files claim one command (`bin/x.js` and `bin/x.sh`).
 */
export function binByConvention(contents: FileSet): Map<string, string> {
  const bin = new Map<string, string>();
  /* Sorted, so a conflict's sides do not depend on the set's order. */
  for (const filename of [...contents].map(([name]) => name).sort()) {
    const match = /^bin\/([^/]+)$/.exec(filename);
    if (match && !/\.d\.[cm]?ts$|\.map$/.test(match[1])) {
      const command = match[1].replace(/\.[^.]+$/, "");
      const existing = bin.get(command);
      if (existing !== undefined) {
        throw new ConflictError(
          "bin commands",
          command,
          { provenance: contents.origin, detail: existing },
          { provenance: contents.origin, detail: filename }
        );
      }
      bin.set(command, filename);
    }
  }
  return bin;
}

/** The interpreter line fabr supplies for a bin that lacks one. */
const NODE_SHEBANG = "#!/usr/bin/env node\n";

/**
 * Make the package's convention bins ({@link binByConvention}) launchable as
 * npm commands: prepend `#!/usr/bin/env node` to each that does not already
 * start with `#!`. An installed npm bin is run by the OS directly. The exec bit
 * is left to npm, which sets it on install.
 */
export function withBinShebangs(contents: FileSet): Computable<FileSet> {
  const files = new Map<string, IFile>(contents);
  const binPaths = [...new Set(binByConvention(contents).values())];
  if (binPaths.length === 0) {
    return Computable.resolve(contents);
  }
  return mapComputable(binPaths, path =>
    files
      .get(path)!
      .readString()
      .then(text => {
        if (!text.startsWith("#!")) {
          files.set(path, MemoryFile.from(NODE_SHEBANG + text));
        }
      })
  ).then(
    /* The names are unchanged, so the set stays canonical. */
    () => new FileSet(files, undefined, CANONICAL)
  );
}

/** The global naming the program a JS program is launched with: node. */
export const NODE_GLOBAL = "NODE";

/**
 * Make an npm package runnable under node (the `NODE` global): an install of
 * the package and its dependencies as `node_modules` ({@link assembleNodeModules}),
 * rooted at `node_modules/<name>`. Used for an `@npm:` package under `run`, a
 * `js_package[run]` and a js_script's package entry. The package's dependencies
 * must be materialized.
 *
 * The runnable's surface, which a projection selects its entry from, is a
 * `SymlinkFile` per package.json `bin` command, targeting the bin's install
 * path, then each of the package's files whose name no command has. With no
 * projection the entry is the sole bin, or a bin-less package's sole file.
 *
 * - `entry`: the package, or a {@link FileSetRef} over it whose pending
 *   projections select the entry from the surface (`@npm:typescript:5.4.5:tsc`
 *   selects the `tsc` bin). Rejects where they select nothing.
 * - `extras`: more for the install (js_script's `deps`). Packages among them
 *   join the `node_modules` tree, and must come from the entry's collection
 *   point; other sets are laid out at the install root.
 * - `args`: leading arguments the runnable always passes.
 *
 * Throws a TypeError where `entry` is not over a package, and rejects where
 * its `bin` is invalid ({@link binOf}).
 */
export function makeNpmRunnable(
  context: ResolutionContext,
  entry: PackageFileSet | FileSetRef,
  extras: FileSet[] = [],
  args: string[] = []
): Computable<RunnableFileSet> {
  const pkg = entry instanceof FileSetRef ? entry.source : entry;
  if (!(pkg instanceof PackageFileSet)) {
    throw new TypeError("cannot make a runnable of a non-package fileset");
  }
  return binOf(pkg)
    .then(bin => {
      const root = `node_modules/${pkg.packageName}`;
      const packages = extras.filter((extra): extra is PackageFileSet => extra instanceof PackageFileSet);
      const loose = extras.filter(extra => !(extra instanceof PackageFileSet));
      const install = FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules([pkg, ...packages]) }), ...loose);
      /* Bins first, so a bin wins its command name over a file of that name
       * (`fabr run pkg:tsc` is the bin), and a same-path tie at launch. */
      const surface = new Map<string, IFile>();
      for (const [command, binPath] of bin) {
        surface.set(command, new SymlinkFile(`${root}/${binPath}`));
      }
      for (const [name, file] of pkg) {
        if (!surface.has(name)) {
          surface.set(name, file);
        }
      }
      return context.launchedBy(new RunnableFileSet(install, args, undefined, root, new FileSet(surface)), NODE_GLOBAL);
    })
    .then(runnable => {
      if (!(entry instanceof FileSetRef)) {
        return runnable;
      }
      /* Select the entry now: a rule's result must be a FileSet, which a ref is not. */
      const selected = runnable.selectEntry(entry.projections);
      if (!selected) {
        throw new FabrError(`entry projection matched no bin or file of ${pkg.packageId} — nothing to launch`);
      }
      return Computable.resolve(selected);
    });
}

/**
 * Read one package.json `bin` entry as [command, path]. The command is the
 * key's basename, as npm takes it; the path is normalized (`./bin/tsc` →
 * `bin/tsc`), so it matches the file's install path. Throws where the command
 * is not a single canonical name or the path is not a string naming a
 * canonical path within the package ({@link isCanonicalFileName}); a path that
 * leaves the package is refused, never flattened.
 */
function binEntry(packageName: string, command: string, target: unknown): [string, string] {
  const cleanCommand = posix.basename(command);
  if (!isCanonicalFileName(cleanCommand)) {
    throw new FabrError(`Package '${packageName}' declares an invalid bin name ${JSON.stringify(command)}`);
  }
  const cleanTarget = typeof target === "string" ? posix.normalize(target) : undefined;
  if (cleanTarget === undefined || !isCanonicalFileName(cleanTarget)) {
    throw new FabrError(`Package '${packageName}' declares an invalid bin target ${JSON.stringify(target)} for '${cleanCommand}'`);
  }
  return [cleanCommand, cleanTarget];
}

/**
 * Read the package's `bin` from its package.json as a command → path map
 * ({@link binEntry}): a string `bin` is one command named by the package's
 * unscoped name, an object one per entry. Empty where there is no package.json
 * or no `bin`, or `bin` has any other shape, as npm reads it. Rejects where the
 * manifest is not JSON or an entry is invalid.
 */
export function binOf(pkg: PackageFileSet): Computable<Map<string, string>> {
  return pkg.get("package.json").then(file => {
    if (!file) {
      return new Map<string, string>();
    }
    return file.readString().then(text => {
      const { bin } = parseJson(text, `package.json of ${pkg.packageName}`, toJsonObject);
      if (typeof bin === "string") {
        return new Map([binEntry(pkg.packageName, pkg.packageName.replace(/^@[^/]+\//, ""), bin)]);
      }
      if (isJsonObject(bin)) {
        return new Map(Object.entries(bin).map(([command, path]) => binEntry(pkg.packageName, command, path)));
      }
      return new Map<string, string>();
    });
  });
}
