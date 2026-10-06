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
 * The `node_modules` tree fabr generates for a tool that resolves through the
 * filesystem: one directory per package instance, linked together. The peer of
 * the PnP table in `PnPManifest.ts`.
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

/** What {@link collectPackages} found: the direct roots, every reachable
 * instance, one representative per node, and the loose sets. */
interface CollectedPackages {
  roots: PackageFileSet[];
  all: PackageFileSet[];
  byNode: Map<string, PackageFileSet>;
  loose: FileSet[];
  /** The installation's node name of an instance ({@link nodeNaming}). */
  nodeOf: (pkg: PackageFileSet) => string;
}

/** Every package instance a delivery reaches, keyed by node name, with the
 * loose (non-package) sets passed through. */
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
 * Assemblers only: within one installation a `packageId` names one package —
 * two instances under one id with different CONTENT are two packages claiming
 * one identity, which no layout can hold. The same package wired two ways is
 * two nodes, each with a directory of its own ({@link assembleNodeModules}).
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
 * and told apart by a hash of the whole. */
const INSTANCE_NAME_LIMIT = 120;

/**
 * The instance directory name of every node of an installation:
 * `<name>@<version>` (a scoped name's `/` written `+`), plus a suffix telling
 * the wirings apart where one package is installed wired several ways.
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
      wired.length > INSTANCE_NAME_LIMIT
        ? `${wired.slice(0, INSTANCE_NAME_LIMIT - 33)}_${hashString(wired).slice(0, 32)}`
        : wired
    );
  }
  return names;
}

/** A relative symlink at `from` naming `to`, both paths within one tree. */
function linkEntry(from: string, to: string): [string, IFile] {
  return [from, new SymlinkFile(posix.relative(posix.dirname(from), to))];
}

/**
 * Lay out the given (materialized) sources as node_modules contents, one
 * directory per package instance — pnpm's layout:
 *
 * ```
 * <name>                                    -> .fabr/<instance>/node_modules/<name>     each package in `sets`
 * .fabr/<instance>/node_modules/<name>/…                                                the instance's files
 * .fabr/<instance>/node_modules/<dep>       -> ../../<instance>/node_modules/<dep>      one per dependency edge
 * .fabr/node_modules/<name>                 -> ../<instance>/node_modules/<name>        one per name in the closure
 * ```
 *
 * An instance is a package wired one way ({@link nodeNaming}), so everything
 * requiring it loads the one directory, and a `<dep>` is the name its requirer
 * imports it by (the rename, for a renamed edge). Only the packages in `sets`
 * are visible from the top; `.fabr/node_modules` is what a package finds when
 * it imports a name it never declared — one instance per name, the packages in
 * `sets` excluded, claimed nearest the top first and then by instance name.
 * Anything in `sets` that isn't a package passes through unchanged. The
 * sources must have been materialized by the collection point before they get
 * here.
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
