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

import type { FileSet, FileSource } from "./FileSet";
import { Name } from "./Name";
import { FabrError } from "./Errors";
import type { IProjection, Miss } from "./Reference";

/**
 * A source with projections still to apply, held as data. It is not a
 * FileSource: it has no files until the projections are applied, and the
 * consumer decides how they apply. The build context applies them through
 * `find`, entering archives (`applyProjections`); js_script's package entry
 * reads them instead as the choice of a bin of the runnable it builds.
 *
 * Made for a projection over a package or a runnable (the build context's
 * `projectSources`; other sources are projected at once), and by
 * {@link RepositoryRef.applyTo} for a projection over what a repository
 * resolves to. A collection applies its pending refs when it is
 * materialized, except for a property read with `getContainedFileProperty`,
 * whose consumer is handed the ref.
 */
export class FileSourceRef {
  constructor(
    /** The base the projections apply over: any FileSource, including a live
     * one (a filesystem query) whose contents are not yet known. {@link
     * FileSetRef} is the narrower case where they are. */
    public readonly source: FileSource,
    public readonly projections: ReadonlyArray<IProjection>,
    /**
     * Where set, the check of what applying this ref selected (see
     * {@link Miss}), whose error is thrown. It is set where the reference was
     * written, over the whole written name: a name with a glob anywhere may
     * select nothing, and a name with none may not. Whether a property must
     * have a value is a separate check, the rule's.
     */
    public readonly miss?: Miss
  ) {
    /* Give every ref at least one projection: `applyProjections` folds from
     * the first. */
    if (projections.length === 0) {
      throw new FabrError("internal: a FileSetRef must carry at least one projection");
    }
  }

  /** Get this ref with a further projection after its own. */
  public find(pattern: Name, prefix = ""): FileSourceRef {
    return new FileSourceRef(this.source, [...this.projections, { pattern, prefix }], this.miss);
  }
}

/**
 * A pending ref whose base is already materialized — a fetched fileset, a
 * built package, or a runnable.
 */
export class FileSetRef extends FileSourceRef {
  declare public readonly source: FileSet;

  constructor(source: FileSet, projections: ReadonlyArray<IProjection>, miss?: Miss) {
    super(source, projections, miss);
  }

  public find(pattern: Name, prefix = ""): FileSetRef {
    return new FileSetRef(this.source, [...this.projections, { pattern, prefix }], this.miss);
  }

  /**
   * Get the projected files under their projected names (see
   * {@link FileSet.select}). Throws the {@link miss} error where it gives one.
   */
  public select(): FileSet {
    const files = this.source.select(this.projections);
    this.checkMatched(!files.isEmpty());
    return files;
  }

  /**
   * Get where the projected files sit within the base: each one's path in the
   * base mapped to its projected name (see {@link FileSet.locate}). Throws the
   * {@link miss} error where it gives one.
   */
  public locate(): Map<string, string> {
    const located = this.source.locate(this.projections);
    this.checkMatched(located.size > 0);
    return located;
  }

  /** Throw the {@link miss} error for whether the ref `matched` anything,
   * where it gives one. */
  private checkMatched(matched: boolean): void {
    const err = this.miss?.(matched);
    if (err !== undefined) {
      throw err;
    }
  }
}
