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

import {
  BUILD_OPERATION,
  Computable,
  EMPTY_FILESET,
  FileSet,
  Flag,
  IFile,
  PackageFileSet,
  RunnableFileSet,
  SymlinkFile,
  TargetContext,
} from "@fabr/core";

export interface JSTarget {
  version: string;
  module: "esm" | "commonjs";
  environment: "node" | "browser";
}

/**
 * Parse a JS target triple
 * @param target
 */
export function parseJSTarget(target: string): JSTarget {
  const bits = target.split("-");

  const result: JSTarget = { version: bits[0], module: "commonjs", environment: "node" };

  if (bits.length > 1 && bits[1] === "esm") {
    result.module = "esm";
  }
  if (bits.length > 2 && bits[2] === "browser") {
    result.environment = "browser";
  }
  return result;
}

/**
 * Simplify flags by removing flags that are provided (directly on indirectly) by another flag.
 * @param flags
 */
function simplifyFlags(flags: Flag[]): Flag[] {
  const closure = getFlagProvidesClosure(flags);
  return flags.filter(flag => !closure.has(flag));
}

/**
 * @returns all Flags provided by the input list of Flags, not including the flags themselves
 * (unless they are provided by another flag).
 */
function getFlagProvidesClosure(flags: Flag[]): Set<Flag> {
  const provided = new Set<Flag>();
  const queue: Flag[] = [...flags];
  let elem: Flag | undefined;
  while ((elem = queue.pop())) {
    elem.provides.forEach(p => {
      if (!provided.has(p)) {
        provided.add(p);
        queue.push(p);
      }
    });
  }
  return provided;
}

function getESRuntime(flags: Flag[], defaultRuntime: string): string {
  return simplifyFlags(flags).find(flag => flag.name.startsWith("es"))?.name ?? defaultRuntime;
}

/**
 * @return whether the tree holds compilable TypeScript sources (i.e. the
 * compile step — and hence the TSC toolchain — will be needed at all).
 */
export function hasTypescriptSources(files: FileSet): boolean {
  return [...files].some(([name]) => {
    const lower = name.toLowerCase();
    return (lower.endsWith(".ts") || lower.endsWith(".tsx")) && !lower.endsWith(".d.ts");
  });
}

export interface ICompiledSources {
  /** The compiled tree's output (from the js_compile sub-target); undefined
   * when there are no TypeScript sources to compile */
  compiled?: Computable<FileSet>;
  /** Non-compiled sources, passed through unchanged */
  copied: FileSet;
}

/**
 * Compile a JS/TS source tree by building the `js_compile` sub-target — the
 * single TS compile path shared by the package build and the test run.
 * TypeScript sources yield `compiled` (the sub-target's cached output);
 * anything not compiled is returned in `copied`. `directDeps` are the deps the
 * sources may import directly (the package's own deps, plus test_deps / runner
 * globals for a test compile); the NODE_TYPES delivery (`nodeTypes`, under the
 * nodejs flag) is folded in as another direct type dep. All were resolved
 * jointly by the caller's collection point. They are laid out *scoped*
 * (`assembleScopedNodeModules`): the sources see only these direct deps at the
 * top of node_modules, while the full transitive closure is reachable only by
 * the deps themselves — so a source importing an undeclared transitive dep fails
 * to compile. TSC is the compiler's own concern, resolved inside js_compile. The
 * sub-target builds under BUILD_OPERATION=build (a compile is a build even for a
 * test target). (Note: plain .js sources are currently dropped — transpiling
 * them is an open gap.)
 */
/** True iff a `package.json` declares the given `subpath` in its `exports` map
 * (e.g. `./jsx-runtime`). The general "does this package expose subpath X" test
 * that subpath-shaped capability signals build on. Malformed JSON reads as no. */
export function hasPackageExport(packageJson: string, subpath: string): boolean {
  try {
    const exports = (JSON.parse(packageJson) as { exports?: unknown }).exports;
    return typeof exports === "object" && exports !== null && subpath in exports;
  } catch {
    return false;
  }
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
  return pkg
    .get("package.json")
    .then(file => (file ? file.readString().then(json => hasPackageExport(json, "./jsx-runtime")) : false));
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

export function compileJsSources(
  context: TargetContext,
  sources: FileSet,
  directDeps: FileSet[],
  jsTarget: JSTarget,
  flags: Flag[],
  nodeTypes?: FileSet[]
): ICompiledSources {
  const sourceGroups = sources.partition(path => {
    const lower = path.toLowerCase();
    const extidx = lower.lastIndexOf(".");
    if (extidx !== -1) {
      const ext = lower.substring(extidx + 1);
      switch (ext) {
        case "ts":
          /* A hand-written .d.ts is both a compile *input* (ambient types tsc
           * must see — e.g. the local picomatch shim) and a shipped *resource*
           * (e.g. the test runner's globals .d.ts, read back from the installed
           * package): it joins both the compile srcs and the copied output. */
          if (lower.endsWith(".d.ts")) {
            return "dts";
          }
        /* fallthrough */
        case "tsx":
          return "ts";
        case "js":
        case "jsx":
          return "js";
      }
    }
    return "copy";
  });

  const declarations = sourceGroups.dts ?? EMPTY_FILESET;

  let compiled: Computable<FileSet> | undefined;
  if ("ts" in sourceGroups) {
    /* Hand js_compile the direct deps (plus, under nodejs, the node @types) as
     * they are: it owns the node_modules layout (assembleScopedNodeModules) and
     * the JSX-runtime detection, since those need the ordered package list and
     * are compile concerns. TSC is added by js_compile itself. */
    const deps = nodeTypes ? [...directDeps, ...nodeTypes] : directDeps;
    compiled = context.subTarget(
      "js_compile",
      { srcs: FileSet.unionAll(sourceGroups.ts, declarations), deps, runtime: getESRuntime(flags, jsTarget.version) },
      { label: "Compiling", constraints: { [BUILD_OPERATION]: "build" } }
    );
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
 */
export function assembleNodeModules(sets: FileSet[]): FileSet {
  const mounts: FileSet[] = [];
  const seen = new Set<PackageFileSet>();
  const mount = (pkg: PackageFileSet): void => {
    if (!seen.has(pkg)) {
      seen.add(pkg);
      mounts.push(mountPackage(pkg));
      for (const dep of pkg.dependencies) {
        if (dep instanceof PackageFileSet) {
          mount(dep);
        }
      }
    }
  };
  for (const set of sets) {
    if (set instanceof PackageFileSet) {
      mount(set);
    } else {
      mounts.push(set);
    }
  }
  return FileSet.unionAll(...mounts);
}

/** @return the package's files renamed under the package's mount point */
function mountPackage(pkg: PackageFileSet): FileSet {
  return pkg.remap(path => `${pkg.packageName}/${path}`);
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
  const toStore = (pkg: PackageFileSet): void => {
    if (!seen.has(pkg)) {
      seen.add(pkg);
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
 */
export function binByConvention(names: Set<string>): Record<string, string> {
  const bin: Record<string, string> = {};
  for (const filename of names) {
    const match = /^bin\/([^/]+)$/.exec(filename);
    if (match && !/\.d\.[cm]?ts$|\.map$/.test(match[1])) {
      bin[match[1].replace(/\.[^.]+$/, "")] = filename;
    }
  }
  return bin;
}

/**
 * Make a resolved package runnable: mount the package and its resolved
 * dependency closure as node_modules, and launch a bin under node. The runnable's
 * launch **surface** is the package's own files (findable by path) unioned with a
 * `SymlinkFile` per package.json `bin` (findable by command, targeting the bin's
 * install path — files added first, so a file wins a same-path tie); a projection
 * is `surface.find`. The default entry (no projection) is the sole bin, or a
 * bin-less package's sole file; anything else needs a projection. This is the
 * single "npm package → runnable" path — shared by an external `@npm:…` consumed
 * under `run` (via NPMRepository) and a declared `js_package[run]` (over its own
 * generated package.json bin). The package's dependencies must already be resolved
 * (PackageFileSets, not inert refs) — its collection point is responsible for that.
 */
export function makeNpmRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
  return binOf(pkg).then(bin => {
    const root = `node_modules/${pkg.packageName}`;
    const install = FileSet.layout({ node_modules: assembleNodeModules([pkg]) });
    /* Bins first: a declared bin takes precedence over a package file — it wins
     * its command *name* (a file sharing it is still in the install, just not the
     * surface entry for it) and, being earlier, wins a same-*path* dedup at launch.
     * So `fabr run pkg:tsc` is always the declared bin, never a stray file. */
    const surface = new Map<string, IFile>();
    for (const [command, binPath] of Object.entries(bin)) {
      surface.set(command, new SymlinkFile(`${root}/${binPath}`));
    }
    for (const [name, file] of pkg) {
      if (!surface.has(name)) {
        surface.set(name, file);
      }
    }
    return new RunnableFileSet(install, [], "node", root, new FileSet(surface));
  });
}

/**
 * @return the package's `bin` as a command→path map. npm allows `bin` to be a
 * bare string (the command is the package's unscoped name) or an object; a
 * package.json with no `bin` (or none at all) yields an empty map — not runnable.
 */
function binOf(pkg: PackageFileSet): Computable<Record<string, string>> {
  return pkg.get("package.json").then(file => {
    if (!file) {
      return {};
    }
    return file.readString().then(text => {
      const bin = (JSON.parse(text) as { bin?: unknown }).bin;
      if (typeof bin === "string") {
        return { [pkg.packageName.replace(/^@[^/]+\//, "")]: bin };
      }
      return bin && typeof bin === "object" ? (bin as Record<string, string>) : {};
    });
  });
}
