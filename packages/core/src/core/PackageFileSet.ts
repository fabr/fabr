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

import { attachHelp, ConflictError } from "./Errors";
import { FileSet, IFile } from "./FileSet";
import { hashString } from "./FSWrapper";
import { IProvenanceStep } from "./Provenance";
/* Type-only: RepositoryRef values are only ever constructed/inspected on the
 * Repository side; carrying the type here must not create a module cycle. */
import type { RepositoryRef } from "./Repository";

/**
 * A FileSet that is a package; adds package name, version, and dependencies.
 *
 * `dependencies` is **the instance each of the package's edges binds to** — a
 * fact about the resolution, never a layout decision (layout is the consuming
 * assembler's):
 *
 * - A **built** package's edges are its DIRECT dependencies: built deps as
 *   PackageFileSets, external requirements as inert RepositoryRefs that each
 *   consumer's collection point resolves fresh against its own pins. The
 *   local build graph is acyclic by construction and the refs cut the
 *   external boundary.
 *
 * - A **materialized** external delivery carries, on every node, ALL of that
 *   node's dependency edges, each bound to the instance the resolution chose
 *   ({@link edgeBinding}'s answer) — the adjacency list of the resolved
 *   graph, distributed across the nodes, identical in every delivery. The
 *   graph may be **cyclic** (constructed via {@link PackageGraphBuilder}), so
 *   walkers must be cycle-safe; hoisting and private nesting are computed by
 *   the assembler from these complete facts, not read out of the structure.
 *
 * An edge's *name* is the delivered instance's `packageName`: an aliased
 * dependency is a restamped instance carrying the name its requirer knows it
 * by, so nothing downstream needs a separate edge-name slot.
 *
 * Content derivations (find/remap/minus/...) deliberately return plain
 * FileSets: once you reach inside a package, the result is just files.
 */
const NO_OPTIONAL_PEERS: ReadonlyMap<string, string> = new Map();

export class PackageFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    public readonly packageName: string,
    public readonly version?: string,
    public readonly dependencies: ReadonlyArray<PackageFileSet | RepositoryRef> = [],
    origin?: IProvenanceStep,
    /**
     * True for an instance delivered as a **private override** — a second
     * version of its package the resolution sanctioned, valid only nested
     * under the requirers that list it, never as a flat mount. Runtime-only
     * layout knowledge (like provenance, reconstructed every evaluation —
     * never serialized): an assembler nests a flagged instance and would
     * conflict on an unflagged same-name duplicate, which is two deliveries
     * disagreeing rather than one delivery's sanctioned divergence.
     */
    public readonly isNestedOverride: boolean = false,
    /**
     * The package's **optional peers** — dependencies it uses if its
     * installation has them and never pulls in itself — by the name it requires
     * each under, mapped to the version its resolution chose. Never wired by a
     * delivery: whether one is present is a fact about the installation, so the
     * collection point binds it there ({@link bindOptionalPeers}), and a
     * binding becomes an ordinary edge in `dependencies`.
     */
    public readonly optionalPeers: ReadonlyMap<string, string> = NO_OPTIONAL_PEERS
  ) {
    /* An existing FileSet passes straight through — the base shares its content
     * (already canonical) rather than copying and rechecking every name, which
     * is the whole cost of a restamp/re-wrap. Any other iterable is new names. */
    super(files instanceof FileSet ? files : new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  /** A package's delivered name — the name its requirers' edges call it by,
   * which is what a discovered-deps walk follows. Unversioned: see
   * {@link FileSet.name}. */
  public override get name(): string {
    return this.packageName;
  }

  /** This package's semantic `name@version` id — the identity that decides
   * flat-mount deduplication (object identity is deliberately meaningless:
   * every delivery wraps its own instances). */
  public get packageId(): string {
    return `${this.packageName}@${this.version ?? "*"}`;
  }

  public withOrigin(origin: IProvenanceStep): PackageFileSet {
    return new PackageFileSet(this, this.packageName, this.version, this.dependencies, origin, this.isNestedOverride, this.optionalPeers);
  }

  /**
   * @return a copy delivered under `packageName` instead of its own — the
   * identity a consumer lays it out under, and all that a rename changes. The
   * content, version and closure are shared: the package still resolves its own
   * dependencies among themselves under their real names, exactly as an npm
   * dependency alias (`"stream": "npm:stream-browserify@^3"`) leaves everything
   * but the mount point alone.
   */
  public withPackageName(packageName: string): PackageFileSet {
    return new PackageFileSet(this, packageName, this.version, this.dependencies, this.origin, this.isNestedOverride, this.optionalPeers);
  }

  public getDependency(name: string): PackageFileSet | RepositoryRef | undefined {
    return this.dependencies.find(dep => dep.name === name);
  }
}

/**
 * Flatten a FileSet list to everything it indirectly reaches: the given
 * members in order, then every further FileSet a package member's edges bind,
 * breadth-first, each instance once (an inert {@link RepositoryRef} edge has
 * no files to add). Loose members are retained, and only package members have
 * edges to follow. The closure walk behind {@link reachablePackages};
 * cycle-safe, as a delivered graph is genuinely cyclic.
 */
export function flattenFileSetArray(sets: ReadonlyArray<FileSet>): FileSet[] {
  const seen = new Set<FileSet>(sets);
  const result = [...sets];
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if (item instanceof PackageFileSet) {
      item.dependencies.forEach(dep => {
        if (dep instanceof FileSet && !seen.has(dep)) {
          result.push(dep);
          seen.add(dep);
        }
      });
    }
  }
  return result;
}

/** Every package the given sets reach — the sets' package members and,
 * recursively, every package their edges bind — the package view of
 * {@link flattenFileSetArray}: breadth-first, each instance once. Consumers
 * must not key on the order (they sort at use, or read the set). */
export function reachablePackages(sets: ReadonlyArray<FileSet>): PackageFileSet[] {
  return flattenFileSetArray(sets).filter((set): set is PackageFileSet => set instanceof PackageFileSet);
}

/**
 * One graph node's id-level line: identity, content hash, edge targets by id,
 * override flag. It names a node exactly when no id in its installation is
 * wired two ways — the common case, and what {@link nodeNaming} answers with
 * wherever that holds.
 */
export function packageNodeSignature(pkg: PackageFileSet): string {
  const edges = pkg.dependencies
    .filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet)
    .map(dep => dep.packageId)
    .sort();
  return `${pkg.packageId} ${pkg.toManifestHash()} [${edges.join(",")}]${pkg.isNestedOverride ? " nested" : ""}`;
}

/**
 * The node names of one installation — the graph reachable from `sets` — as a
 * function of an instance: two instances get one name exactly when they are
 * the same package wired the same way all the way down (cycles included), so
 * an installation may hold one `packageId` wired several ways and each wiring
 * is its own node, as npm nests and Yarn virtualizes.
 *
 * Computed by partition refinement: instances start grouped by their own label
 * (id, content, override flag) and a group splits wherever members' children,
 * by the name each is required under, fall in different groups — to the fixed
 * point, which is structural equality. Where an id ends in one group the name
 * is the id-level {@link packageNodeSignature}; an id wired several ways adds
 * a suffix that tells its wirings apart. Names are meaningful only within the
 * installation they were computed for.
 */
export function nodeNaming(sets: ReadonlyArray<FileSet>): (pkg: PackageFileSet) => string {
  const packages = reachablePackages(sets);
  const children = (pkg: PackageFileSet): PackageFileSet[] =>
    pkg.dependencies.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
  let color = new Map(packages.map(pkg => [pkg, `${pkg.packageId} ${pkg.toManifestHash()}${pkg.isNestedOverride ? " nested" : ""}`]));
  let groups = new Set(color.values()).size;
  for (;;) {
    const refined = new Map(
      packages.map(pkg => [
        pkg,
        hashString(`${color.get(pkg)}|${children(pkg).map(dep => `${dep.packageName}=${color.get(dep)}`).sort().join(",")}`),
      ])
    );
    const refinedGroups = new Set(refined.values()).size;
    if (refinedGroups === groups) {
      break;
    }
    color = refined;
    groups = refinedGroups;
  }
  /* An id is split when its instances ended in more than one group. */
  const groupsById = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const held = groupsById.get(pkg.packageId) ?? new Set<string>();
    held.add(color.get(pkg)!);
    groupsById.set(pkg.packageId, held);
  }
  return pkg => {
    const line = packageNodeSignature(pkg);
    const group = color.get(pkg);
    return group !== undefined && groupsById.get(pkg.packageId)!.size > 1 ? `${line} ~${hashString(group).slice(0, 16)}` : line;
  };
}

/**
 * Assert that two instances delivered under one {@link PackageFileSet.packageId}
 * really are the same node — same bytes, same edge bindings.
 *
 * The layout planner resolves the node, not the id, so it can hold two nodes
 * under one id; a physical install cannot, a tree giving a package one
 * directory. So this is the assemblers' precondition, and a conflict rather
 * than a pick.
 */
export function assertSamePackageNode(held: PackageFileSet, arrived: PackageFileSet): void {
  if (packageNodeSignature(held) !== packageNodeSignature(arrived)) {
    throw packageConflict(held, arrived);
  }
}

/**
 * The error for two instances under one {@link PackageFileSet.packageId} that
 * are not one node, said in the terms that tell a reader what to do. Different
 * CONTENT is two packages claiming one identity. Same content wired to
 * different dependencies is one package delivered twice, and the dependency
 * that differs is the thing to look at: a version divergence below it, or a
 * private override on one side only.
 */
export function packageConflict(held: PackageFileSet, arrived: PackageFileSet): Error {
  const side = (pkg: PackageFileSet, detail: string): { provenance?: IProvenanceStep; detail: string } => ({
    provenance: pkg.origin,
    detail,
  });
  if (held.toManifestHash() !== arrived.toManifestHash()) {
    return attachHelp(
      new ConflictError("packages", held.packageName, side(held, held.packageId), side(arrived, `${arrived.packageId}, different content`)),
      `two different packages both claim to be '${held.packageId}' — one installation holds one package per ` +
        "name and version; give them distinct versions, or align the two sources on one package"
    );
  }
  const differing = dependencyDifference(held, arrived);
  return attachHelp(
    new ConflictError("packages", held.packageName, side(held, dependencyText(held)), side(arrived, dependencyText(arrived))),
    `'${held.packageId}' is delivered twice with different dependencies (${differing}), and this installation ` +
      "holds one copy of it — align the dependency that differs"
  );
}

/** `name@version`, and what it depends on, for a conflict's side. */
function dependencyText(pkg: PackageFileSet): string {
  const deps = packageDependencyIds(pkg);
  const override = pkg.isNestedOverride ? " (a private override)" : "";
  return `${pkg.packageId}${override} depending on ${deps.length === 0 ? "nothing" : deps.join(", ")}`;
}

/** What differs between two instances' dependencies, by the name each is
 * required under. */
function dependencyDifference(a: PackageFileSet, b: PackageFileSet): string {
  const byName = (pkg: PackageFileSet): Map<string, string> =>
    new Map(pkg.dependencies.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet).map(dep => [dep.packageName, dep.packageId]));
  const left = byName(a);
  const right = byName(b);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences = names.flatMap(name => {
    const [x, y] = [left.get(name), right.get(name)];
    if (x === y) {
      return [];
    }
    return [x === undefined ? `${y} on one side only` : y === undefined ? `${x} on one side only` : `${x} against ${y}`];
  });
  if (a.isNestedOverride !== b.isNestedOverride) {
    differences.push("a private override on one side only");
  }
  return differences.join("; ") || "the same dependencies, bound to different copies of them";
}

function packageDependencyIds(pkg: PackageFileSet): string[] {
  return pkg.dependencies
    .filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet)
    .map(dep => dep.packageId)
    .sort();
}

/**
 * Constructs a possibly-**cyclic** graph of immutable {@link PackageFileSet}s.
 *
 * A package's `dependencies` are the instances its edges bind to, and real
 * dependency graphs have cycles (same-version mutual deps are common in npm) —
 * which depth-first immutable construction cannot produce. The builder is the
 * two-phase answer: every node is created first (its dependency list empty but
 * *retained*), edges are wired once the nodes they point at exist, and
 * {@link seal} freezes every list. Immutability is thus a property of the
 * **published** graph — a value never escapes the constructing scope unwired —
 * rather than of every intermediate state.
 *
 * Each node may be wired exactly once; sealing an incompletely-wired graph is
 * fine (a leaf simply has no dependencies). The builder is single-use.
 */
export class PackageGraphBuilder {
  private readonly pending = new Map<PackageFileSet, Array<PackageFileSet | RepositoryRef>>();
  private readonly wired = new Set<PackageFileSet>();
  private sealed = false;

  /** Create a node with an empty (unwired) dependency list. */
  public node(
    files: Iterable<[string, IFile]>,
    packageName: string,
    version?: string,
    origin?: IProvenanceStep,
    isNestedOverride?: boolean,
    optionalPeers?: ReadonlyMap<string, string>
  ): PackageFileSet {
    if (this.sealed) {
      throw new Error("PackageGraphBuilder is sealed");
    }
    /* The constructor stores the dependencies array by reference, which is
     * exactly what lets the builder fill it in after construction. */
    const dependencies: Array<PackageFileSet | RepositoryRef> = [];
    const pkg = new PackageFileSet(files, packageName, version, dependencies, origin, isNestedOverride ?? false, optionalPeers);
    this.pending.set(pkg, dependencies);
    return pkg;
  }

  /** Wire a node's dependencies (once — an empty wiring counts), to nodes of
   * this or any graph. */
  public wire(pkg: PackageFileSet, dependencies: ReadonlyArray<PackageFileSet | RepositoryRef>): void {
    const list = this.pending.get(pkg);
    if (list === undefined) {
      throw new Error(this.sealed ? "PackageGraphBuilder is sealed" : "not an unwired node of this builder");
    }
    if (this.wired.has(pkg)) {
      throw new Error(`${pkg.packageId} is already wired`);
    }
    this.wired.add(pkg);
    list.push(...dependencies);
  }

  /** Freeze every node's dependency list; the graph is now immutable. */
  public seal(): void {
    for (const list of this.pending.values()) {
      Object.freeze(list);
    }
    this.pending.clear();
    this.wired.clear();
    this.sealed = true;
  }
}
