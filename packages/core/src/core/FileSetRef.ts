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

/**
 * One narrowing step of a reference: the pattern to match (against the names
 * produced by the previous step), and the prefix prepended to the matched
 * names — the written-name rule: `alias/path` keeps the written `alias/` in
 * result names, `alias:path` strips it (empty prefix).
 */
export interface IProjection {
  pattern: Name;
  prefix: string;
}

/**
 * A resolved source with pending projections — **pure data**: the suspended
 * remainder of a resolution walk, holding no behavior beyond accumulating
 * further narrowing. Deliberately NOT a FileSource (like RepositoryRef): it
 * cannot honestly promise files until the projections are applied, and how
 * they apply is the consumer's business — the RESOLVER resumes the walk
 * (BuildContext.manifest: the polymorphic `find` chain with archive descent,
 * expansion cached in the build cache), while a reinterpreting consumer gives
 * the projections its own meaning (js_script's package entry replays them as
 * bin selection on the runnable it builds — a raw `find` fold, no walk).
 * Produced by resolveFileSource for a projection landing on a target-output
 * *package* (the one base type whose `find` erases the information conversion
 * needs; runnables' own `find` preserves theirs, and plain/directory finds
 * have nothing to preserve, so those stay eager), and uniformly by the
 * delivery machinery as the pending form of every projected repository
 * delivery (stampProvenance + projections — see RepositoryRef.deliveredAs).
 * Ordinary consumers never see one: the model layer finishes pending refs as
 * its collections come back; a CONTAINED property instead hands the
 * pending ref to a reinterpreting consumer.
 */
export class FileSourceRef {
  constructor(
    /** The base the projections apply over: any FileSource, including a live
     * one (a filesystem query) whose contents are not yet known. {@link
     * FileSetRef} is the narrower case where they are. */
    public readonly source: FileSource,
    public readonly projections: ReadonlyArray<IProjection>,
    /**
     * When set, applying this ref to nothing is an error, thrown with this
     * context. Its presence IS the judgment, made once where the reference was
     * written (which is also the only place its position is known): **a name
     * containing a glob anywhere may match nothing; a wholly literal one may
     * not.** Deciding it there rather than per-application is what keeps the
     * rule about the *written name* — a projection step is literal far more
     * often than the name it belongs to, so re-deriving it from the projections
     * in hand would call a glob's empty result an error.
     *
     * A rule requiring a property to have a value is a separate judgment, made
     * by the rule: this one only says whether the reference itself resolved.
     */
    public readonly miss?: () => Error
  ) {
    /* A ref exists to suspend projections; every construction site supplies at
     * least one, and the applier (BuildContext.manifest) folds from the first.
     * Enforced here so a violation fails at construction, not as a stray base. */
    if (projections.length === 0) {
      throw new Error("internal: a FileSetRef must carry at least one projection");
    }
  }

  /** Narrowing a pending projection accumulates, RepositoryRef-style. */
  public find(pattern: Name, prefix = ""): FileSourceRef {
    return new FileSourceRef(this.source, [...this.projections, { pattern, prefix }], this.miss);
  }
}

/**
 * A pending ref whose base is already materialized — a delivered fileset or a
 * built package. 
 */
export class FileSetRef extends FileSourceRef {
  public declare readonly source: FileSet;

  constructor(source: FileSet, projections: ReadonlyArray<IProjection>, miss?: () => Error) {
    super(source, projections, miss);
  }

  public find(pattern: Name, prefix = ""): FileSetRef {
    return new FileSetRef(this.source, [...this.projections, { pattern, prefix }], this.miss);
  }

  /**
   * The projected files under their projected names — the *extract* reading of
   * this ref (see {@link FileSet.select}).
   */
  public select(): FileSet {
    const files = this.source.select(this.projections);
    this.checkMatched(!files.isEmpty());
    return files;
  }

  /**
   * Where the projected members sit **within the base**, container-relative path
   * → projected name — the *contained* reading of this ref (see
   * {@link FileSet.locate}).
   */
  public locate(): Map<string, string> {
    const located = this.source.locate(this.projections);
    this.checkMatched(located.size > 0);
    return located;
  }

  /** The literal-must-resolve rule, once for every way of applying a ref.
   * Carrying a `miss` IS the judgment — made once, over the whole written name,
   * by whoever built the ref — so there is nothing to re-decide here. */
  private checkMatched(matched: boolean): void {
    if (!matched && this.miss) {
      throw this.miss();
    }
  }
}
