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
 * The `node_modules` trees fabr generates for a tool that resolves packages
 * through the filesystem: one directory per package instance, linked together,
 * or npm's hoisted tree, with no links. `PnPManifest.ts` makes the other
 * layout, a PnP table.
 */

import { posix } from "path";
import {
  compareText,
  FabrError,
  FileSet,
  hashString,
  IFile,
  nodeNaming,
  packageConflict,
  packageNameConflict,
  PackageFileSet,
  SymlinkFile,
} from "@fabr-build/core";

/** The packages {@link collectPackages} found. */
interface CollectedPackages {
  /** The packages among the given sets themselves. */
  roots: PackageFileSet[];
  /** Every package object reachable from the roots, each once. */
  all: PackageFileSet[];
  /** One package per node name, the first reached. */
  byNode: Map<string, PackageFileSet>;
  /** The given sets that are not packages. */
  loose: FileSet[];
  /** The installation's node name of an instance ({@link nodeNaming}). */
  nodeOf: (pkg: PackageFileSet) => string;
}

/** Collect every package the given sets reach through their dependencies,
 * keyed by node name, with the sets that are not packages kept apart. */
function collectPackages(sets: FileSet[]): CollectedPackages {
  const nodeOf = nodeNaming(sets);
  const byNode = new Map<string, PackageFileSet>();
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
    const node = nodeOf(pkg);
    if (!byNode.has(node)) {
      byNode.set(node, pkg);
    }
    for (const dep of pkg.packages) {
      collect(dep);
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
  return { roots, all, byNode, loose, nodeOf };
}

/**
 * Throw a package conflict where two nodes share a `packageId` but differ in
 * content. Two nodes with one id and one content (the same package with its
 * dependencies bound differently) are allowed: each gets a directory of its
 * own ({@link assembleNodeModules}).
 */
function assertOneContentPerId(collected: CollectedPackages): void {
  const byId = new Map<string, PackageFileSet>();
  for (const pkg of collected.byNode.values()) {
    const held = byId.get(pkg.packageId);
    if (held === undefined) {
      byId.set(pkg.packageId, pkg);
    } else if (held.toManifestHash() !== pkg.toManifestHash()) {
      throw packageConflict(held, pkg);
    }
  }
}

/** The directory, within node_modules, holding one directory per package
 * instance of an install. A dot-directory, so never a resolvable package name. */
export const INSTANCE_AREA = ".fabr";

/** The longest instance directory name written in full; a longer one is cut
 * short and ends in a hash of the whole name. */
const INSTANCE_NAME_LIMIT = 120;

/**
 * Name the instance directory of every node of an installation, by node name:
 * `<name>@<version>` (`<name>` alone for a package with no version; a scoped
 * name's `/` written `+`), with `_` and a hash of the node name added where one
 * `packageId` has several nodes (its dependencies bound differently).
 */
function instanceNames({ byNode }: CollectedPackages): Map<string, string> {
  const wirings = new Map<string, number>();
  for (const pkg of byNode.values()) {
    wirings.set(pkg.packageId, (wirings.get(pkg.packageId) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const [node, pkg] of byNode) {
    const plain = (pkg.version === undefined ? pkg.packageName : `${pkg.packageName}@${pkg.version}`).replace(/\//g, "+");
    const wired = wirings.get(pkg.packageId)! > 1 ? `${plain}_${hashString(node).slice(0, 12)}` : plain;
    names.set(
      node,
      wired.length > INSTANCE_NAME_LIMIT ? `${wired.slice(0, INSTANCE_NAME_LIMIT - 33)}_${hashString(wired).slice(0, 32)}` : wired
    );
  }
  return names;
}

/**
 * Get where {@link assembleNodeModules} lays out each package of the closure of
 * `sets`: the directory, within node_modules, holding its files.
 */
export function packageDirectories(sets: FileSet[]): Map<PackageFileSet, string> {
  const collected = collectPackages(sets);
  const instance = instanceNames(collected);
  return new Map(
    collected.all.map(pkg => [pkg, `${INSTANCE_AREA}/${instance.get(collected.nodeOf(pkg))!}/node_modules/${pkg.packageName}`])
  );
}

/** Make a relative symlink at `from` naming `to`, both paths within one tree. */
function linkEntry(from: string, to: string): [string, IFile] {
  return [from, new SymlinkFile(posix.relative(posix.dirname(from), to))];
}

/**
 * Lay out the given sets as the contents of a `node_modules` directory, one
 * directory per package instance, as pnpm does:
 *
 * ```
 * <name>                                    -> .fabr/<instance>/node_modules/<name>     each package in `sets`
 * .fabr/<instance>/node_modules/<name>/…                                                the instance's files
 * .fabr/<instance>/node_modules/<dep>       -> ../../<instance>/node_modules/<dep>      one per dependency
 * .fabr/node_modules/<name>                 -> ../<instance>/node_modules/<name>        one per name in the closure
 * ```
 *
 * An instance is one node ({@link nodeNaming}): a package with its
 * dependencies bound one way, so everything that requires that node loads the
 * one directory. A `<dep>` link is named as the requirer imports the package
 * (the renamed name, for a renamed dependency). Only the packages in `sets` are
 * linked at the top. `.fabr/node_modules` is what node's directory walk finds
 * for a name a package imports without declaring it: one link per name in the
 * closure, except the names of the packages in `sets`, each to the first
 * instance of that name a breadth-first walk from the top reaches (each level
 * taken in instance-name order).
 * Sets that are not packages are unioned in unchanged.
 *
 * The packages must be materialized (each dependency a PackageFileSet). Throws
 * a package conflict where two nodes share a `packageId` with different
 * content, and a package-name conflict where two packages in `sets` share a
 * name but are different nodes.
 */
export function assembleNodeModules(sets: FileSet[]): FileSet {
  const collected = collectPackages(sets);
  assertOneContentPerId(collected);
  const { roots, byNode, nodeOf } = collected;
  const instance = instanceNames(collected);
  const homeOf = (pkg: PackageFileSet, name: string): string => `${INSTANCE_AREA}/${instance.get(nodeOf(pkg))!}/node_modules/${name}`;
  const dependenciesOf = (pkg: PackageFileSet): PackageFileSet[] =>
    [...pkg.packages].sort((a, b) => compareText(a.packageName, b.packageName));

  const top = new Map<string, PackageFileSet>();
  for (const root of roots) {
    const held = top.get(root.packageName);
    if (held !== undefined && nodeOf(held) !== nodeOf(root)) {
      throw packageNameConflict(held, root);
    }
    top.set(root.packageName, root);
  }

  const links = new Map<string, IFile>();
  const mounts: FileSet[] = [];
  for (const pkg of byNode.values()) {
    mounts.push(pkg.mountedAt(homeOf(pkg, pkg.packageName)));
    for (const dep of dependenciesOf(pkg)) {
      if (dep.packageName !== pkg.packageName) {
        links.set(...linkEntry(homeOf(pkg, dep.packageName), homeOf(dep, dep.packageName)));
      }
    }
  }
  for (const [name, root] of top) {
    links.set(...linkEntry(name, homeOf(root, name)));
  }

  /* Breadth-first from the top, each level in instance-name order. */
  const hoisted = new Set(top.keys());
  const visited = new Set<string>();
  let level = [...top.values()];
  while (level.length > 0) {
    const next: PackageFileSet[] = [];
    const ordered = level
      .filter(pkg => !visited.has(nodeOf(pkg)) && visited.add(nodeOf(pkg)))
      .sort((a, b) => compareText(instance.get(nodeOf(a))!, instance.get(nodeOf(b))!));
    for (const pkg of ordered) {
      for (const dep of dependenciesOf(pkg)) {
        if (!hoisted.has(dep.packageName)) {
          hoisted.add(dep.packageName);
          links.set(...linkEntry(`${INSTANCE_AREA}/node_modules/${dep.packageName}`, homeOf(dep, dep.packageName)));
        }
        next.push(dep);
      }
    }
    level = next;
  }
  return FileSet.unionAll(...mounts, new FileSet(links), ...collected.loose);
}

/**
 * @return the package directory node finds for an import of `name` from the
 * package directory `from` of a tree laid out by {@link hoistedPlacements} (or
 * from the top, where `from` is undefined): `<dir>/node_modules/<name>` for
 * each directory from `from` up, then `<name>` at the top; undefined where
 * `held` holds none of them.
 */
function hoistedLookup(held: (directory: string) => boolean, from: string | undefined, name: string): string | undefined {
  for (let at = from; at !== undefined;) {
    const candidate = `${at}/node_modules/${name}`;
    if (held(candidate)) {
      return candidate;
    }
    const up = at.lastIndexOf("/node_modules/");
    at = up < 0 ? undefined : at.slice(0, up);
  }
  return held(name) ? name : undefined;
}

/**
 * Place every package of the closure of `sets` in a `node_modules` tree with
 * no links, as npm's hoisted install does. The top level holds one package of
 * each name in the closure: the packages in `sets`, then, for each other name,
 * the first package of that name a breadth-first walk from them reaches (each
 * level taken in node-name order, each package's dependencies in name order).
 * Then, breadth-first from the top, each package's dependencies are placed
 * where its lookup finds them: nothing is placed for a dependency the lookup
 * already finds bound as its edge, or that the package bundles (ships under
 * its own `node_modules`); one the lookup finds another package of the name
 * for is placed in the highest `node_modules` below that package where no
 * lookup already made has passed through without finding the name, at worst
 * the requirer's own. Every edge then resolves to the package it is bound to.
 * Where a directory would hold the package a directory above it holds, with
 * every name's lookup from the two finding the same packages, the placement is
 * made again with each such dependency in its requirer's own `node_modules`.
 * With `reserved`, the top holds no package of that name (the name of sources
 * linked there beside the tree), and a package of it is placed below.
 *
 * @return each package directory, relative to the tree's top, with the
 * package placed there. Throws a package conflict where two nodes share a
 * `packageId` with different content, a package-name conflict where two
 * packages in `sets` share a name but are different nodes, and an error where
 * the second placement repeats too.
 */
export function hoistedPlacements(sets: FileSet[], reserved?: string): Map<string, PackageFileSet> {
  const collected = collectPackages(sets);
  assertOneContentPerId(collected);
  const top = topLevelPlacements(collected, reserved);
  const highest = nestedPlacements(top, collected.nodeOf, true, reserved);
  if (highest instanceof Map) {
    return highest;
  }
  const nested = nestedPlacements(top, collected.nodeOf, false, reserved);
  if (nested instanceof Map) {
    return nested;
  }
  throw new FabrError(
    `Can't lay out ${nested.pkg.packageId} without links: its dependencies lead back to it with every package name ` +
      `resolving as it does above it, so the tree would not end (at node_modules/${nested.at})`
  );
}

/** @return a package's dependencies in name order. */
function dependenciesOf(pkg: PackageFileSet): PackageFileSet[] {
  return [...pkg.packages].sort((a, b) => compareText(a.packageName, b.packageName));
}

/**
 * Choose the top level of a hoisted tree ({@link hoistedPlacements}): one
 * package of each name in the closure but `reserved`, keyed by name.
 */
function topLevelPlacements({ roots, nodeOf }: CollectedPackages, reserved: string | undefined): Map<string, PackageFileSet> {
  const placements = new Map<string, PackageFileSet>();
  for (const root of roots) {
    const held = placements.get(root.packageName);
    if (held !== undefined && nodeOf(held) !== nodeOf(root)) {
      throw packageNameConflict(held, root);
    }
    placements.set(root.packageName, root);
  }
  const visited = new Set<string>();
  for (let level = [...placements.values()]; level.length > 0;) {
    const next: PackageFileSet[] = [];
    const ordered = level
      .filter(pkg => !visited.has(nodeOf(pkg)) && visited.add(nodeOf(pkg)))
      .sort((a, b) => compareText(nodeOf(a), nodeOf(b)));
    for (const pkg of ordered) {
      for (const dep of dependenciesOf(pkg)) {
        if (!placements.has(dep.packageName) && dep.packageName !== reserved) {
          placements.set(dep.packageName, dep);
        }
        next.push(dep);
      }
    }
    level = next;
  }
  return placements;
}

/** The pattern of a bundled package's directory within a package: its name under `node_modules/`. */
const BUNDLED = /^node_modules\/((?:@[^/]+\/)?[^/@.][^/]*)\//;

/** @return the names of the packages `pkg` bundles: those it ships files of under `node_modules/<name>/`. */
function bundledNames(pkg: PackageFileSet): Set<string> {
  const names = new Set<string>();
  for (const [name] of pkg) {
    const match = BUNDLED.exec(name);
    if (match !== null) {
      names.add(match[1]);
    }
  }
  return names;
}

/** @return the package directory holding the `node_modules` that `directory` is in, or undefined at the top. */
function holderOf(directory: string): string | undefined {
  const up = directory.lastIndexOf("/node_modules/");
  return up < 0 ? undefined : directory.slice(0, up);
}

/**
 * @return the placed package that bundles a package at `directory`, or
 * undefined where none does; `bundles` memoises each package's bundled names.
 */
function bundlerOf(
  placements: ReadonlyMap<string, PackageFileSet>,
  bundles: Map<PackageFileSet, Set<string>>,
  directory: string
): PackageFileSet | undefined {
  const up = holderOf(directory);
  const holder = up === undefined ? undefined : placements.get(up);
  if (holder === undefined) {
    return undefined;
  }
  let names = bundles.get(holder);
  if (names === undefined) {
    names = bundledNames(holder);
    bundles.set(holder, names);
  }
  return names.has(directory.slice(up!.length + "/node_modules/".length)) ? holder : undefined;
}

/**
 * Place each package's dependencies beneath the `top` of a hoisted tree
 * ({@link hoistedPlacements}): with `highest`, a dependency the lookup finds
 * another package of the name for goes in the highest `node_modules` it can,
 * else in its requirer's own. The top holds no package named `reserved`.
 *
 * @return the placements, or the first directory that holds the package a
 * directory above it holds where every name's lookup from the two finds the
 * same packages, with its package: without `highest`, what is placed beneath
 * it then repeats without end.
 */
function nestedPlacements(
  top: ReadonlyMap<string, PackageFileSet>,
  nodeOf: (pkg: PackageFileSet) => string,
  highest: boolean,
  reserved: string | undefined
): Map<string, PackageFileSet> | { at: string; pkg: PackageFileSet } {
  const placements = new Map(top);
  const names = reserved === undefined ? [...top.keys()] : [...top.keys(), reserved];
  const bundles = new Map<PackageFileSet, Set<string>>();
  const held = (directory: string): boolean => placements.has(directory) || bundlerOf(placements, bundles, directory) !== undefined;
  /* What a directory holds, as a lookup finds it: a placed node, or a bundle of a node. */
  const heldAt = (directory: string): string => {
    const placed = placements.get(directory);
    return placed !== undefined
      ? nodeOf(placed)
      : `bundled\0${nodeOf(bundlerOf(placements, bundles, directory)!)}\0${directory.slice(holderOf(directory)!.length)}`;
  };
  const childOf = (level: string | undefined, name: string): string => (level === undefined ? name : `${level}/node_modules/${name}`);
  /* Each level's names that a lookup made has passed through without finding: a
   * package placed there under such a name would change what that lookup finds. */
  const passed = new Map<string, Set<string>>();
  const view = (directory: string): string[] =>
    names.map(name => {
      const found = hoistedLookup(held, holderOf(directory), name);
      return found === undefined ? "" : heldAt(found);
    });
  const repeats = (at: string, pkg: PackageFileSet): boolean => {
    let seen: string[] | undefined;
    for (let above = holderOf(at); above !== undefined; above = holderOf(above)) {
      if (nodeOf(placements.get(above)!) === nodeOf(pkg)) {
        seen ??= view(at);
        const repeated = view(above);
        if (repeated.every((node, index) => node === seen![index])) {
          return true;
        }
      }
    }
    return false;
  };

  const queue = [...top.keys()].sort(compareText);
  for (let next = 0; next < queue.length; next++) {
    const at = queue[next];
    const pkg = placements.get(at)!;
    if (repeats(at, pkg)) {
      return { at, pkg };
    }
    for (const dep of dependenciesOf(pkg)) {
      const name = dep.packageName;
      const levels: Array<string | undefined> = [];
      for (let level: string | undefined = at; level !== undefined; level = holderOf(level)) {
        levels.push(level);
      }
      levels.push(undefined);
      /* Nothing holds a reserved name at the top: the sources' link does. */
      const foundAt = levels.findIndex(level => held(childOf(level, name)));
      const found = foundAt < 0 ? levels.length - 1 : foundAt;
      const answer = foundAt < 0 ? undefined : placements.get(childOf(levels[found], name));
      /* A bundle answers only its own package's lookup. */
      const answered = answer === undefined ? foundAt === 0 : nodeOf(answer) === nodeOf(dep);
      let landing = found;
      if (!answered) {
        landing = 0;
        for (let level = found - 1; highest && level > 0; level--) {
          if (!passed.get(levels[level]!)?.has(name)) {
            landing = level;
            break;
          }
        }
        const placed = childOf(levels[landing], name);
        placements.set(placed, dep);
        queue.push(placed);
      }
      for (let level = 0; level < landing; level++) {
        const through = passed.get(levels[level]!) ?? new Set<string>();
        passed.set(levels[level]!, through.add(name));
      }
    }
  }
  return placements;
}

/**
 * Lay out the given sets as the contents of a `node_modules` directory with no
 * links: each package's files at each directory `placements` places it
 * ({@link hoistedPlacements}), and the sets that are not packages unioned in
 * unchanged. The packages must be materialized. Throws as
 * {@link hoistedPlacements} does.
 */
export function assembleHoistedNodeModules(
  sets: FileSet[],
  placements: ReadonlyMap<string, PackageFileSet> = hoistedPlacements(sets)
): FileSet {
  const mounts = [...placements].map(([directory, pkg]) => pkg.mountedAt(directory));
  return FileSet.unionAll(...mounts, ...sets.filter(set => !(set instanceof PackageFileSet)));
}
