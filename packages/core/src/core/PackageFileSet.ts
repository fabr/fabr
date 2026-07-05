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
 * Dependencies are carried as either direct PackageFileSets (for built dependencies)
 * or RepositoryRef for external dependencies (which a consumer may re-resolve)
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

  public withOrigin(origin: IProvenanceStep): PackageFileSet {
    return new PackageFileSet(this, this.packageName, this.version, this.dependencies, origin);
  }
}
