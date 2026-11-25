/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { dirname, join, posix, relative, sep } from "path";
import {
  BuildAction,
  Computable,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  IFile,
  mapComputable,
  MemoryFile,
  nodeNaming,
  PackageFileSet,
  RunnableArgument,
  RunnableFileSet,
  stringConfig,
  SymlinkFile,
  TargetContext,
  TREE_MOUNT,
  walkPackages,
} from "@fabr-build/core";
import {
  type IPnpPackageInfo,
  type IPnpSerializedState,
  type PnpDependencyTarget,
  PNP_DATA_FILE,
  PNP_PRELOAD,
  resolveVirtual,
  TREE_LINK,
} from "@fabr-build/js-tools";
import { assembleHoistedNodeModules, assembleNodeModules, hoistedPlacements, INSTANCE_AREA, packageDirectories } from "./NodeModules";
import { ISelfPackage, pnpManifestOf, unpluggedPackages } from "./PnPManifest";

/**
 * The `layout` config tokens: how a step's tool reaches its packages. Each rule
 * chooses one.
 *
 * - `pnp`: no tree is staged. Each package is a tree in the cache's tree pool,
 *   and a generated PnP table says what each import resolves to; the step
 *   stages only its own files and the table. For a tool fabr can hand a PnP
 *   table to.
 * - `node_modules`: a `node_modules` tree staged at the mount
 *   ({@link assembleNodeModules}), the direct deps linked at its top. For a tool
 *   that resolves packages through the filesystem.
 * - `hoisted`: a `node_modules` tree with no links staged at the mount
 *   ({@link assembleHoistedNodeModules}), for an install copied somewhere that
 *   keeps no symlinks.
 */
export const PNP = "pnp";
export const NODE_MODULES = "node_modules";
export const HOISTED = "hoisted";

/** The layout tokens, for a caller that validates one. */
export type NodeLayout = typeof PNP | typeof NODE_MODULES | typeof HOISTED;

/** The action's packages laid out for a step, as its `layout` config says. */
export interface IPackageLayout {
  /** What the layout stages beside the step's own files: the `node_modules`
   *  tree at its mount, or the PnP table. */
  readonly files: FileSet;
  /** The packages the PnP table names in the tree pool, by each one's
   *  location relative to the working directory; empty for a `node_modules`
   *  tree, whose packages are among {@link files}. */
  readonly trees: ReadonlyMap<string, PackageFileSet>;
  /** The packages among the action's `deps` themselves: what a lookup by name
   *  falls back to where the requirer's own dependencies do not answer it. */
  readonly members: ReadonlyArray<PackageFileSet>;
  /** False where what a read finds can change with no row the key names
   *  changing (a hoisted tree, whose top holds packages besides
   *  {@link members} and where a later copy may be placed above a lookup), so
   *  a step's reads are not named at all; otherwise true. */
  readonly namesReads: boolean;
  /**
   * Name a path the tool read (absolute, real or virtual, as the tool records
   * it) as the action's key names it:
   * - a path within a package: `{route, path, package}`, the package's
   *   canonical route (the dependency names the key's walk first reaches it by)
   *   and the path within it. Under `node_modules`, a path under
   *   `node_modules/<name>/` where no direct dep has that name gives the route
   *   `[<name>]` with no `package` (a probe for a package that is not there).
   * - any other path under the working directory: `{file}`, its name there.
   * - anything else, including a path outside the working directory that is
   *   no package's (a linked install, the interpreter) and a path into the
   *   tree's hidden links: undefined.
   *
   * Names nothing where {@link namesReads} is false.
   */
  nameRead(read: string): ReadName | undefined;
  /**
   * @return the absolute path of `path` within the package `route` reaches:
   * the dependency names from the top of what the layout stages, each looked
   * up as the tool resolves an import from the package before it, through the
   * PnP table or the `node_modules` links, or, in a hoisted tree, each taken
   * along the packages' edges. The package's directory is its instance
   * directory, a directory the hoisted tree places it at, or its location over
   * the tree pool, which may be a virtual one. Undefined where a name along the
   * route resolves to nothing, or the hoisted tree places the package nowhere
   * (it is only ever bundled).
   */
  locate(route: ReadonlyArray<string>, path: string): string | undefined;
}

/** How {@link IPackageLayout.nameRead} names a read: one of the step's own files, or a path within a package. */
export type ReadName = { file: string } | { route: string[]; path: string; package?: PackageFileSet };

/**
 * Lay out the action's `deps` as its `layout` config says, for the step working
 * in `dir`: a `node_modules` tree at `mount`, linked or hoisted (with a link from the sources'
 * own package name to the sources, where the action's config names one), or a
 * PnP table over the tree pool, each of its trees made with `ensureTree`
 * first. With `unplug`, a PnP table locates the packages to unplug
 * ({@link unpluggedPackages}) in one tree of their own, for a step that runs
 * the packages' code. An install the action links in ({@link BuildAction.links})
 * is left out of either. Throws where the `layout` config is neither token or
 * `deps` is not a list.
 */
export function layoutPackages(
  action: BuildAction,
  dir: string,
  ensureTree: (files: FileSet) => Computable<string>,
  mount = "node_modules",
  unplug = false
): Computable<IPackageLayout> {
  const deps = depsInput(action);
  const self = selfPackage(action);
  const routes = routesOf(deps);
  const members = deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
  if (layoutConfig(action) === PNP) {
    return (unplug ? unpluggedPackages(deps) : Computable.resolve<ReadonlySet<string>>(new Set())).then(unplugged => {
      const manifest = pnpManifestOf(deps, self, linkPattern(action), unplugged);
      const files = FileSet.layout({ [PNP_DATA_FILE]: manifest.toFile() });
      const trees = new Map(manifest.packages.map((pkg): [string, PackageFileSet] => [manifest.mountOf(pkg), pkg]));
      return mapComputable(manifest.trees, ensureTree).then(paths => {
        /* The pool every tree is in, which the table's locations are relative
         * to (through TREE_LINK). */
        const pool = paths.length === 0 ? undefined : dirname(paths[0]);
        /* Each package's location on this machine, as the runtime names a
         * module in it: within its tree in the pool, or virtual over it. */
        const locations =
          pool === undefined
            ? []
            : manifest.packages.map((pkg): [string, PackageFileSet] => [
                join(pool, ...posix.relative(TREE_LINK, manifest.mountOf(pkg)).split("/")),
                pkg,
              ]);
        return {
          files,
          trees,
          members,
          namesReads: true,
          nameRead: poolReadNamer(dir, locations, routes),
          locate: tableLocator(manifest.state, pool),
        };
      });
    });
  }
  if (layoutConfig(action) === HOISTED) {
    const placements = hoistedPlacements(deps, self?.name);
    const files = FileSet.layout({ [mount]: [assembleHoistedNodeModules(deps, placements), selfLink(self, mount)] });
    return Computable.resolve({
      files,
      trees: new Map(),
      members,
      namesReads: false,
      nameRead: () => undefined,
      locate: hoistedLocator(placements, members, dir, mount),
    });
  }
  const files = FileSet.layout({ [mount]: [assembleNodeModules(deps), selfLink(self, mount)] });
  return Computable.resolve({
    files,
    trees: new Map(),
    members,
    namesReads: true,
    nameRead: treeReadNamer(dir, mount, packageDirectories(deps), routes, members),
    locate: treeLocator(files, dir, mount),
  });
}

/**
 * Make {@link IPackageLayout.locate} for a PnP layout: follow the route through
 * the table's rows, from the top-level row, each name to the row its
 * dependency entry names, as the runtime resolves an import; the package is at
 * the last row's location, over the tree pool at `pool`.
 */
function tableLocator(state: IPnpSerializedState, pool: string | undefined): IPackageLayout["locate"] {
  const rows = new Map<string, IPnpPackageInfo>();
  for (const [name, references] of state.packageRegistryData) {
    for (const [reference, info] of references) {
      rows.set(`${name}\0${reference}`, info);
    }
  }
  const dependencies = new Map<IPnpPackageInfo, Map<string, PnpDependencyTarget>>();
  const dependencyOf = (row: IPnpPackageInfo, name: string): PnpDependencyTarget | undefined => {
    let byName = dependencies.get(row);
    if (byName === undefined) {
      byName = new Map(row.packageDependencies);
      dependencies.set(row, byName);
    }
    return byName.get(name);
  };
  return (route, path) => {
    let row = rows.get(`${null}\0${null}`);
    for (const name of route) {
      const target = row === undefined ? undefined : dependencyOf(row, name);
      if (target === undefined || target === null) {
        return undefined;
      }
      const [rowName, reference] = typeof target === "string" ? [name, target] : target;
      row = rows.get(`${rowName}\0${reference}`);
    }
    if (row === undefined || route.length === 0 || pool === undefined) {
      return undefined;
    }
    return join(pool, ...posix.relative(TREE_LINK, row.packageLocation).split("/"), ...path.split("/"));
  };
}

/**
 * Make {@link IPackageLayout.locate} for a `node_modules` layout: follow the
 * route through the links of `files`, the tree staged at `mount` in `dir`, as
 * node resolves an import: the first name's link at the top, then each name's
 * link beside the package reached.
 */
function treeLocator(files: FileSet, dir: string, mount: string): IPackageLayout["locate"] {
  return (route, path) => {
    let reached: string | undefined;
    for (const [at, name] of route.entries()) {
      /* The directory holding a package's dependency links: the
       * `node_modules` its own directory is in. */
      const nodeModules = reached === undefined ? mount : reached.slice(0, reached.length - route[at - 1].length - 1);
      const link = `${nodeModules}/${name}`;
      const file = files.getFile(link);
      if (!(file instanceof SymlinkFile)) {
        return undefined;
      }
      reached = posix.join(posix.dirname(link), file.target);
    }
    return reached === undefined ? undefined : join(dir, ...reached.split("/"), ...path.split("/"));
  };
}

/**
 * Make {@link IPackageLayout.locate} for a hoisted layout: follow the route
 * through the packages' edges, from the member of its first name, to the
 * package it names, and locate that package's file at a directory `placements`
 * places it at, in the tree staged at `mount` in `dir`.
 */
function hoistedLocator(
  placements: ReadonlyMap<string, PackageFileSet>,
  members: ReadonlyArray<PackageFileSet>,
  dir: string,
  mount: string
): IPackageLayout["locate"] {
  const nodeOf = nodeNaming(members);
  const directories = new Map<string, string>();
  for (const [directory, pkg] of placements) {
    if (!directories.has(nodeOf(pkg))) {
      directories.set(nodeOf(pkg), directory);
    }
  }
  return (route, path) => {
    let reached: PackageFileSet | undefined;
    for (const name of route) {
      const among: ReadonlyArray<PackageFileSet> = reached === undefined ? members : reached.packages;
      reached = among.find(pkg => pkg.packageName === name);
      if (reached === undefined) {
        return undefined;
      }
    }
    const directory = reached === undefined ? undefined : directories.get(nodeOf(reached));
    return directory === undefined ? undefined : join(dir, ...mount.split("/"), ...directory.split("/"), ...path.split("/"));
  };
}

/** A program's packages as its install holds them ({@link layoutProgram}). */
export interface IProgramLayout {
  /** What the install holds for them: a `node_modules` tree, or the PnP table
   *  and the preload beside it. */
  readonly files: FileSet;
  /** Get the directory `pkg`'s files are reached at, relative to the install root. */
  locationOf(pkg: PackageFileSet): string;
  /** What node is given before the entry: under PnP, the preload. */
  readonly interpreterArgs: RunnableArgument[];
}

/** The global naming the program whose bin a PnP install's preload requires. */
const PNP_RUNTIME_GLOBAL = "JS_PNP_RUNTIME";

/** What a PnP install's preload says where its install has no tree pool beside it. */
const PNP_STAGING_ERROR =
  "A layout/pnp program runs only as a program of its own (fabr run, serve, or a one-stage generate): " +
  "it is staged here with no tree pool beside it";

/** A PnP install's preload ({@link PNP_PRELOAD}) and what it needs. */
export interface IPnpPreload {
  /** The preload, to stage beside the install's PnP table. */
  readonly file: MemoryFile;
  /** The runtime it loads, which must be a tree of the pool where it runs. */
  readonly runtime: RunnableFileSet;
}

/**
 * Make the preload of a PnP install: node is given it with `--require`, and it
 * loads the runtime `JS_PNP_RUNTIME` names from its tree in the pool, through
 * the pool's link beside the install, and installs it for the table beside the
 * preload, for this process and every node process it starts
 * (js-tools' `installFromPreload`). It refuses to run where there is no pool
 * beside it.
 */
export function pnpPreloadOf(context: TargetContext): Computable<IPnpPreload> {
  return context.getGlobalRunnable(PNP_RUNTIME_GLOBAL).then(runtime => {
    const entry = runtimeEntryOf(runtime);
    return { file: preloadFile(TREE_MOUNT, `${runtime.toManifestHash()}/${entry}`, PNP_STAGING_ERROR), runtime };
  });
}

/** @return the install path of the bin of `runtime`, the program `JS_PNP_RUNTIME` names: a runnable launched by nothing. */
function runtimeEntryOf(runtime: RunnableFileSet): string {
  const [bin] = new RunnableFileSet(runtime, [], undefined, runtime.root, runtime.surface).toCommandLine();
  if (typeof bin !== "object" || !("installFile" in bin)) {
    throw new FabrError(`${PNP_RUNTIME_GLOBAL} must be a program of its own install`);
  }
  return bin.installFile;
}

/**
 * Make a PnP install's preload: it requires `entry` from the directory `pool`
 * (both relative to the preload's own directory) and installs it for the table
 * beside the preload, refusing with `missing` where `pool` is not there.
 */
function preloadFile(pool: string, entry: string, missing: string): MemoryFile {
  return MemoryFile.from(
    [
      `"use strict";`,
      `const path = require("path");`,
      `const pool = path.join(__dirname, ${JSON.stringify(pool)});`,
      `if (!require("fs").existsSync(pool)) {`,
      `  throw new Error(${JSON.stringify(missing)} + " (" + __dirname + ")");`,
      `}`,
      `require(path.join(pool, ${JSON.stringify(entry)})).installFromPreload(__filename);`,
      ``,
    ].join("\n")
  );
}

/** The directory a self-contained PnP installation holds its trees in ({@link pnpInstallation}). */
const INSTALLED_POOL = ".fabr-tree";

/** What a self-contained PnP installation's preload says where its trees are missing. */
const INSTALLED_POOL_ERROR = `A layout/pnp installation runs only with its ${INSTALLED_POOL} directory beside its PnP table`;

/**
 * Lay out `packages` as a PnP installation that holds everything it needs and
 * no links: the PnP table and the preload (which node is given with
 * `--require`) at its root, each package in `packages` at
 * `node_modules/<name>/` (one to unplug beside the others it is unplugged
 * with), and every other package, and the PnP runtime, in a tree of its own
 * copied to `.fabr-tree/<content hash>/`.
 */
export function pnpInstallation(context: TargetContext, packages: PackageFileSet[]): Computable<FileSet> {
  return Computable.forAll(
    [unpluggedPackages(packages), context.getGlobalRunnable(PNP_RUNTIME_GLOBAL)] as const,
    (unplugged, runtime) => {
      const manifest = pnpManifestOf(packages, undefined, undefined, unplugged, { pool: INSTALLED_POOL, besideTable: true });
      /* The runtime's own package, which imports nothing but node's modules and
       * its own files: what its install holds where its root leads. */
      const link = runtime.getFile(runtime.root);
      const home = link instanceof SymlinkFile ? posix.join(posix.dirname(runtime.root), link.target) : runtime.root;
      const own = new FileSet(
        new Map(
          [...runtime].flatMap(([name, file]): Array<[string, IFile]> =>
            name.startsWith(`${home}/`) ? [[name.slice(home.length + 1), file]] : []
          )
        )
      );
      const entry = posix.relative(runtime.root, runtimeEntryOf(runtime));
      if (own.getFile(entry) === undefined) {
        throw new FabrError(`${PNP_RUNTIME_GLOBAL} must be a package's program, its files under its install's root`);
      }
      const runtimeTree = own.toManifestHash();
      return FileSet.unionAll(
        FileSet.layout({
          [PNP_DATA_FILE]: manifest.toFile(),
          [PNP_PRELOAD]: preloadFile(INSTALLED_POOL, `${runtimeTree}/${entry}`, INSTALLED_POOL_ERROR),
        }),
        ...manifest.trees.map(tree => tree.mountedAt(`${INSTALLED_POOL}/${tree.toManifestHash()}`)),
        manifest.beside,
        own.mountedAt(`${INSTALLED_POOL}/${runtimeTree}`)
      );
    }
  );
}

/** Lay out a program's `packages` in a `node_modules` tree, linked or (with
 *  `hoisted`) not, each reached at `node_modules/<name>`. */
export function nodeModulesLayout(packages: PackageFileSet[], hoisted = false): IProgramLayout {
  return {
    files: FileSet.layout({ node_modules: hoisted ? assembleHoistedNodeModules(packages) : assembleNodeModules(packages) }),
    locationOf: pkg => `node_modules/${pkg.packageName}`,
    interpreterArgs: [],
  };
}

/**
 * Lay out a program's `packages` (those of `deps`, and a package entry among
 * them) as `layout` says:
 *
 * - `node_modules`, `hoisted`: a tree at `node_modules`, linked or not, each
 *   package reached at `node_modules/<name>`.
 * - `pnp`: the PnP table at the install root and, beside it, the preload
 *   ({@link pnpPreloadOf}) that node is given with `--require`. Each package,
 *   and the runtime, is a tree written to the pool here, reached through the
 *   pool's link beside the install, so the program runs only where it is
 *   staged with that link beside it. The packages to unplug
 *   ({@link unpluggedPackages}) are trees of their own.
 */
export function layoutProgram(context: TargetContext, packages: PackageFileSet[], layout: NodeLayout): Computable<IProgramLayout> {
  if (layout !== PNP) {
    return Computable.resolve(nodeModulesLayout(packages, layout === HOISTED));
  }
  return Computable.forAll(
    [
      unpluggedPackages(packages).then(unplugged => {
        const manifest = pnpManifestOf(packages, undefined, undefined, unplugged);
        return mapComputable(manifest.trees, tree => context.ensureTree(tree)).then(() => manifest);
      }),
      pnpPreloadOf(context),
    ] as const,
    (manifest, preload) =>
      context.ensureTree(preload.runtime).then((): IProgramLayout => ({
        files: FileSet.layout({ [PNP_DATA_FILE]: manifest.toFile(), [PNP_PRELOAD]: preload.file }),
        locationOf: pkg => manifest.mountOf(pkg),
        /* `./`, so node reads it as a file rather than a package name. */
        interpreterArgs: ["--require", { installFile: `./${PNP_PRELOAD}` }],
      }))
  );
}

/** Read the action's `layout` config, one of the {@link NodeLayout} tokens. */
function layoutConfig(action: BuildAction): NodeLayout {
  const layout = stringConfig(action, "layout");
  if (layout !== PNP && layout !== NODE_MODULES && layout !== HOISTED) {
    throw new FabrError(`Config 'layout' must be '${PNP}', '${NODE_MODULES}' or '${HOISTED}', not '${layout}'`);
  }
  return layout;
}

/** Read the action's `deps` input, discoverable or not: the packages the tool
 *  reaches. */
export function depsInput(action: BuildAction): FileSet[] {
  const value = action.discoverable?.deps ?? action.inputs.deps;
  if (!Array.isArray(value)) {
    throw new FabrError(`Input 'deps' must be a list of filesets`);
  }
  return value;
}

/** @return the config entries that record `self`, read back by {@link selfPackage}. */
export function selfConfig(self: ISelfPackage | undefined): Record<string, string> {
  return self === undefined ? {} : { selfName: self.name, selfLocation: self.location };
}

/** Read back the config {@link selfConfig} wrote: the package name and
 *  location of the staged sources, where they are a package's. */
function selfPackage(action: BuildAction): ISelfPackage | undefined {
  const name = action.config.selfName;
  const location = action.config.selfLocation;
  return typeof name === "string" && typeof location === "string" ? { name, location } : undefined;
}

/**
 * @return the sources' own entry in a `node_modules` tree: a link from their
 * package's name to where they lie, so an import of their own name resolves
 * to them. Empty where the sources are no package's.
 */
function selfLink(self: ISelfPackage | undefined, mount: string): FileSet {
  if (self === undefined) {
    return EMPTY_FILESET;
  }
  /* Relative to the link's own DIRECTORY: the mount's segments, plus one per
   * scope segment of the name above the link (node_modules/@scope/pkg -> ../..). */
  const up = "../".repeat(mount.split("/").length + self.name.split("/").length - 1);
  return FileSet.layout({ [self.name]: new SymlinkFile(up + posix.normalize(self.location).replace(/\/$/, "")) });
}

/** @return the pattern of the names the action links installs at, which a PnP table
 *  leaves out of its lookups. */
function linkPattern(action: BuildAction): string | undefined {
  const names = Object.keys(action.links);
  return names.length === 0 ? undefined : `^(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(/|$)`;
}

/** @return the canonical route of each package reachable from `deps`: the
 *  dependency names {@link walkPackages} first reaches it by. */
function routesOf(deps: FileSet[]): Map<PackageFileSet, string[]> {
  const routes = new Map<PackageFileSet, string[]>();
  walkPackages(deps, (pkg, route) => {
    if (!routes.has(pkg)) {
      routes.set(pkg, route);
    }
  });
  return routes;
}

/**
 * Make {@link IPackageLayout.nameRead} for a `node_modules` layout. A path under
 * a package's instance directory, or the directory itself, is that package's (a module load records the
 * link's target, the real path). A path under the mount's top-level `<name>/`
 * is the direct dep of that name, or `[<name>]` with no package where there is
 * none. A path anywhere else under the mount (the hidden links) is undefined.
 */
function treeReadNamer(
  dir: string,
  mount: string,
  directories: ReadonlyMap<PackageFileSet, string>,
  routes: ReadonlyMap<PackageFileSet, string[]>,
  members: ReadonlyArray<PackageFileSet>
): IPackageLayout["nameRead"] {
  const byDirectory = firstByKey([...directories].map(([pkg, directory]): [string, PackageFileSet] => [`${mount}/${directory}`, pkg]));
  return read => {
    const name = workName(dir, read);
    if (name === undefined) {
      return undefined;
    }
    if (!name.startsWith(`${mount}/`)) {
      return { file: name };
    }
    const owner = enclosing(byDirectory, name, posix.dirname);
    if (owner !== undefined) {
      return within(routes, owner[1], name.slice(owner[0].length + 1));
    }
    const top = topLevelName(name.slice(mount.length + 1));
    if (top === undefined) {
      return undefined;
    }
    return { route: [top.name], path: top.path, package: members.find(member => member.packageName === top.name) };
  };
}

/** Split a path under the mount into the package name it starts with (two
 *  segments for a scope) and the rest, or undefined for the hidden area. */
function topLevelName(path: string): { name: string; path: string } | undefined {
  const segments = path.split("/");
  const depth = segments[0].startsWith("@") ? 2 : 1;
  if (segments[0] === INSTANCE_AREA || segments.length < depth || segments.slice(0, depth).some(segment => segment === "")) {
    return undefined;
  }
  return { name: segments.slice(0, depth).join("/"), path: segments.slice(depth).join("/") };
}

/** Make {@link IPackageLayout.nameRead} for a PnP layout. A path within a
 *  package's location, or the location itself, (its virtual location where it has one, else its tree in
 *  the pool) is that package's. A physical path into a tree that only virtual
 *  locations name is the package at the first of them. */
function poolReadNamer(
  dir: string,
  locations: ReadonlyArray<[string, PackageFileSet]>,
  routes: ReadonlyMap<PackageFileSet, string[]>
): IPackageLayout["nameRead"] {
  const byLocation = firstByKey(locations);
  const byTree = firstByKey(locations.map(([location, pkg]): [string, PackageFileSet] => [resolveVirtual(location), pkg]));
  const inPackage = (owner: [string, PackageFileSet], path: string): ReadName | undefined =>
    within(
      routes,
      owner[1],
      path
        .slice(owner[0].length + 1)
        .split(sep)
        .join("/")
    );
  return read => {
    const name = workName(dir, read);
    if (name !== undefined) {
      return { file: name };
    }
    const owner = enclosing(byLocation, read, dirname);
    if (owner !== undefined) {
      return inPackage(owner, read);
    }
    const physical = resolveVirtual(read);
    const tree = enclosing(byTree, physical, dirname);
    return tree === undefined ? undefined : inPackage(tree, physical);
  };
}

/** @return a map from each key of `entries` to the value of its first entry. */
function firstByKey<T>(entries: ReadonlyArray<[string, T]>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [key, value] of entries) {
    if (!map.has(key)) {
      map.set(key, value);
    }
  }
  return map;
}

/**
 * @return the key of `map` that is `path` or the nearest directory above it,
 * with its value; undefined where none is. `parent` takes a path to the
 * directory it is in, and returns a path unchanged at its root.
 */
function enclosing<T>(map: ReadonlyMap<string, T>, path: string, parent: (path: string) => string): [string, T] | undefined {
  for (let at = path; ;) {
    const value = map.get(at);
    if (value !== undefined) {
      return [at, value];
    }
    const up = parent(at);
    if (up === at) {
      return undefined;
    }
    at = up;
  }
}

/** Name `path` within `pkg` by the package's route; undefined where `pkg` has none. */
function within(routes: ReadonlyMap<PackageFileSet, string[]>, pkg: PackageFileSet, path: string): ReadName | undefined {
  const route = routes.get(pkg);
  return route === undefined ? undefined : { route, path, package: pkg };
}

/** @return `read`'s name under the working directory `dir`, or undefined where it lies outside it. */
function workName(dir: string, read: string): string | undefined {
  const name = relative(dir, read).split(sep).join("/");
  return name === "" || name === ".." || name.startsWith("../") || posix.isAbsolute(name) ? undefined : name;
}
