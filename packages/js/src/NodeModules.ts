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
 * The `node_modules` tree fabr generates for a tool that resolves packages
 * through the filesystem: one directory per package instance, linked together.
 * `PnPManifest.ts` makes the other layout, a PnP table.
 */

import { posix } from "path";
import {
  compareText,
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
    pkg.packages.sort((a, b) => compareText(a.packageName, b.packageName));

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
