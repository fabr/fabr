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
 * `dependencies` has two regimes, reflecting two classes of dependency graph:
 *
 * - A **built** package carries its DIRECT dependencies: built deps as
 *   (recursively structured) PackageFileSets, external requirements as inert
 *   RepositoryRefs that each consumer's collection point resolves fresh
 *   against its own pins. Recursive structure is sound here because the local
 *   build graph is acyclic by construction and the refs cut recursion at the
 *   external boundary.
 *
 * - A **materialized** external delivery (a resolved, pinned closure) carries
 *   its closure's flat-mount winners — one member per package name — and each
 *   member carries, as its own dependencies, only its private VERSION
 *   OVERRIDES: the (permissive-delivery) copies that diverge from the flat
 *   winner of their name, recursively. Everything not listed resolves to the
 *   flat winner implicitly — the same acyclic tree-encoding of a (possibly
 *   cyclic) dependency graph that node_modules itself is, so the structure
 *   stays a finite tree of immutable values. A strict delivery has no
 *   overrides (single version per name enforced), so its members are flat and
 *   empty, and the two regimes need no marker: an assembler mounts winners
 *   flat and nests exactly the listed non-winners (see assembleNodeModules).
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
    origin?: IProvenanceStep
  ) {
    super(new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  /** This package's semantic `name@version` id — the identity that decides
   * flat-mount deduplication (object identity is deliberately meaningless:
   * every delivery wraps its own instances). */
  public get packageId(): string {
    return `${this.packageName}@${this.version ?? "*"}`;
  }

  public withOrigin(origin: IProvenanceStep): PackageFileSet {
    return new PackageFileSet(this, this.packageName, this.version, this.dependencies, origin);
  }
}
