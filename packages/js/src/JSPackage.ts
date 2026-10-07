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
 * Shared JS-package helpers used across the js rules (not themselves rules):
 * JS target parsing and the TS-compile orchestration that builds the
 * `js_compile` sub-target.
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
  RunnableFileSet,
  SymlinkFile,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import { assembleNodeModules } from "./NodeModules";
import { compileCssSources, cssImportRewrites, partitionCssOutput } from "./CSSCompile";
import { type ExportsValue, resolveExports } from "./pnp/PackageExports";

export interface JSTarget {
  version: string;
  /** `dual` is esm PLUS a CommonJS compatibility fork, and only a published
   *  package has two formats to ship — see {@link soleModuleFormat}. */
  module: "esm" | "commonjs" | "dual";
  environment: "node" | "browser";
}

/** A target pinned to ONE module format — what any single emitted artifact is
 *  built from, `dual` having been resolved to a format by whoever pinned it. */
export type PinnedJSTarget = JSTarget & { module: "esm" | "commonjs" };

/**
 * The extensions a delivered JavaScript module carries — its own, and the
 * declaration beside it. An ordinary source emits the plain pair; a source that
 * pins its own module format (`.mts`, `.cts`) emits the matching pinned pair.
 *
 * The ESM pair doubles as what a dual package's ES-module format is renamed to.
 * The CommonJS format keeps the plain one, so it is byte-identical to a
 * single-format CommonJS build and the package's `type`, `main` and `types`
 * describe it without qualification; `.mjs`/`.d.mts` are self-describing, and
 * reachable only through the `exports` map, i.e. only by tooling new enough to
 * know them.
 */
export const JS_EXTENSION = ".js";
export const TYPE_EXTENSION = ".d.ts";
export const ESM_JS_EXTENSION = ".mjs";
export const ESM_TYPE_EXTENSION = ".d.mts";
export const CJS_JS_EXTENSION = ".cjs";
export const CJS_TYPE_EXTENSION = ".d.cts";

/**
 * Whether an emitted name belongs to the ES-module format — the `.mjs` family a
 * dual package takes from its ESM compile, and exactly what it must drop from
 * the CommonJS one.
 *
 * The two compiles see the same sources and so emit the same names twice over.
 * That partition resolves it, and resolves `.mts`/`.cts` with it: a source that
 * pinned its own format emits under that name from BOTH compiles, and this rule
 * keeps the copy from the compile whose module setting agrees with the pin — an
 * `.mts` from the ESM side, a `.cts` from the CommonJS side. Which is also the
 * only correct choice, since a file's relative specifiers were rewritten to name
 * the siblings of the format it was emitted in.
 */
export function isEsmFormatOutput(name: string): boolean {
  return name.endsWith(ESM_JS_EXTENSION) || name.endsWith(`${ESM_JS_EXTENSION}.map`) || name.endsWith(ESM_TYPE_EXTENSION);
}

/** A bin as {@link binByConvention} claims it: an executable directly under
 *  `bin/`, extension and all. */
const BIN_ENTRY = /^bin\/[^/]+$/;

/** A delivered file's name without its artifact suffix — the `.map` of a source
 *  map, then the module or declaration extension — so one module's JavaScript,
 *  declaration and map all answer the same stem. */
function artifactStem(name: string): string {
  const unmapped = name.endsWith(".map") ? name.slice(0, -".map".length) : name;
  const suffix = /\.d\.[cm]?ts$/.exec(unmapped) ?? /\.[cm]?js$/.exec(unmapped);
  return suffix === null ? unmapped : unmapped.slice(0, -suffix[0].length);
}

/**
 * The two compiles of a dual package reduced to the single tree it ships: each
 * format keeps only what it is the right producer of ({@link isEsmFormatOutput}).
 * The CommonJS format is thereby byte-identical to a single-format build, which is
 * what lets `type`, `main` and `types` describe it without qualification.
 *
 * A bin has no second format — it is the package as a PROGRAM, launched by node
 * and never imported, so there is no condition to select on. Where the CommonJS
 * format delivers one, the ES-module format's copy is dropped rather than shipped as
 * a dead file that would also collide for the command name (see
 * {@link binByConvention}). Where it does NOT — a bin compiled from an `.mts`
 * source has no CommonJS format at all — the ES-module copy is the only one there
 * is, and dropping it too would silently leave the package with no bin.
 */
export function dualFormatOutputs(commonjs: FileSet, esm: FileSet): FileSet[] {
  const primary = commonjs.remap(name => (isEsmFormatOutput(name) ? undefined : name));
  const claimed = new Set([...primary].map(([name]) => name).filter(name => BIN_ENTRY.test(name)).map(artifactStem));
  const secondary = esm.remap(name =>
    isEsmFormatOutput(name) && !(BIN_ENTRY.test(name) && claimed.has(artifactStem(name))) ? name : undefined
  );
  return [primary, secondary];
}

/** The one module format a target reads as wherever a single artifact is produced
 *  — a runnable install, a bundle — since only a published package can ship two.
 *  `dual` is esm with a CommonJS fork beside it, so alone it reads as esm. */
export function soleModuleFormat(module: JSTarget["module"]): "esm" | "commonjs" {
  return module === "commonjs" ? "commonjs" : "esm";
}

/** ECMAScript version names (es5, es2018, esnext) accepted as a JS target's
 * version component. */
const ES_VERSION = /^es(next|\d+)$/;

/**
 * The canonical spelling of an ES level. `es6` is tsc's alias for `es2015` (the
 * only edition-numbered one it still accepts) and is what fabr's own default
 * JS_TARGET is written as, so both spellings arrive in practice. Normalizing
 * where a written level enters the build keeps ONE of them in the tsconfig —
 * hence one cache entry and one compile — whichever was written.
 */
export function canonicalEsLevel(version: string): string {
  return version === "es6" ? "es2015" : version;
}

/**
 * Parse a JS target triple `<esversion>[-commonjs|-esm|-dual][-node|-browser]`
 * (e.g. `es2018-esm`, `es6-esm-browser`, `es2022-dual`). Malformed triples — an
 * unknown module or environment component, extra components, a non-ES version —
 * are rejected rather than silently mis-parsed to the defaults.
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

/** Render a JS target back to its written form, always in full (all three
 * components), so it round-trips through {@link parseJSTarget}. Used where one
 * component must be swapped and the rest preserved — the test compile swaps
 * in its framework's module format without disturbing the version or the
 * environment. */
export function formatJSTarget(target: JSTarget): string {
  return `${target.version}-${target.module}-${target.environment}`;
}

/**
 * A minimal `package.json` whose `type` matches the JS target's module system,
 * so node runs the install's emitted `.js` in the right mode (ESM by default,
 * per the `es6-esm` default target). `extra` fields (e.g. name/private for a
 * test install) are merged ahead of the computed `type`. Shared by every node
 * install fabr stages to run compiled output — the test runner and js_script.
 *
 * Takes a resolved format rather than a target's own module, so a caller holding a
 * `dual` target must reduce it ({@link soleModuleFormat}) — an install has one
 * `type` and cannot be both.
 */
export function moduleTypeFile(module: "esm" | "commonjs", extra: Record<string, unknown> = {}): MemoryFile {
  return MemoryFile.from(JSON.stringify({ ...extra, type: module === "esm" ? "module" : "commonjs" }));
}

/** The conditions a capability probe asks under. Not any one consumer's world:
 * the question is whether the package publishes the subpath at all, so the
 * answer should not turn on which of its formats the eventual importer sees. */
const PROBE_CONDITIONS = new Set(["types", "import", "require", "module-sync", "node", "browser"]);

/**
 * True iff a package PROVIDES the given subpath (`./jsx-runtime`): its `exports`
 * map publishes a name for it, AND the file that name lands on is really in the
 * package. The general "does this package expose subpath X" test that
 * subpath-shaped capability signals build on.
 *
 * Both halves are needed and the second is the load-bearing one. A catch-all
 * pattern is common — `"./*": "./*"` (markdown-it, the fortawesome icon packs) —
 * and it answers every subpath there could ever be, so a map read alone claims
 * the package provides a JSX runtime, and a JSON parser, and anything else one
 * cares to name. What a wildcard states is that a subpath maps SOMEWHERE, not
 * that anything is there.
 */
export function hasPackageExport(pkg: PackageFileSet, subpath: string): Computable<boolean> {
  return (
    pkg
      .get("package.json")
      .then(manifest => (manifest === undefined ? false : publishedFile(pkg, manifest, subpath)))
      /* An unreadable manifest exposes no subpath — this asks a question about a
       * dependency, and answers "no"; whoever *builds* that dependency reports it.
       * An invalid `exports` map is the same: reported where it is resolved. */
      .catch(() => false)
  );
}

/** Whether `pkg`'s map publishes `subpath` and the package holds the file that
 * resolves to. */
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
 * Whether a dependency provides the JSX automatic runtime: its `package.json`
 * publishes `./jsx-runtime` and the file that names is in the package. Not a
 * filename scan — a package may map the subpath to a differently-named file, so
 * the map says WHICH file and the package says whether it is there. `@types/*`
 * never qualifies: it carries the types, not the runtime `jsxImportSource`
 * points at.
 *
 * TODO: this recognizer is the seed of a general capability model — it should
 * move to a declared `capability jsxRuntime { … }` in JS.fabr once the model can
 * express (and rules enumerate) capabilities.
 */
function providesJsxRuntime(pkg: PackageFileSet): Computable<boolean> {
  if (pkg.packageName.startsWith("@types/")) {
    return Computable.resolve(false);
  }
  return hasPackageExport(pkg, "./jsx-runtime");
}

/** The `jsxImportSource` for a TSX compile: the first direct dep (in written
 * order) that provides the JSX runtime. Errors if none — TSX can't compile
 * without one — or if several (an ambiguous capability, like two `log4j`s). */
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
 * Source-interpretation (tsconfig) options a target opts into by listing a
 * source-mode `flag` in its `deps` (shipped in JS.fabr; see the vocabulary
 * there). The compile is strict by default — matching fabr's own code and
 * modern TS — so these flags name *deviations* from that baseline: relaxations
 * of the strict family, plus the source-dialect facts a target may be written
 * in — classic CJS interop (`import * as x` of a callable module, `export =`
 * consumers) and pre-TC39 decorators.
 *
 * A flag is named for the tsconfig option it sets, snake_cased: `no_` switches
 * one off, a bare name switches one on, and tsc's own negative options
 * (`noImplicitAny`, `noImplicitThis`) read `allow_` rather than double-negate.
 * It is recognized by its qualified target name
 * ({@link Flag.name}) and maps to a `compilerOptions` fragment merged after the
 * defaults (so `strict: false` overrides the default `strict: true`). A flag's
 * `provides` closure is walked too, so a composite flag expands to its members;
 * an unrecognized flag is ignored here (it may address a different rule).
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
  /* The compile checks side-effect imports wherever the compiler can; this
   * asks it not to. Written only when the flag is present, so a compiler
   * predating the option (TypeScript 5.6) never sees the name unless a target
   * asks for it by hand. */
  "ts/allow_unchecked_side_effect_imports": { noUncheckedSideEffectImports: false },
  /* Class fields ride along with the legacy decorators tsc still calls
   * experimental: a property decorator installs its accessor on the prototype,
   * and a real class field on the instance (what emit target es2022+ gives)
   * shadows it — so the decorator silently does nothing. Assignment semantics
   * keep it working. */
  "ts/experimental_decorators": { experimentalDecorators: true, useDefineForClassFields: false },
  /* tsc rejects this without experimentalDecorators, which the flag's own
   * `provides` supplies (JS.fabr). */
  "ts/emit_decorator_metadata": { emitDecoratorMetadata: true },
};

/** Ordering over ES level names — es5 < es2015 < … < esnext. Reads the level
 * as written, `es6` and `es2015` alike ({@link canonicalEsLevel}); an
 * unparseable name orders lowest, so it can never win a max. */
export function esLevelOrder(version: string): number {
  const level = canonicalEsLevel(version);
  const parsed = ES_VERSION.exec(level);
  if (!parsed) {
    return 0;
  }
  return parsed[1] === "next" ? Number.MAX_SAFE_INTEGER : Number(parsed[1]);
}

/**
 * Whether the sources declare that they use the DOM (the `dom` flag, walked
 * through `provides` like every other source-mode flag).
 *
 * A source fact, not read off JS_TARGET's environment: a tree that uses the
 * DOM needs it however it is emitted. It decides two things at once — the
 * `dom` lib in the compile, and whether `fabr test` runs the suite under jsdom
 * or plain node.
 */
export function usesDom(flags: Flag[]): boolean {
  return flagClosure(flags).some(flag => flag.name === "dom");
}

/**
 * Whether the sources use node's runtime globals (`js/node_globals`) — the same
 * kind of source fact as {@link usesDom}, and read the same way. What it means
 * is decided by the consumer: a browser bundle binds those identifiers to the
 * shim packages the target mounts, a node bundle does nothing, since node
 * supplies them.
 */
export function usesNodeGlobals(flags: Flag[]): boolean {
  return flagClosure(flags).some(flag => flag.name === "js/node_globals");
}

/**
 * The ES level a target's sources are written against, from its `es<level>`
 * deps flags (`es2021`, `esnext`, …), or undefined with none. The highest of
 * several wins, and the level comes back canonically spelled
 * ({@link canonicalEsLevel}), so `es6` and `es2015` yield the same tsconfig.
 */
export function resolveSourceVersion(flags: Flag[]): string | undefined {
  const highest = flagClosure(flags)
    .map(flag => flag.name)
    .filter(name => ES_VERSION.test(name))
    .reduce<string | undefined>((best, name) => (best === undefined || esLevelOrder(name) > esLevelOrder(best) ? name : best), undefined);
  return highest === undefined ? undefined : canonicalEsLevel(highest);
}

/**
 * Fold a set of source-mode flags (with their `provides` closures) into the
 * `compilerOptions` overlay they request. Later flags win on a shared key; an
 * empty result means the default (strict) tsconfig stands unchanged.
 */
export function resolveSourceMode(flags: Flag[]): Record<string, unknown> {
  return Object.assign({}, ...flagClosure(flags).map(flag => SOURCE_MODE_OPTIONS[flag.name]));
}

/**
 * Every flag the given ones reach through `provides`, each once, in pre-order
 * — a flag before what it provides, and the given flags in their own order — so
 * a reader folding them in sequence sees "later wins" as written.
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
 * BUILD_TYPEs that carry source maps: full debugging (`debug`) and
 * optimized-but-debuggable (`relwithdebinfo`); `release` strips them. The
 * default BUILD_TYPE is `debug` (STD.fabr), so a plain build is debuggable.
 * Shared by the JavaScript and the stylesheet compiles.
 */
export function emitsSourceMap(buildType: string | undefined): boolean {
  return buildType === "debug" || buildType === "relwithdebinfo";
}

/** The build step a source belongs to — see {@link classifySourceByExt}. */
export type JsSourceKind = "ts" | "dts" | "js" | "jsx" | "css" | "json" | "copy";

/**
 * TypeScript's own definition of a declaration filename: `x.d.ts` and the module
 * spellings, plus TS 5.0's arbitrary-extension form `x.d.<ext>.ts` — which is
 * how a hand-written asset declaration is spelled (`logo.d.svg.ts` declares what
 * importing `logo.svg` yields), so the narrower `\.d\.[cm]?ts$` would classify
 * one as an ordinary `.ts` and claim it emits `logo.d.svg.js`.
 *
 * The tsc driver carries its own copy of this (tsc-driver.ts) because it must
 * not import fabr's modules at runtime; the two are one rule and move together.
 */
export const DECLARATION_FILE = /\.d\.(?:[cm]?ts|[^./]+\.ts)$/;

/**
 * Classify a source file by which build step consumes it: `"ts"`/`"js"`/`"jsx"`
 * are compiled by js_compile (tsc emits `.js`/`.d.ts`), `"dts"` is a
 * hand-written declaration (a compile input that emits nothing), `"css"` is a
 * stylesheet handled by the css pipeline, and `"copy"` is everything no step
 * consumes — a runtime resource (`.json`, templates, `.sh`, images).
 *
 * A kind names the step rather than the extension, so it covers that step's
 * spellings: `ts` has `.tsx`/`.mts`, `js` has `.mjs`/`.cjs`, and `css` holds
 * plain `.css` alongside Sass — a plain stylesheet needs no lowering, but it
 * needs the same declaration and the same is-this-a-module judgment as any
 * other, and one step owning every stylesheet is what keeps those answers from
 * being given twice. `jsx` is split from `js` because only `ts` and `jsx`
 * *require* the compile ({@link requiresCompile}).
 *
 * The one place an extension maps to a role — don't test one elsewhere.
 */
export function classifySourceByExt(path: string): JsSourceKind {
  const lower = path.toLowerCase();
  const extidx = lower.lastIndexOf(".");
  if (extidx !== -1) {
    const ext = lower.substring(extidx + 1);
    switch (ext) {
      /* The module-flavoured spellings compile like their plain forms: tsc emits
       * `.mts`→`.mjs` and `.cts`→`.cjs`, and reads `.mjs`/`.cjs` under allowJs. */
      case "ts":
      case "mts":
      case "cts":
        /* A hand-written .d.ts is both a compile *input* (ambient types tsc
         * must see — e.g. the local picomatch shim) and a shipped *resource*
         * (e.g. the test runner's globals .d.ts, read back from the installed
         * package): it joins both the compile srcs and the copied output. */
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
      /* Like a .d.ts, a `.json` is a source in two roles: a runtime resource
       * that ships verbatim, AND a compile input, because js_compile sets
       * `resolveJsonModule` — under which `import cfg from "./x.json"` is
       * resolved against the real file and typed from its contents. Without it
       * the import cannot resolve at all, unless some ambient `declare module
       * "*.json"` is in scope, which silently replaces the document's real
       * shape with an empty one. */
      case "json":
        return "json";
    }
  }
  return "copy";
}

/**
 * A source tree bucketed by {@link classifySourceByExt}: one classification
 * pass, so each step is handed the bucket it consumes.
 */
export interface IJsSources {
  ts: FileSet;
  js: FileSet;
  dts: FileSet;
  jsx: FileSet;
  css: FileSet;
  json: FileSet;
  copy: FileSet;
}

/** Bucket a source tree by role — the single classification pass. */
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

/**
 * What js_compile takes: the compilable sources plus the hand-written
 * declarations, which are ambient inputs tsc must see (e.g. a local shim).
 */
export function compileInputs(sources: IJsSources): FileSet {
  return FileSet.unionAll(sources.ts, sources.js, sources.jsx, sources.dts, sources.json);
}

/**
 * Whether a tree *requires* the compile: TypeScript to check, or JSX to
 * transform. Plain JavaScript requires neither — a consumer with its own
 * downlevelling linker can take it as-is (see {@link ICompileOptions}).
 */
export function requiresCompile(sources: IJsSources): boolean {
  return !sources.ts.isEmpty() || !sources.jsx.isEmpty();
}

/**
 * What passes through a build untouched: the resources, plus the hand-written
 * declarations — a `.d.ts` is both a compile *input* (above) and a shipped
 * *resource* (e.g. the test runner's globals .d.ts, read back from the
 * installed package), so it is the one source in two buckets' worth of roles.
 */
export function passthroughFiles(sources: IJsSources): FileSet {
  return FileSet.unionAll(sources.copy, sources.dts, sources.json);
}

/**
 * The runtime *resources* among the given DEP sets — the files no build step
 * emits (`.json`, templates, images), which a compiled tree therefore drops. A
 * runnable install must carry them alongside the compiled entry; a package/test
 * build does not (see compileJsSources: source deps are compiled-against, not
 * shipped). Stylesheets count as resources here and are staged verbatim: these
 * are a *dependency's* files, not the target's own sources, so lowering them is
 * that dependency's business, not this target's.
 */
export function resourceFiles(sets: FileSet[]): FileSet {
  return FileSet.unionAll(
    ...sets.map(set => {
      const classified = classifySources(set);
      return FileSet.unionAll(classified.copy, classified.json, classified.css);
    })
  );
}

export interface ICompiledContents {
  /** The classification the parts came from, for what a part cannot answer on
   * its own — notably whether there were any compilable sources at all, which an
   * empty `compiled` does not distinguish from a compile that emitted nothing. */
  sources: IJsSources;
  /** The js_compile output; empty when there was nothing to compile. */
  compiled: FileSet;
  /** The css pipeline's output (lowered, scoped plain CSS); empty when there were no
   * stylesheets. */
  css: FileSet;
  /** The sources no step consumed, for the caller to place. */
  passthrough: FileSet;
  /** Exactly what js_compile was handed as its `src/` tree (empty when nothing
   * was compiled) — for a caller that mounts the output beside its sources so
   * source maps resolve. See {@link compileSrcsOf}. */
  compileSrcs: FileSet;
  /** The `rewrite_imports` rules this compile ran under — each pairs a source
   * specifier with the delivered file that answers it (the css pipeline's
   * stylesheet rules, or a caller's own {@link ICompileOptions.rewriteImports});
   * empty when none applied. The exports map replays them to name a declared
   * source's delivered counterpart. */
  rewrites: Name[];
  /** The part of {@link compiled} that came from a source DEP rather than from
   * this target's own sources. A package subtracts it (a dep is compiled
   * against, not distributed); a test install keeps it, needing the file on
   * disk to run. */
  depOutputs: FileSet;
}

/**
 * Drop the compiler's own copies of the plain-JavaScript inputs — the emitted
 * `x.js` and its `x.js.map` — leaving everything it genuinely produced. A `.jsx`
 * input is untouched by this: it emits under a *different* name (`.js`) and the
 * transform is the whole reason it was compiled.
 */
function withoutTranspiledJs(compiled: FileSet, js: FileSet): FileSet {
  const emitted = new Set([...js].map(([name]) => name));
  return compiled.remap(name => {
    const source = name.endsWith(".map") ? name.slice(0, -".map".length) : name;
    return emitted.has(source) ? undefined : name;
  });
}

/** A compiled name with its extension chain removed, so an output can be traced
 * to the source it came from: `x.js`, `x.d.ts` and `x.js.map` all stem to `x`,
 * as does the `x.ts` that produced them. */
function outputStem(name: string): string {
  return name.replace(/\.(d\.[cm]?ts|[cm]?[jt]sx?)(\.map)?$/i, "");
}

/**
 * Whatever the compiler emitted for a **source dep** — a `.ts` a target
 * compiles against but does not distribute, so its `.js`, its declaration and
 * their maps are that dep's artifacts and not this target's.
 *
 * Reported rather than subtracted, because the answer differs per consumer: a
 * package must not ship them, while a test install needs them on disk to run.
 * Matched by stem, the output names differing from the input's; a stem the
 * target's own sources also claim is left alone.
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

export interface ICompileOptions {
  /** The package name the sources may import themselves by (see js_compile's
   * `package_name`); a target with no package identity passes nothing. */
  packageName?: string;
  /**
   * Whether plain JavaScript is run through the compile. Default true, for a
   * consumer that DELIVERS an emitted tree (a package, a test install) and needs
   * its JavaScript downlevelled to JS_TARGET with everything else. js_bundle
   * sets false: esbuild downlevels JavaScript itself, and compiling it first
   * buys no checking (tsc does not check JavaScript) and rewrites the module
   * form of vendored code.
   *
   * It decides only whether JavaScript ALONE earns a compile. A tree holding
   * TypeScript or JSX compiles regardless ({@link requiresCompile}), its
   * JavaScript included — the compiler must see the `./util.js` a `.ts` imports
   * — but the compiler's copy is dropped again, so what ships is the file as
   * written.
   */
  transpileJs?: boolean;
  /**
   * Extra constraints for the compile, layered over the build override — the
   * test pipeline forces its framework's module format on JS_TARGET this
   * way. The
   * per-constraint target cache means the same sources coexist as (say)
   * ESM-for-bundling and CJS-for-tests with no further machinery.
   */
  constraints?: Constraints;
  /**
   * What this compile's `.js` output is named instead — `.mjs`, for the ES-module
   * format of a dual package, whose tree ships beside the CommonJS format's and would
   * otherwise collide with it name for name. It rides into the compile rather
   * than being applied to its output afterwards because the emitted specifiers
   * have to name the renamed siblings.
   */
  moduleExtension?: string;
  /**
   * What each imported non-JS resource is called in the output tree — js_compile's
   * `rewrite_imports` REWRITE, as already-substituted names. Set by {@link compileContents}
   * from the css step's outputs; a caller composing js_compile directly may state
   * its own.
   */
  rewriteImports?: Name[];
  /**
   * The delivered files no step compiles — js_compile's `resources`. An import
   * of one resolves as an empty module, so it needs no declaration beside it.
   * Set by {@link compileContents} from the css step's published stylesheets
   * and the sources nothing consumes.
   */
  resources?: FileSet;
  /**
   * The compile sub-target's display label (default "Compiling"). Also part of
   * the sub-target's identity — see {@link BuildAction.targetKey} — so the test
   * pipeline's distinct label keeps its incremental base apart from the package
   * build's.
   */
  label?: string;
}

/**
 * Fold the css step's compile inputs — the css-module shims and the stylesheet
 * declarations — into a classification, so everything downstream treats them as
 * the ordinary sources they are. The styled sources themselves are untouched:
 * they are the css step's input, not the compile's.
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
 * Build a source tree: classify it, run the steps its contents call for —
 * the css pipeline (sass_compile, then css_postcss) for the stylesheets, then
 * `js_compile` for the code — and return
 * the parts. `deps` serve both: the packages among them mount as the compile's
 * node_modules and double as the Sass loadPaths. The parts stay separate because
 * callers place them differently — a test install mounts the compiled tree and
 * the sources at different roots, a package unions the lot.
 *
 * **The css step comes first, and the compile consumes it.** A css-module's
 * class names only exist once Sass has evaluated the stylesheet and the scoper
 * has renamed them, and the compile has to know both the shape they make (to
 * typecheck `styles.cardTitle`) and what file to name in the stylesheet's place
 * (to emit something that resolves).
 *
 * What crosses the edge is the shims and the declarations, NOT the CSS: editing
 * a rule inside a class leaves the compile's action key unchanged, and only a
 * change to a file's exported NAME set rebuilds it.
 */
export function compileContents(
  context: TargetContext,
  sources: FileSet,
  deps: FileSet[],
  options: ICompileOptions = {}
): Computable<ICompiledContents> {
  const classified = classifySources(sources);
  /* The compile still runs for TypeScript/JSX; only the fate of the plain
   * JavaScript changes — it goes in as an input and comes back out untouched. */
  const keepSourceJs = options.transpileJs === false;
  const css = compileCssSources(
    context,
    classified.css,
    deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet),
    options.packageName
  );
  return css.then(lowered => {
    /* The step's output splits by role: the shims and declarations go INTO the
     * compile, the stylesheets come out of the build as content. */
    const { compileInputs, content } = partitionCssOutput(lowered);
    const generated = classifySources(compileInputs);
    const augmented = withGeneratedSources(classified, generated);
    /* The caller's rules, plus the css pipeline's where there ARE stylesheets —
     * which say which declaration shape stands in for which runtime file. */
    const rewrites = [...(options.rewriteImports ?? []), ...(classified.css.isEmpty() ? [] : cssImportRewrites())];
    const compiled =
      keepSourceJs && !requiresCompile(augmented)
        ? undefined
        : compileJsSources(context, augmented, deps, {
            ...options,
            rewriteImports: rewrites,
            /* What the target delivers but no step compiles: the published
             * stylesheets, and the sources nothing consumes (images, fonts,
             * templates). An import of any of them resolves as an empty
             * module. */
            resources: FileSet.unionAll(content, augmented.copy),
          });
    return (compiled ?? Computable.resolve(EMPTY_FILESET)).then(built => {
      /* What the compile actually delivers — `built` minus the JavaScript held
       * back under keepSourceJs, which the original is delivered in place of. */
      const emitted = keepSourceJs ? withoutTranspiledJs(built, augmented.js) : built;
      return {
        sources: augmented,
        compiled: emitted,
        css: content,
        rewrites,
        /* The JavaScript the compiler didn't deliver is delivered here instead, so
         * the caller receives what it put in either way. JSON is subtracted for the
         * opposite reason: it is a compile input (resolveJsonModule), and tsc COPIES
         * every JSON an emitted module imports into outDir — so shipping it here as
         * well would be the same name from two different files, i.e. a conflict. A
         * JSON nothing imports is not emitted, and does still ship from here. */
        /* The css step's declarations are subtracted: they type the stylesheets
         * for this compile's own benefit — the shim's side-effect import of the
         * stylesheet it belongs to — and a consuming package resolves neither.
         * `passthroughFiles` ships declarations because a HAND-WRITTEN one is
         * part of a package's surface; a generated one is scaffolding. */
        passthrough: (keepSourceJs
          ? FileSet.unionAll(passthroughFiles(augmented), augmented.js)
          : passthroughFiles(augmented)
        )
          .minus(emitted)
          .minus(generated.dts),
        compileSrcs: compileSrcsOf(augmented, deps) ?? EMPTY_FILESET,
        depOutputs: depDerivedOutputs(emitted, augmented, deps),
      };
    });
  });
}

/**
 * Compile a JS/TS source tree by building the `js_compile` sub-target — the
 * single TS compile path shared by the package build and the test run. Takes
 * the already-classified sources and consumes only the buckets it compiles
 * ({@link compileInputs}); what it does not compile is the caller's to place
 * (see {@link passthroughFiles}). Returns the sub-target's cached output, or
 * undefined when there is nothing to compile. `directDeps` are the deps the
 * sources may import directly (the package's own deps — `@types/node` among them
 * where the sources use Node APIs — plus test_deps / runner globals for a test
 * compile), resolved jointly by the caller's collection point. They are what
 * the sources may NAME: js_compile writes them as a dependency manifest in
 * which the sources' own row lists exactly these, while the transitive closure
 * is reachable only from the rows of the deps that declared it — so a source
 * importing an undeclared transitive dep fails to compile. The compiler
 * (`TSC_DRIVER`) is resolved inside js_compile. The
 * sub-target builds under BUILD_OPERATION=build (a compile is a build even for a
 * test target). Plain .js/.jsx sources go through the same compile (tsc allowJs),
 * so they are downleveled to JS_TARGET and a .ts may import a local .js.
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
  /* Both .ts(x) and .js(x) go through js_compile: with allowJs, tsc downlevels
   * the JS to JS_TARGET and lets a .ts import a local .js. .d.ts joins as an
   * ambient input (the caller also passes it through as a resource). js_compile
   * owns how the deps reach the compiler (the dependency manifest) and the
   * JSX-runtime detection; the compiler is added by js_compile itself. */
  const inputs: SubTargetInputs = {
    srcs,
    deps: mountedDeps(directDeps),
    ...(options.packageName ? { package_name: options.packageName } : {}),
    ...(options.moduleExtension ? { module_extension: options.moduleExtension } : {}),
    ...(options.rewriteImports?.length ? { rewrite_imports: options.rewriteImports } : {}),
    ...(options.resources !== undefined && !options.resources.isEmpty() ? { resources: options.resources } : {}),
  };
  return context.subTarget("js_compile", inputs, {
    label: options.label ?? "Compiling",
    constraints: BUILD_OVERRIDE.with(options.constraints),
  });
}

/** The deps that are plain SOURCE rather than a package or a flag: compiled
 * against as siblings of the target's own sources, never distributed by it. */
export function sourceDepsOf(directDeps: FileSet[]): FileSet[] {
  return directDeps.filter(dep => !(dep instanceof PackageFileSet) && !(dep instanceof Flag));
}

/**
 * Exactly what js_compile is handed as its `src/` tree, or undefined when there
 * is nothing to compile (no TypeScript, no JSX, no plain JavaScript, and no
 * source dep to compile against — a tree of declarations alone emits nothing,
 * so it does not earn a sub-target).
 *
 * Exposed because a consumer that mounts the compiled output BESIDE its sources
 * — the test install, so each `.js.map` resolves — needs the same set, not a
 * re-derived approximation of it.
 */
export function compileSrcsOf(sources: IJsSources, directDeps: FileSet[]): FileSet | undefined {
  const sourceDeps = sourceDepsOf(directDeps);
  if (sources.ts.isEmpty() && sources.js.isEmpty() && sources.jsx.isEmpty() && sourceDeps.length === 0) {
    return undefined;
  }
  return FileSet.unionAll(compileInputs(sources), ...sourceDeps);
}

/* Deps split by kind. A built package mounts as node_modules, and a source-mode
 * `Flag` rides alongside it — both are `deps` to js_compile (a Flag is an empty
 * FileSet, so it mounts nothing; js_compile reads it back with getFlags("deps")
 * to fold its tsconfig overlay). A *non-package* content dep is plain source the
 * target needs but does not distribute — a `.d.ts` type shim, or test support
 * like a harness. It joins the compile inputs (tsc sees it, and a relative `./x`
 * import resolves to it as a sibling) but never the passthrough, so it's compiled-
 * against yet not shipped: a `.d.ts` emits nothing; a `.ts`'s output rides the
 * compiled tree (into a js_test run install; a js_package would vendor it — use a
 * package to avoid that). */
function mountedDeps(directDeps: FileSet[]): FileSet[] {
  return directDeps.filter(dep => dep instanceof PackageFileSet || dep instanceof Flag);
}

/** @return the files without any root package.json (consumed, not copied through) */
export function stripPackageJson(files: FileSet): FileSet {
  return files.remap(name => (name === "package.json" ? undefined : name));
}

/**
 * Bin by convention: every file directly under bin/ is a command named after it
 * (its extension stripped) — `bin/fabr.js` → `{ fabr: "bin/fabr.js" }`. Anything
 * executable qualifies (a compiled .js, but equally a bundled shell script);
 * only the emitted .d.ts / .map siblings are skipped. Used to write the generated
 * package.json bin (js_package[build]); running reads that field back via
 * makeNpmRunnable, so a fabr-built package and an external npm one launch the
 * same way.
 *
 * Two bins sharing a stem (`bin/x.js` and `bin/x.sh`) both claim the command
 * `x`, which the convention cannot decide: a {@link ConflictError}, not a pick.
 * It takes the whole FileSet rather than its names so that conflict carries the
 * set's provenance; each side is identified by its path *within* the package,
 * which is what distinguishes the two claimants (their display names would not —
 * a generated bin has none).
 */
export function binByConvention(contents: FileSet): Map<string, string> {
  const bin = new Map<string, string>();
  /* Sorted, so which of a colliding pair is the conflict's left side doesn't
   * depend on the set's iteration order. */
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
 * Make the package's convention bins launchable as npm commands. An installed
 * npm bin is symlinked and exec'd by the OS directly, so it must open with a
 * `#!` interpreter line: any bin whose bytes don't already start with `#!` (a
 * bundled shell script carries its own) gets `#!/usr/bin/env node` prepended
 * here. Fabr itself launches via the runnable descriptor, never the shebang,
 * so self-hosting does not catch a missing one. The exec bit tsc drops — and
 * which fabr can't yet stamp without per-entry mode in the manifest — npm
 * restores on install.
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
        /* A bundled shell script carries its own `#!`; only a bare bin needs ours. */
        if (!text.startsWith("#!")) {
          files.set(path, MemoryFile.from(NODE_SHEBANG + text));
        }
      })
  ).then(
    /* Names are unchanged — only the shebang'd bins' identities differ. */
    () => new FileSet(files, undefined, CANONICAL)
  );
}

/**
 * Make a resolved package runnable: mount the package and its resolved
 * dependency closure as node_modules, and launch a bin under node. The runnable's
 * launch **surface** is the package's own files (findable by path) unioned with a
 * `SymlinkFile` per package.json `bin` (findable by command, targeting the bin's
 * install path — bins added first, so a bin wins its command name and a same-path
 * tie over a like-named file); a projection
 * is `surface.find`. The default entry (no projection) is the sole bin, or a
 * bin-less package's sole file; anything else needs a projection. This is the
 * single "npm package → runnable" path — shared by an external `@npm:…` consumed
 * under `run` (via NPMRepository), a declared `js_package[run]` (over its own
 * generated package.json bin), and js_script's package-mode entry. The package's
 * dependencies must already be resolved (PackageFileSets, not inert refs) — its
 * collection point is responsible for that.
 *
 * `extras` decorate the install beyond the package's own closure (js_script's
 * `deps` — the additional environment a packaged tool needs, e.g. a framework's
 * integrations): packages join the node_modules assembly (they must share the
 * entry package's collection point, so the whole install is one joint pin);
 * loose filesets land at their own paths at the install root. `args` are fixed
 * leading arguments carried by the runnable.
 *
 * The entry may be a projection-pending {@link FileSetRef} over a package
 * (`entry = @npm:typescript:5.4.5:tsc`): the pending projections select the
 * RUNNABLE's entry — a REINTERPRETATION, replayed as a raw `find` fold over
 * the runnable's surface (bin by command or file by path, the written form's
 * `fabr run` meaning), not the resolver's namespace walk.
 */
export function makeNpmRunnable(
  entry: PackageFileSet | FileSetRef,
  extras: FileSet[] = [],
  args: string[] = []
): Computable<RunnableFileSet> {
  const pkg = entry instanceof FileSetRef ? entry.source : entry;
  if (!(pkg instanceof PackageFileSet)) {
    throw new TypeError("cannot make a runnable of a non-package fileset");
  }
  return binOf(pkg).then(bin => {
    const root = `node_modules/${pkg.packageName}`;
    const packages = extras.filter((extra): extra is PackageFileSet => extra instanceof PackageFileSet);
    const loose = extras.filter(extra => !(extra instanceof PackageFileSet));
    const install = FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules([pkg, ...packages]) }), ...loose);
    /* Bins first: a declared bin takes precedence over a package file — it wins
     * its command *name* (a file sharing it is still in the install, just not the
     * surface entry for it) and, being earlier, wins a same-*path* dedup at launch.
     * So `fabr run pkg:tsc` is always the declared bin, never a stray file. */
    const surface = new Map<string, IFile>();
    for (const [command, binPath] of bin) {
      surface.set(command, new SymlinkFile(`${root}/${binPath}`));
    }
    for (const [name, file] of pkg) {
      if (!surface.has(name)) {
        surface.set(name, file);
      }
    }
    const runnable = new RunnableFileSet(install, args, "node", root, new FileSet(surface));
    if (!(entry instanceof FileSetRef)) {
      return Computable.resolve(runnable);
    }
    /* Apply the pending projections as bin selection — the REINTERPRETATION the
     * pending ref exists for, not the namespace walk. Resolved here rather than
     * re-deferred over the runnable because this is a rule RESULT: it must be a
     * FileSet, which a ref is not. */
    const selected = runnable.selectEntry(entry.projections);
    if (!selected) {
      throw new FabrError(`entry projection matched no bin or file of ${pkg.packageId} — nothing to launch`);
    }
    return Computable.resolve(selected);
  });
}

/**
 * Normalize + validate one package.json bin entry, untrusted content from an
 * arbitrary package — both halves judged by the general canonical-name rule
 * (see canonicalFileName). The command follows npm's rule — only the
 * **basename** of the key is used — and must be a canonical single name. The
 * target is normalized (typescript declares `"./bin/tsc"`, whose leading `./`
 * would otherwise survive into the SymlinkFile target and defeat the
 * same-install-path dedup `makeNpmRunnable`/`toCommandLine` rely on) and must
 * *already* be canonical: a target an escape would flatten is an **error**,
 * never repaired — flattening would silently re-point the bin at a different
 * in-package path, and it must stay inside the package (npm's bin-links
 * enforces the same) since it becomes a symlink target within the mounted
 * closure.
 */
function binEntry(packageName: string, command: string, target: unknown): [string, string] {
  const cleanCommand = posix.basename(command);
  if (!isCanonicalFileName(cleanCommand)) {
    throw new FabrError(`Package '${packageName}' declares an invalid bin name ${JSON.stringify(command)}`);
  }
  /* The target is whatever JSON the package published: a non-string one is as
   * invalid as an out-of-package path and reports the same way, rather than as
   * a TypeError out of the path normalizer. */
  const cleanTarget = typeof target === "string" ? posix.normalize(target) : undefined;
  if (cleanTarget === undefined || !isCanonicalFileName(cleanTarget)) {
    throw new FabrError(`Package '${packageName}' declares an invalid bin target ${JSON.stringify(target)} for '${cleanCommand}'`);
  }
  return [cleanCommand, cleanTarget];
}

/**
 * The package's `bin` as a command→path map, read from its package.json (npm
 * allows `bin` to be a bare string — the command is the package's unscoped
 * name — or an object); no package.json, no `bin`, or a `bin` of any other
 * shape (npm normalizes those away too) yields an empty map — not runnable.
 * Entries are normalized/validated via {@link binEntry}. Shared by
 * makeNpmRunnable (the bin surface) and js_script's package-mode entry (the
 * package's declared bin is the entry).
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
