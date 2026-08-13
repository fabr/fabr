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
 * JS target parsing, node_modules assembly, and the TS-compile orchestration
 * that builds the `js_compile` sub-target.
 */

import { posix } from "path";
import {
  attachHelp,
  BUILD_OVERRIDE,
  Constraints,
  SubTargetInputs,
  CANONICAL,
  Computable,
  compareVersions,
  ConflictError,
  EMPTY_FILESET,
  FileSet,
  FileSetRef,
  Flag,
  IFile,
  isCanonicalFileName,
  isJsonObject,
  MemoryFile,
  PackageFileSet,
  parseJson,
  parseVersion,
  readJsonFile,
  RunnableFileSet,
  SymlinkFile,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import { compileCssSources } from "./CSSCompile";

export interface JSTarget {
  version: string;
  module: "esm" | "commonjs";
  environment: "node" | "browser";
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
 * Parse a JS target triple `<esversion>[-commonjs|-esm][-node|-browser]`
 * (e.g. `es2018-esm`, `es6-esm-browser`). Malformed triples — an unknown module
 * or environment component, extra components, a non-ES version — are rejected
 * rather than silently mis-parsed to the defaults.
 */
export function parseJSTarget(target: string): JSTarget {
  const [version, module = "commonjs", environment = "node", ...rest] = target.split("-");
  if (rest.length > 0) {
    throw new Error(`Malformed JS target '${target}': expected '<esversion>[-commonjs|-esm][-node|-browser]'`);
  }
  if (!ES_VERSION.test(version)) {
    throw new Error(`Malformed JS target '${target}': '${version}' is not an ECMAScript version (es5, es2018, esnext)`);
  }
  if (module !== "commonjs" && module !== "esm") {
    throw new Error(`Malformed JS target '${target}': module must be 'commonjs' or 'esm', not '${module}'`);
  }
  if (environment !== "node" && environment !== "browser") {
    throw new Error(`Malformed JS target '${target}': environment must be 'node' or 'browser', not '${environment}'`);
  }
  return { version: canonicalEsLevel(version), module, environment };
}

/** Render a JS target back to its written form, always in full (all three
 * components), so it round-trips through {@link parseJSTarget}. Used where one
 * component must be swapped and the rest preserved — the test compile forces
 * `commonjs` without disturbing the version or the environment. */
export function formatJSTarget(target: JSTarget): string {
  return `${target.version}-${target.module}-${target.environment}`;
}

/**
 * A minimal `package.json` whose `type` matches the JS target's module system,
 * so node runs the install's emitted `.js` in the right mode (ESM by default,
 * per the `es6-esm` default target). `extra` fields (e.g. name/private for a
 * test install) are merged ahead of the computed `type`. Shared by every node
 * install fabr stages to run compiled output — the test runner and js_script.
 */
export function moduleTypeFile(module: JSTarget["module"], extra: Record<string, unknown> = {}): MemoryFile {
  return MemoryFile.from(JSON.stringify({ ...extra, type: module === "esm" ? "module" : "commonjs" }));
}

/** True iff a package's `package.json` declares the given `subpath` in its
 * `exports` map (e.g. `./jsx-runtime`). The general "does this package expose
 * subpath X" test that subpath-shaped capability signals build on. */
export function hasPackageExport(manifest: IFile, subpath: string): Computable<boolean> {
  return (
    readJsonFile(manifest, toJsonObject)
      /* Own keys, not `in`: a subpath must be declared by the package, not
       * inherited from Object.prototype. (Object.hasOwn needs a newer lib than
       * the JS_TARGET fabr builds itself under.) */
      .then(json => isJsonObject(json.exports) && Object.keys(json.exports).includes(subpath))
      /* An unreadable manifest exposes no subpath — this asks a question about a
       * dependency, and answers "no"; whoever *builds* that dependency reports it. */
      .catch(() => false)
  );
}

/**
 * Whether a dependency provides the JSX automatic runtime, read from its
 * `package.json` `exports` (NOT a filename scan — a package may map the subpath
 * to a differently-named file). `@types/*` never qualifies: it carries the
 * types, not the runtime `jsxImportSource` points at.
 *
 * TODO: this recognizer is the seed of a general capability model — it should
 * move to a declared `capability jsxRuntime { … }` in JS.fabr once the model can
 * express (and rules enumerate) capabilities.
 */
function providesJsxRuntime(pkg: PackageFileSet): Computable<boolean> {
  if (pkg.packageName.startsWith("@types/")) {
    return Computable.resolve(false);
  }
  return pkg.get("package.json").then(file => (file ? hasPackageExport(file, "./jsx-runtime") : false));
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
        throw new Error("No JSX runtime specified in dependencies, and is needed to compile TSX files");
      }
      if (providers.length > 1) {
        throw new Error(`Multiple JSX runtimes in dependencies (${providers.join(", ")}); a target may depend on at most one`);
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
 * The ES level a target's sources are written against, from its `es<level>`
 * deps flags (`es2021`, `esnext`, etc). Determines the lib version and
 * other flags as appropriate.
 *
 * If a target carries multiple source version flags, we use the highest. The
 * level comes back canonically spelled ({@link canonicalEsLevel}), so `es6` and
 * `es2015` yield the same tsconfig.
 */
/**
 * Whether the sources declare that they use the DOM (the `dom` flag, walked
 * through `provides` like every other source-mode flag).
 *
 * A source fact, deliberately not read off JS_TARGET's environment: what a tree
 * USES is invariant across every build of it, while what it is EMITTED for
 * varies per consumer. It decides two things at once — the `dom` lib in the
 * compile, and whether `fabr test` runs the suite under jsdom or plain node.
 */
export function usesDom(flags: Flag[]): boolean {
  const seen = new Set<Flag>();
  const walk = (flag: Flag): boolean => {
    if (seen.has(flag)) {
      return false;
    }
    seen.add(flag);
    return flag.name === "dom" || flag.provides.some(walk);
  };
  return flags.some(walk);
}

export function resolveSourceVersion(flags: Flag[]): string | undefined {
  let highest: string | undefined;
  const seen = new Set<Flag>();
  const walk = (flag: Flag): void => {
    if (seen.has(flag)) {
      return;
    }
    seen.add(flag);
    if (ES_VERSION.test(flag.name) && (highest === undefined || esLevelOrder(flag.name) > esLevelOrder(highest))) {
      highest = flag.name;
    }
    flag.provides.forEach(walk);
  };
  flags.forEach(walk);
  return highest === undefined ? undefined : canonicalEsLevel(highest);
}

/**
 * Fold a set of source-mode flags (with their `provides` closures) into the
 * `compilerOptions` overlay they request. Later flags win on a shared key; an
 * empty result means the default (strict) tsconfig stands unchanged.
 */
export function resolveSourceMode(flags: Flag[]): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  const seen = new Set<Flag>();
  const walk = (flag: Flag): void => {
    if (seen.has(flag)) {
      return;
    }
    seen.add(flag);
    Object.assign(overlay, SOURCE_MODE_OPTIONS[flag.name]);
    flag.provides.forEach(walk);
  };
  flags.forEach(walk);
  return overlay;
}

/** The build step a source belongs to — see {@link classifySourceByExt}. */
export type JsSourceKind = "ts" | "dts" | "js" | "jsx" | "css" | "json" | "copy";

/**
 * Classify a source file by which build step consumes it: `"ts"`/`"js"`/`"jsx"`
 * are compiled by js_compile (tsc emits `.js`/`.d.ts`), `"dts"` is a
 * hand-written declaration (a compile input that emits nothing), `"css"` is a
 * Sass source lowered by css_compile, and `"copy"` is everything no step
 * consumes — a runtime resource (`.json`, templates, `.sh`, assets).
 *
 * A kind names the step rather than the extension, so it covers that step's
 * spellings: `ts` has `.tsx`/`.mts`, `js` has `.mjs`/`.cjs`. Two to watch: `css`
 * does NOT hold `.css` (a plain stylesheet needs no lowering, so it is a `copy`
 * resource), and `jsx` is split from `js` because only `ts` and `jsx` *require*
 * the compile ({@link requiresCompile}).
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
        if (/\.d\.[cm]?ts$/.test(lower)) {
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
        return "css";
      /* Like a .d.ts, a `.json` is a source in two roles: a runtime resource
       * that ships verbatim, AND a compile input, because js_compile sets
       * `resolveJsonModule` — under which `import cfg from "./x.json"` is
       * resolved against the real file and typed from its contents. Withholding
       * it left that option inert: the import could not resolve at all unless
       * some ambient `declare module "*.json"` happened to be in scope, which
       * silently replaces the document's real shape with an empty one. */
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
 * emits (`.json`, templates, assets), which a compiled tree therefore drops. A
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
  /** The css_compile output (lowered plain CSS); empty when there were no
   * stylesheets. */
  css: FileSet;
  /** The sources no step consumed, for the caller to place. */
  passthrough: FileSet;
  /** Exactly what js_compile was handed as its `src/` tree (empty when nothing
   * was compiled) — for a caller that mounts the output beside its sources so
   * source maps resolve. See {@link compileSrcsOf}. */
  compileSrcs: FileSet;
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
   * test pipeline forces a commonjs-emitting JS_TARGET this way. The
   * per-constraint target cache means the same sources coexist as (say)
   * ESM-for-bundling and CJS-for-tests with no further machinery.
   */
  constraints?: Constraints;
}

/**
 * Build a source tree: classify it, run the steps its contents call for —
 * `js_compile` for the code, `css_compile` for the stylesheets — and return the
 * parts. `deps` serve both: the packages among them mount as the compile's
 * node_modules and double as the Sass loadPaths. The parts stay separate because
 * callers place them differently — a test install mounts the compiled tree and
 * the sources at different roots, a package unions the lot.
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
  const compiled = keepSourceJs && !requiresCompile(classified) ? undefined : compileJsSources(context, classified, deps, options);
  const css = compileCssSources(
    context,
    classified.css,
    deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet)
  );
  return Computable.forAll([compiled ?? Computable.resolve(EMPTY_FILESET), css], (built, lowered) => {
    /* What the compile actually delivers — `built` minus the JavaScript held
     * back under keepSourceJs, which the original is delivered in place of. */
    const emitted = keepSourceJs ? withoutTranspiledJs(built, classified.js) : built;
    return {
      sources: classified,
      compiled: emitted,
      css: lowered,
      /* The JavaScript the compiler didn't deliver is delivered here instead, so
       * the caller receives what it put in either way. JSON is subtracted for the
       * opposite reason: it is a compile input (resolveJsonModule), and tsc COPIES
       * every JSON an emitted module imports into outDir — so shipping it here as
       * well would be the same name from two different files, i.e. a conflict. A
       * JSON nothing imports is not emitted, and does still ship from here. */
      passthrough: (keepSourceJs ? FileSet.unionAll(passthroughFiles(classified), classified.js) : passthroughFiles(classified)).minus(
        emitted
      ),
      compileSrcs: compileSrcsOf(classified, deps) ?? EMPTY_FILESET,
    };
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
 * compile), resolved jointly by the caller's collection point. They are laid out
 * *scoped*
 * (`assembleScopedNodeModules`): the sources see only these direct deps at the
 * top of node_modules, while the full transitive closure is reachable only by
 * the deps themselves — so a source importing an undeclared transitive dep fails
 * to compile. TSC is the compiler's own concern, resolved inside js_compile. The
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
   * owns the node_modules layout (assembleScopedNodeModules) and JSX-runtime
   * detection; TSC is added by js_compile itself. */
  const inputs: SubTargetInputs = {
    srcs,
    deps: mountedDeps(directDeps),
    ...(options.packageName ? { package_name: options.packageName } : {}),
  };
  return context.subTarget("js_compile", inputs, {
    label: "Compiling",
    constraints: BUILD_OVERRIDE.with(options.constraints),
  });
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
  const sourceDeps = directDeps.filter(dep => !(dep instanceof PackageFileSet) && !(dep instanceof Flag));
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
 * import resolves to it as a sibling) but never `copied`, so it's compiled-
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

/** The diagnostic for a closure with no finite layout (see {@link mountWinners}):
 * name the cycle, and the pin that collapses it. */
function unrepresentableCycle(cycle: string[]): Error {
  const names = [...new Set(cycle.map(id => id.substring(0, id.lastIndexOf("@"))))];
  return attachHelp(
    new Error(
      `Cannot lay out this dependency closure: ${cycle.join(" -> ")} requires a different version of each package at every ` +
        "step, so no nesting satisfies them all — each package would have to be nested inside itself without end"
    ),
    `pin ${names.map(name => `'@npm:${name}:<version>'`).join(" or ")} so a single version of it is selected, ` +
      "which removes the nesting the cycle needs"
  );
}

/** The package instances of a delivery, collected once: the direct roots,
 * every reachable instance (cycle-safe — a delivered graph carries complete,
 * possibly cyclic edge bindings), one representative per packageId, and the
 * loose (non-package) sets passed through. */
interface CollectedPackages {
  roots: PackageFileSet[];
  all: PackageFileSet[];
  byId: Map<string, PackageFileSet>;
  loose: FileSet[];
}

function collectPackages(sets: FileSet[]): CollectedPackages {
  const byId = new Map<string, PackageFileSet>();
  const loose: FileSet[] = [];
  const roots: PackageFileSet[] = [];
  const all: PackageFileSet[] = [];
  const seen = new Set<PackageFileSet>();
  const collect = (pkg: PackageFileSet): void => {
    if (seen.has(pkg)) {
      return;
    }
    seen.add(pkg);
    all.push(pkg);
    if (!byId.has(pkg.packageId)) {
      byId.set(pkg.packageId, pkg);
    }
    for (const dep of pkg.dependencies) {
      if (dep instanceof PackageFileSet) {
        collect(dep);
      }
    }
  };
  for (const set of sets) {
    if (set instanceof PackageFileSet) {
      roots.push(set);
      collect(set);
    } else {
      loose.push(set);
    }
  }
  return { roots, all, byId, loose };
}

/**
 * The flat (hoisted) winner per name: a root always holds its own name;
 * otherwise the highest version. Two *different* roots sharing a name is a
 * conflict, not a pick: every root was directly listed, so each must hold its
 * own top-level mount, and two can't — the layout is unrepresentable (roots
 * cannot nest under each other the way a transitive non-winner can).
 *
 * Under `strict`, delivered **override** instances (a `?` sanction's nested
 * fork — {@link PackageFileSet.isNestedOverride}) never take a flat slot, and
 * two *non*-override instances disagreeing on a name are a conflict rather
 * than a version pick: that shape is two deliveries resolved apart (a local
 * package's closure vs this collection's), where hoisting one would silently
 * hand the other's requirers a version their resolution never chose. The
 * sealed assembler keeps the permissive highest-wins pick (a tool install is
 * opaque; the store-layout notes track its known looseness).
 */
function hoistWinners({ roots, all, byId }: CollectedPackages, strict: boolean): Map<string, string> {
  const top = new Map<string, string>();
  for (const root of roots) {
    const existing = top.get(root.packageName);
    if (existing !== undefined && existing !== root.packageId) {
      throw new ConflictError(
        "packages",
        root.packageName,
        { provenance: byId.get(existing)!.origin, detail: existing },
        { provenance: root.origin, detail: root.packageId }
      );
    }
    top.set(root.packageName, root.packageId);
  }
  for (const pkg of all) {
    if (strict && pkg.isNestedOverride) {
      continue;
    }
    const current = top.get(pkg.packageName);
    if (current === undefined) {
      top.set(pkg.packageName, pkg.packageId);
    } else if (current !== pkg.packageId && !roots.some(root => root.packageId === current)) {
      if (strict) {
        throw new ConflictError(
          "packages",
          pkg.packageName,
          { provenance: byId.get(current)!.origin, detail: current },
          { provenance: pkg.origin, detail: pkg.packageId }
        );
      }
      if (compareVersionText(pkg.version, byId.get(current)!.version) > 0) {
        top.set(pkg.packageName, pkg.packageId);
      }
    }
  }
  return top;
}

/** One planned position: the instance mounted there, and the private
 * overrides nested beneath it, keyed by the name they mount under. A shared
 * value — two positions with equal bindings share one plan. */
interface PlannedNest {
  pkg: PackageFileSet;
  overrides: Map<string, PlannedNest>;
}

/**
 * Mount every winner at `pathOf(name)`, nesting under each mounted instance
 * every dependency edge that binds somewhere other than what is *visible* at
 * its position — recursively: the tree encoding of the delivered (possibly
 * cyclic) graph, decided HERE, from the complete edge bindings the deliveries
 * carry, against the winners of everything this consumer is merging. The one
 * planner both assemblers share; only the namespace the winners land in
 * differs.
 *
 * A position is described entirely by its **bindings**: the flat winners
 * overridden by the divergences each enclosing mount introduced (kept
 * canonical — an entry equal to the flat winner is dropped, since it resolves
 * the same either way). Every divergence is mounted at the level that
 * introduced it — exactly where node's walk-up resolution finds it: the
 * private copy from its requirer, the flat winner from everyone else. Two
 * positions with equal bindings resolve every name identically and need the
 * same subtree, which is why a subtree is memoized on (packageId, bindings)
 * and shared rather than replanned — and why an ordinary dependency cycle
 * terminates: a cycle member's edge back to an already-bound name is not a
 * divergence.
 *
 * The same fact makes a repeat of a position still being planned fatal rather
 * than a stopping point. Each nesting is *forced*: a package can only see a
 * version other than its position's by carrying it privately. So returning to
 * a position already on the planning path means the forced sequence repeats
 * without end, and the closure has **no** finite node_modules layout — a
 * version cycle across generations (a@1 → b@1 → a@2 → b@2 → a@1) is the shape
 * that does it. A limit of the *layout*, not of the resolution (such a
 * closure resolves cleanly); judged here, at the merge that actually needs a
 * tree, so a cycle that only exists once deliveries are merged is caught, and
 * one that never mounts is not misreported.
 */
function mountWinners(top: Map<string, string>, byId: Map<string, PackageFileSet>, pathOf: (name: string) => string): FileSet[] {
  const signature = (id: string, bindings: Map<string, string>): string =>
    [id, ...[...bindings].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, to]) => `${name}=${to}`)].join("\n");
  /** Completed subtrees, and the positions on the current planning path (in
   * order, so a repeat can name the cycle it closes). */
  const planned = new Map<string, PlannedNest>();
  const path: Array<{ id: string; key: string }> = [];

  const plan = (pkg: PackageFileSet, bindings: Map<string, string>): PlannedNest => {
    const key = signature(pkg.packageId, bindings);
    const done = planned.get(key);
    if (done) {
      return done;
    }
    const repeated = path.findIndex(entry => entry.key === key);
    if (repeated >= 0) {
      throw unrepresentableCycle([...path.slice(repeated).map(entry => entry.id), pkg.packageId]);
    }
    path.push({ id: pkg.packageId, key });
    const divergent = new Map<string, PackageFileSet>();
    for (const dep of pkg.dependencies) {
      if (dep instanceof PackageFileSet && (bindings.get(dep.packageName) ?? top.get(dep.packageName)) !== dep.packageId) {
        divergent.set(dep.packageName, dep);
      }
    }
    /* Canonical: a divergence landing back on the flat winner binds nothing
     * new (it still mounts here — it has to, to shadow an intervening
     * override — but resolves to what the fallback already gives). */
    const nested = new Map(bindings);
    for (const [name, dep] of divergent) {
      if (top.get(name) === dep.packageId) {
        nested.delete(name);
      } else {
        nested.set(name, dep.packageId);
      }
    }
    const overrides = new Map<string, PlannedNest>();
    for (const [name, dep] of divergent) {
      overrides.set(name, plan(dep, nested));
    }
    path.pop();
    const result: PlannedNest = { pkg, overrides };
    planned.set(key, result);
    return result;
  };

  const mounts: FileSet[] = [];
  const emit = (node: PlannedNest, atPath: string): void => {
    mounts.push(node.pkg.mountedAt(atPath));
    for (const [name, override] of node.overrides) {
      emit(override, `${atPath}/node_modules/${name}`);
    }
  };
  for (const [name, id] of top) {
    emit(plan(byId.get(id)!, new Map()), pathOf(name));
  }
  return mounts;
}

/**
 * Lay out the given (materialized) sources as node_modules contents: each
 * package — and, recursively, every package its edges reach — is mounted at
 * its delivered package name (which for an alias is the requirer's name for
 * it); anything that isn't a package passes through unchanged. Per name a
 * deterministic **hoist winner** (a top-level set's package always wins its
 * own name; otherwise the highest version) mounts flat at
 * `node_modules/<name>`, and every dependency edge binding elsewhere nests
 * privately under its requirer — {@link mountWinners}, deciding the layout
 * here, at the merge, from the complete edge bindings the deliveries carry.
 * The sources must have been materialized by the collection point before they
 * get here.
 */
export function assembleNodeModules(sets: FileSet[]): FileSet {
  const collected = collectPackages(sets);
  const top = hoistWinners(collected, false);
  const mounts = mountWinners(top, collected.byId, name => name);
  return FileSet.unionAll(...mounts, ...collected.loose);
}

/** Compare two package version strings, semver where parseable (a locally
 * built package may carry none — sorts lowest; unparseable falls back to
 * string comparison). Only a tiebreak for the hoist spot: correctness rides on
 * nesting, not on which version wins the flat mount. */
function compareVersionText(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) {
    if (a === b) {
      return 0;
    }
    return a === undefined ? -1 : 1;
  }
  try {
    return compareVersions(parseVersion(a), parseVersion(b));
  } catch {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  }
}

/** The hidden store (a dot-dir, so never itself a resolvable package name) that
 * holds the full closure; each package's real files live at
 * `<STORE>/<name>`, so store packages resolve each other as siblings. */
const SCOPED_STORE = ".pkgs/node_modules";

/**
 * Lay out the given DIRECT sources as node_modules, but scoped so the consuming
 * sources see only the direct deps — not the transitive closure. The full
 * closure's real files go into a hidden store (`.pkgs/node_modules/<name>`
 * per hoist winner, so store packages resolve each other as siblings); each
 * *direct* package is then
 * exposed at the top of node_modules as a symlink into the store. Node/tsc
 * resolve the symlink to its real store path (`preserveSymlinks: false`), so a
 * direct dep resolves *its* imports from the store (the whole closure), while a
 * source importing an undeclared transitive dep finds nothing at the top level
 * and fails. A delivery carrying a sanctioned second version of a package (a
 * `?` alternate's fork) nests it under its requirers within the store
 * (`<STORE>/<requirer>/node_modules/<name>`) — decided by the shared
 * {@link mountWinners} planner from the delivered edge bindings, exactly as
 * the flat layout decides its nests — so node resolution finds the nested
 * copy from the requirer and the flat winner from everywhere else.
 * Non-package sources (loose files) pass through at the top level, as
 * a source may reference them directly. Requires the sources to be materialized.
 */
export function assembleScopedNodeModules(directSets: FileSet[]): FileSet {
  const collected = collectPackages(directSets);
  /* Strict: override instances nest and never take a flat slot; two
   * non-override instances disagreeing on a name conflict in hoistWinners
   * (every collected instance is otherwise mounted — winners flat, overrides
   * under the parents that list them). */
  const top = hoistWinners(collected, true);
  const mounts = mountWinners(top, collected.byId, name => `${SCOPED_STORE}/${name}`);
  const topLevel: FileSet[] = [];
  const linked = new Set<string>();
  for (const set of directSets) {
    if (set instanceof PackageFileSet) {
      if (!linked.has(set.packageName)) {
        linked.add(set.packageName);
        topLevel.push(new FileSet(new Map([[set.packageName, storeLink(set.packageName)]])));
      }
    } else {
      topLevel.push(set);
    }
  }
  return FileSet.unionAll(...mounts, ...topLevel);
}

/** A relative symlink from `node_modules/<name>` to the package's store copy.
 * The target is resolved from the link's own directory, so a scoped name
 * (`@x/y`, one directory deep) needs one `../` to climb back to node_modules. */
function storeLink(packageName: string): SymlinkFile {
  const depth = (packageName.match(/\//g) ?? []).length;
  return new SymlinkFile(`${"../".repeat(depth)}${SCOPED_STORE}/${packageName}`);
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
 * `#!` interpreter line — a fact fabr already holds (a declared bin, in a
 * js_package, so: node) and the source needn't restate; leaving it to a
 * hand-written source shebang lets a bin ship without one (self-hosting can't
 * catch it — fabr launches via the runnable descriptor, never the shebang). So
 * any bin whose bytes don't already start with `#!` (a bundled shell script
 * carries its own) gets `#!/usr/bin/env node` prepended here. The exec bit tsc
 * drops — and which fabr can't yet stamp without per-entry mode in the manifest —
 * npm restores on install.
 */
export function withBinShebangs(contents: FileSet): Computable<FileSet> {
  const files = new Map<string, IFile>(contents);
  const binPaths = [...new Set(binByConvention(contents).values())];
  if (binPaths.length === 0) {
    return Computable.resolve(contents);
  }
  return Computable.forAll(
    binPaths.map(path =>
      files
        .get(path)!
        .readString()
        .then(text => [path, text] as const)
    ),
    (...loaded) => {
      for (const [path, text] of loaded) {
        /* A bundled shell script carries its own `#!`; only a bare bin needs ours. */
        if (!text.startsWith("#!")) {
          files.set(path, MemoryFile.from(NODE_SHEBANG + text));
        }
      }
      /* Names are unchanged — only the shebang'd bins' identities differ. */
      return new FileSet(files, undefined, CANONICAL);
    }
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
 * `fabr run` meaning), deliberately not the resolver's namespace walk.
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
     * FileSet, which a ref is deliberately not. */
    const selected = runnable.selectEntry(entry.projections);
    if (!selected) {
      throw new Error(`entry projection matched no bin or file of ${pkg.packageId} — nothing to launch`);
    }
    return Computable.resolve(selected);
  });
}

/**
 * @return the package's `bin` as a command→path map. npm allows `bin` to be a
 * bare string (the command is the package's unscoped name) or an object; a
 * package.json with no `bin` (or none at all) yields an empty map — not runnable.
 */
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
    throw new Error(`Package '${packageName}' declares an invalid bin name ${JSON.stringify(command)}`);
  }
  /* The target is whatever JSON the package published: a non-string one is as
   * invalid as an out-of-package path and reports the same way, rather than as
   * a TypeError out of the path normalizer. */
  const cleanTarget = typeof target === "string" ? posix.normalize(target) : undefined;
  if (cleanTarget === undefined || !isCanonicalFileName(cleanTarget)) {
    throw new Error(`Package '${packageName}' declares an invalid bin target ${JSON.stringify(target)} for '${cleanCommand}'`);
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
