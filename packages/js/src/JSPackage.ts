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
  IProvenanceStep,
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

export interface JSTarget {
  version: string;
  module: "esm" | "commonjs";
  environment: "node" | "browser";
}

/** ECMAScript version names (es5, es2018, esnext) accepted as a JS target's
 * version component. */
const ES_VERSION = /^es(next|\d+)$/;

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
  return { version, module, environment };
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

export interface ICompiledSources {
  /** The compiled tree's output (from the js_compile sub-target); undefined
   * when there are no TypeScript sources to compile */
  compiled?: Computable<FileSet>;
  /** Non-compiled sources, passed through unchanged */
  copied: FileSet;
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
 * of the strict family, and `ts/no_esmodule_interop` for code written for
 * classic CJS interop (`import * as x` of a callable module, `export =`
 * consumers). A flag is recognized by its qualified target name
 * ({@link Flag.name}) and maps to a `compilerOptions` fragment merged after the
 * defaults (so `strict: false` overrides the default `strict: true`). A flag's
 * `provides` closure is walked too, so a composite flag expands to its members;
 * an unrecognized flag is ignored here (it may address a different rule).
 */
const SOURCE_MODE_OPTIONS: Record<string, Record<string, unknown>> = {
  "ts/nostrict": { strict: false },
  "ts/allow_implicit_any": { noImplicitAny: false },
  "ts/allow_implicit_null": { strictNullChecks: false },
  "ts/allow_uninitialized_props": { strictPropertyInitialization: false },
  "ts/no_esmodule_interop": { esModuleInterop: false },
};

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

/**
 * Classify a source file by what js_compile does with it: `"ts"`/`"js"` are
 * compiled (tsc emits `.js`/`.d.ts`), `"dts"` is a hand-written declaration
 * (a compile input that emits nothing), and `"copy"` is everything tsc neither
 * compiles nor emits — a runtime resource (`.json`, templates, `.sh`, assets).
 * The single source of truth for the extension → role mapping.
 */
export function classifyJsSource(path: string): "ts" | "dts" | "js" | "copy" {
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
      case "jsx":
        return "js";
    }
  }
  return "copy";
}

/**
 * The runtime *resources* among `sets` — the files tsc never emits (`.json`,
 * templates, assets), which a compiled tree therefore drops. A runnable install
 * must carry them alongside the compiled entry; a package/test build does not
 * (see compileJsSources: source deps are compiled-against, not shipped).
 */
export function resourceFiles(sets: FileSet[]): FileSet {
  return FileSet.unionAll(...sets.map(set => set.partition(classifyJsSource).copy ?? EMPTY_FILESET));
}

/**
 * Compile a JS/TS source tree by building the `js_compile` sub-target — the
 * single TS compile path shared by the package build and the test run.
 * TypeScript sources yield `compiled` (the sub-target's cached output);
 * anything not compiled is returned in `copied`. `directDeps` are the deps the
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
export function compileJsSources(context: TargetContext, sources: FileSet, directDeps: FileSet[]): ICompiledSources {
  const sourceGroups = sources.partition(classifyJsSource);

  const declarations = sourceGroups.dts ?? EMPTY_FILESET;

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
  const mountDeps = directDeps.filter(dep => dep instanceof PackageFileSet || dep instanceof Flag);
  const sourceDeps = directDeps.filter(dep => !(dep instanceof PackageFileSet) && !(dep instanceof Flag));

  let compiled: Computable<FileSet> | undefined;
  if ("ts" in sourceGroups || "js" in sourceGroups || sourceDeps.length > 0) {
    /* Both .ts(x) and .js(x) go through js_compile: with allowJs, tsc downlevels
     * the JS to JS_TARGET and lets a .ts import a local .js. .d.ts joins as an
     * ambient input (it is also copied through as a resource, below). js_compile
     * owns the node_modules layout (assembleScopedNodeModules) and JSX-runtime
     * detection; TSC is added by js_compile itself. */
    const srcs = FileSet.unionAll(
      sourceGroups.ts ?? EMPTY_FILESET,
      sourceGroups.js ?? EMPTY_FILESET,
      declarations,
      ...sourceDeps
    );
    const inputs: SubTargetInputs = { srcs, deps: mountDeps };
    compiled = context.subTarget("js_compile", inputs, {
      label: "Compiling",
      constraints: BUILD_OVERRIDE,
    });
  }

  return { compiled, copied: FileSet.unionAll(sourceGroups.copy ?? EMPTY_FILESET, declarations) };
}

/** @return the files without any root package.json (consumed, not copied through) */
export function stripPackageJson(files: FileSet): FileSet {
  return files.remap(name => (name === "package.json" ? undefined : name));
}

/**
 * Lay out the given (materialized) sources as node_modules contents: each
 * package — and, recursively, every package among its dependencies — is
 * mounted at its real package name (which may differ from the alias it was
 * written as); anything that isn't a package passes through unchanged. The
 * sources must have been materialized (any carried references resolved) by
 * the collection point before they get here.
 *
 * One uniform rule covers both dependency regimes (see PackageFileSet): per
 * name a deterministic **hoist winner** — a top-level set's package always
 * wins its own name (its entry path must resolve there); otherwise the
 * highest version — mounts flat at `node_modules/<name>`, and a listed
 * sub-dependency that is NOT the flat winner of its name is a private version
 * override, mounted under its lister (`<mount>/node_modules/<name>`),
 * recursively — exactly where node's walk-up resolution finds it: the private
 * copy from its requirer, the flat winner from everyone else. A built
 * package's direct deps and a strict delivery's flat closure are all winners
 * (one version per name), so everything mounts flat, as always; a permissive
 * delivery's listed overrides are precisely the non-winners, so they nest.
 * Hoisting is disk/path layout; the nesting carries the correctness.
 */
/**
 * Which node each node's dependencies bind to: node id → (dependency name →
 * the id satisfying it). The resolution reduced to what layout needs, and all
 * it needs — planning reads no files, so it settles before anything is
 * fetched. Transient: never carried on delivered values.
 *
 * The dependency name is the name the *requirer* uses — which under an alias
 * (`"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"`) is not the name of the package
 * the edge leads to. Layout follows the edge, so an aliased package is mounted
 * where its requirer's imports look for it, and only there.
 */
export type EdgeMap = Map<string, Map<string, string>>;

/**
 * A planned mount: which package instance sits at this position, the name it
 * is mounted under, and the private overrides nested beneath it. Ids and names
 * only — a plan is a statement about the resolution, not about content.
 *
 * `as` is the package's own name for every ordinary mount, and the alias for
 * an aliased one; two positions differing only in `as` are different mounts,
 * so it is part of a position's identity.
 */
export interface PlannedMount {
  id: string;
  as: string;
  overrides: PlannedMount[];
}

/**
 * Plan the node_modules tree for one delivered root: the flat-mount winners,
 * plus each node's private version overrides — the edges that bind somewhere
 * other than what is already visible at their position — recursively. The
 * result is the tree encoding of a (possibly cyclic) resolved graph, with
 * everything unlisted resolving to the flat winner implicitly.
 *
 * A position is described entirely by its **bindings**: the flat winners
 * overridden by the divergences each enclosing mount introduced (kept
 * canonical — an entry equal to the flat winner is dropped, since it resolves
 * the same either way). Every binding is mounted at the level that introduced
 * it, so two positions with equal bindings resolve every name identically and
 * need the same subtree — which is why a subtree can be memoized on
 * (id, bindings), and shared rather than replanned.
 *
 * The same fact makes a repeat of a position still being planned fatal rather
 * than a stopping point. Each nesting is *forced*: a package can only see a
 * version other than its position's by carrying it privately. So returning to
 * a position already on the path means the forced sequence repeats without
 * end, and the closure has **no** finite node_modules layout — a version cycle
 * across generations (a@1 → b@1 → a@2 → b@2 → a@1) is the shape that does it.
 * Note this is a limit of the *layout*, not of the resolution: such a closure
 * resolves perfectly cleanly, each fork repairing its violated edges —
 * there is simply no tree that satisfies every edge. So it is reported here,
 * where the layout is decided, as {@link assembleNodeModules} reports an
 * unrepresentable root collision, and not truncated into a tree that would
 * silently resolve a dependency to a version its requirer forbade.
 */
export function planMounts(
  rootId: string,
  rootName: string,
  winners: Map<string, string>,
  edges: EdgeMap,
  members: ReadonlySet<string>
): PlannedMount[] {
  const signature = (id: string, as: string, bindings: Map<string, string>): string =>
    [id, as, ...[...bindings].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, to]) => `${name}=${to}`)].join("\n");
  /** Completed subtrees, and the positions on the current planning path (in
   * order, so a repeat can name the cycle it closes). */
  const planned = new Map<string, PlannedMount>();
  const path: Array<{ id: string; key: string }> = [];

  const overridesOf = (id: string, bindings: Map<string, string>): PlannedMount[] => {
    const divergent = new Map<string, string>();
    for (const [name, toId] of edges.get(id) ?? []) {
      if ((bindings.get(name) ?? winners.get(name)) !== toId && members.has(toId)) {
        divergent.set(name, toId);
      }
    }
    /* Canonical: a divergence landing back on the flat winner binds nothing
     * new (it still mounts here — it has to, to shadow an intervening
     * override — but resolves to what the fallback already gives). */
    const nested = new Map(bindings);
    for (const [name, toId] of divergent) {
      if (winners.get(name) === toId) {
        nested.delete(name);
      } else {
        nested.set(name, toId);
      }
    }
    return [...divergent].map(([name, toId]) => mount(toId, name, nested));
  };

  const mount = (id: string, as: string, bindings: Map<string, string>): PlannedMount => {
    const key = signature(id, as, bindings);
    const done = planned.get(key);
    if (done) {
      return done;
    }
    const repeated = path.findIndex(entry => entry.key === key);
    if (repeated >= 0) {
      throw unrepresentableCycle([...path.slice(repeated).map(entry => entry.id), id]);
    }
    path.push({ id, key });
    const result: PlannedMount = { id, as, overrides: overridesOf(id, bindings) };
    path.pop();
    planned.set(key, result);
    return result;
  };

  /* The top of the tree binds nothing beyond the flat winners. The root's own
   * name is the consumer's to mount (it IS the delivered package); any other
   * name winning the root — an alias of it — still needs its own mount. */
  const top = new Map<string, string>();
  return [
    ...[...winners].filter(([name]) => name !== rootName).map(([name, id]) => mount(id, name, top)),
    ...overridesOf(rootId, top),
  ];
}

/** The diagnostic for a closure with no finite layout (see {@link planMounts}):
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

/**
 * Realise a plan against the fetched packages: each mount becomes a
 * PackageFileSet carrying its overrides as its own dependencies, built
 * depth-first so every instance is immutable-complete at construction. A
 * subtree shared by the plan stays one instance here too.
 *
 * A mount is stamped with the name it is mounted *as*, which for an aliased
 * dependency is not the fetched package's own name: `wrap-ansi` delivered as
 * `wrap-ansi-cjs` is a package of that name as far as the install is concerned
 * — the same thing npm's on-disk `node_modules/wrap-ansi-cjs` (whose
 * package.json still says `wrap-ansi`) means. The content is shared with any
 * other mount of that version; only the identity this instance carries — and
 * hence where {@link assembleNodeModules} puts it — differs.
 */
export function buildMounts(
  plan: readonly PlannedMount[],
  packages: Map<string, PackageFileSet>,
  origin: IProvenanceStep
): PackageFileSet[] {
  const built = new Map<PlannedMount, PackageFileSet>();
  const build = (node: PlannedMount): PackageFileSet => {
    const done = built.get(node);
    if (done) {
      return done;
    }
    const files = packages.get(node.id)!;
    const result = new PackageFileSet(files, node.as, files.version, node.overrides.map(build), origin);
    built.set(node, result);
    return result;
  };
  return plan.map(build);
}

export function assembleNodeModules(sets: FileSet[]): FileSet {
  /* Collect every package instance (the delivered override structure is a
   * finite tree; built-package structure is acyclic by construction). */
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

  /* The flat (hoisted) winner per name: a root always holds its own name;
   * otherwise the highest version. Two *different* roots sharing a name is a
   * conflict, not a pick: every root was directly listed, so each must hold its
   * own top-level mount, and two can't — the layout is unrepresentable (roots
   * cannot nest under each other the way a transitive non-winner can). */
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
    const current = top.get(pkg.packageName);
    if (current === undefined) {
      top.set(pkg.packageName, pkg.packageId);
    } else if (current !== pkg.packageId && !roots.some(root => root.packageId === current)) {
      if (compareVersionText(pkg.version, byId.get(current)!.version) > 0) {
        top.set(pkg.packageName, pkg.packageId);
      }
    }
  }

  const mounts: FileSet[] = [];
  const mounted = new Set<string>();
  /** Mount a package at `atPath`, nesting its listed non-winner deps under it. */
  const mountAt = (pkg: PackageFileSet, atPath: string): void => {
    const mountKey = `${pkg.packageId}\n${atPath}`;
    if (mounted.has(mountKey)) {
      return;
    }
    mounted.add(mountKey);
    mounts.push(pkg.remap(path => `${atPath}/${path}`));
    for (const dep of pkg.dependencies) {
      if (dep instanceof PackageFileSet && top.get(dep.packageName) !== dep.packageId) {
        mountAt(dep, `${atPath}/node_modules/${dep.packageName}`);
      }
    }
  };
  for (const [name, id] of top) {
    mountAt(byId.get(id)!, name);
  }
  return FileSet.unionAll(...mounts, ...loose);
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
 * closure's real files go into a hidden store (`.pkgs/node_modules/<name>`,
 * flat, so deps resolve each other as siblings); each *direct* package is then
 * exposed at the top of node_modules as a symlink into the store. Node/tsc
 * resolve the symlink to its real store path (`preserveSymlinks: false`), so a
 * direct dep resolves *its* imports from the store (the whole closure), while a
 * source importing an undeclared transitive dep finds nothing at the top level
 * and fails. Non-package sources (loose files) pass through at the top level, as
 * a source may reference them directly. Requires the sources to be materialized.
 */
export function assembleScopedNodeModules(directSets: FileSet[]): FileSet {
  const store: FileSet[] = [];
  const seen = new Set<PackageFileSet>();
  const storedByName = new Map<string, PackageFileSet>();
  const toStore = (pkg: PackageFileSet): void => {
    if (!seen.has(pkg)) {
      seen.add(pkg);
      /* The store is flat (one slot per name — that's what lets siblings resolve
       * each other), so a closure carrying two *different* packages under one
       * name is unrepresentable: report the packages, not the raw file collision
       * the union would eventually trip over. Two instances with the same
       * identity are fine (deliveries wrap their own instances; the union dedups
       * their identical files). */
      const existing = storedByName.get(pkg.packageName);
      if (existing && existing.packageId !== pkg.packageId) {
        throw new ConflictError(
          "packages",
          pkg.packageName,
          { provenance: existing.origin, detail: existing.packageId },
          { provenance: pkg.origin, detail: pkg.packageId }
        );
      }
      storedByName.set(pkg.packageName, pkg);
      store.push(pkg.remap(path => `${SCOPED_STORE}/${pkg.packageName}/${path}`));
      for (const dep of pkg.dependencies) {
        if (dep instanceof PackageFileSet) {
          toStore(dep);
        }
      }
    }
  };
  const topLevel: FileSet[] = [];
  const linked = new Set<string>();
  for (const set of directSets) {
    if (set instanceof PackageFileSet) {
      toStore(set);
      if (!linked.has(set.packageName)) {
        linked.add(set.packageName);
        topLevel.push(new FileSet(new Map([[set.packageName, storeLink(set.packageName)]])));
      }
    } else {
      topLevel.push(set);
    }
  }
  return FileSet.unionAll(...store, ...topLevel);
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
    binPaths.map(path => files.get(path)!.readString().then(text => [path, text] as const)),
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
 * RUNNABLE's entry — replayed on its surface via the one application
 * mechanism, `FileSetRef.manifest` — bin by command or file by path, the
 * written form's `fabr run` meaning.
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
    if (!(entry instanceof FileSetRef) || entry.projections.length === 0) {
      return Computable.resolve(runnable);
    }
    return new FileSetRef(runnable, entry.projections).manifest().then(selected => {
      if (!(selected instanceof RunnableFileSet)) {
        throw new Error(`entry projection matched no bin or file of ${pkg.packageId} — nothing to launch`);
      }
      return selected;
    });
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
