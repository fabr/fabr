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

import { FileSet, IFile } from "./FileSet";
import { IProvenanceStep } from "./Provenance";
/* Type-only: RepositoryRef values are only ever constructed/inspected on the
 * Repository side; carrying the type here must not create a module cycle. */
import type { RepositoryRef } from "./Repository";

/**
 * A FileSet that is a package; adds package name, version, and dependencies.
 *
 * `dependencies` is **the instance each of the package's edges binds to** — a
 * fact about the resolution, never a layout decision (layout is the consuming
 * assembler's, see DESIGN-package-placement.md):
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
    public readonly isNestedOverride: boolean = false
  ) {
    /* An existing FileSet passes straight through — the base shares its content
     * (already canonical) rather than copying and rechecking every name, which
     * is the whole cost of a restamp/re-wrap. Any other iterable is new names. */
    super(files instanceof FileSet ? files : new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  /** This package's semantic `name@version` id — the identity that decides
   * flat-mount deduplication (object identity is deliberately meaningless:
   * every delivery wraps its own instances). */
  public get packageId(): string {
    return `${this.packageName}@${this.version ?? "*"}`;
  }

  public withOrigin(origin: IProvenanceStep): PackageFileSet {
    return new PackageFileSet(this, this.packageName, this.version, this.dependencies, origin, this.isNestedOverride);
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
    return new PackageFileSet(this, packageName, this.version, this.dependencies, this.origin, this.isNestedOverride);
  }
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
    isNestedOverride?: boolean
  ): PackageFileSet {
    if (this.sealed) {
      throw new Error("PackageGraphBuilder is sealed");
    }
    /* The constructor stores the dependencies array by reference, which is
     * exactly what lets the builder fill it in after construction. */
    const dependencies: Array<PackageFileSet | RepositoryRef> = [];
    const pkg = new PackageFileSet(files, packageName, version, dependencies, origin, isNestedOverride ?? false);
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
