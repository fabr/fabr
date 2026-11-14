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
  mapComputable,
  PackageFileSet,
  stringConfig,
  SymlinkFile,
  walkPackages,
} from "@fabr-build/core";
import { PNP_DATA_FILE, resolveVirtual, TREE_LINK } from "@fabr-build/js-tools";
import { assembleNodeModules, INSTANCE_AREA, packageDirectories } from "./NodeModules";
import { ISelfPackage, pnpManifestOf } from "./PnPManifest";

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
 */
export const PNP = "pnp";
export const NODE_MODULES = "node_modules";

/** The layout tokens, for a caller that validates one. */
export type NodeLayout = typeof PNP | typeof NODE_MODULES;

/** The action's packages laid out for a step, as its `layout` config says. */
export interface IPackageLayout {
  /** What the layout stages beside the step's own files: the `node_modules`
   *  tree at its mount, or the PnP table. */
  readonly files: FileSet;
  /** The packages the PnP table names in the tree pool, by each one's
   *  location relative to the working directory; empty for `node_modules`,
   *  whose packages are among {@link files}. */
  readonly trees: ReadonlyMap<string, PackageFileSet>;
  /** The packages among the action's `deps` themselves: what a lookup by name
   *  falls back to where the requirer's own dependencies do not answer it. */
  readonly members: ReadonlyArray<PackageFileSet>;
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
   */
  nameRead(read: string): ReadName | undefined;
}

/** How {@link IPackageLayout.nameRead} names a read: one of the step's own files, or a path within a package. */
export type ReadName = { file: string } | { route: string[]; path: string; package?: PackageFileSet };

/**
 * Lay out the action's `deps` as its `layout` config says, for the step working
 * in `dir`: a `node_modules` tree at `mount` (with a link from the sources'
 * own package name to the sources, where the action's config names one), or a
 * PnP table over the tree pool, each package's tree made with `ensureTree`
 * first. An install the action links in ({@link BuildAction.links}) is left out
 * of either. Throws where the `layout` config is neither token or `deps` is not
 * a list.
 */
export function layoutPackages(
  action: BuildAction,
  dir: string,
  ensureTree: (files: FileSet) => Computable<string>,
  mount = "node_modules"
): Computable<IPackageLayout> {
  const deps = depsInput(action);
  const self = selfPackage(action);
  const routes = routesOf(deps);
  const members = deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
  if (layoutConfig(action) === PNP) {
    const manifest = pnpManifestOf(deps, self, linkPattern(action));
    const files = FileSet.layout({ [PNP_DATA_FILE]: manifest.toFile() });
    const trees = new Map(manifest.packages.map((pkg): [string, PackageFileSet] => [manifest.mountOf(pkg), pkg]));
    /* Each package's location on this machine: its tree in the pool, or its
     * virtual location over that tree, as the runtime names a module in it. */
    const located = (pkg: PackageFileSet, tree: string): string =>
      join(dirname(tree), ...posix.relative(TREE_LINK, manifest.mountOf(pkg)).split("/"));
    return mapComputable(manifest.packages, pkg =>
      ensureTree(pkg).then((path): [string, PackageFileSet] => [located(pkg, path), pkg])
    ).then(locations => ({
      files,
      trees,
      members,
      nameRead: poolReadNamer(dir, locations, routes),
    }));
  }
  const files = FileSet.layout({ [mount]: [assembleNodeModules(deps), selfLink(self, mount)] });
  return Computable.resolve({
    files,
    trees: new Map(),
    members,
    nameRead: treeReadNamer(dir, mount, packageDirectories(deps), routes, members),
  });
}

/** Read the action's `layout` config, one of the {@link NodeLayout} tokens. */
function layoutConfig(action: BuildAction): NodeLayout {
  const layout = stringConfig(action, "layout");
  if (layout !== PNP && layout !== NODE_MODULES) {
    throw new FabrError(`Config 'layout' must be '${PNP}' or '${NODE_MODULES}', not '${layout}'`);
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
 * a package's instance directory is that package's (a module load records the
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
  const byDirectory = [...directories].map(([pkg, directory]): [string, PackageFileSet] => [`${mount}/${directory}/`, pkg]);
  return read => {
    const name = workName(dir, read);
    if (name === undefined) {
      return undefined;
    }
    if (!name.startsWith(`${mount}/`)) {
      return { file: name };
    }
    const owner = byDirectory.find(([prefix]) => name.startsWith(prefix));
    if (owner !== undefined) {
      return within(routes, owner[1], name.slice(owner[0].length));
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
 *  package's location (its virtual location where it has one, else its tree in
 *  the pool) is that package's. A physical path into a tree that only virtual
 *  locations name is the package at the first of them. */
function poolReadNamer(
  dir: string,
  locations: ReadonlyArray<[string, PackageFileSet]>,
  routes: ReadonlyMap<PackageFileSet, string[]>
): IPackageLayout["nameRead"] {
  const owning = (path: string): [string, PackageFileSet] | undefined =>
    locations.find(([location]) => path.startsWith(location + sep));
  return read => {
    const name = workName(dir, read);
    if (name !== undefined) {
      return { file: name };
    }
    const owner = owning(read);
    if (owner !== undefined) {
      return within(
        routes,
        owner[1],
        read
          .slice(owner[0].length + 1)
          .split(sep)
          .join("/")
      );
    }
    const physical = resolveVirtual(read);
    const tree = locations.find(([location]) => physical.startsWith(resolveVirtual(location) + sep));
    return tree === undefined
      ? undefined
      : within(
          routes,
          tree[1],
          physical
            .slice(resolveVirtual(tree[0]).length + 1)
            .split(sep)
            .join("/")
        );
  };
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
