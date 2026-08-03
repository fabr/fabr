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

import { FileSource } from "./FileSet";
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
 * A resolved fileset with pending projections — **pure data**: the suspended
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
 * its collections come back; `collect`'s `keepProjected` instead hands the
 * pending ref to a reinterpreting consumer.
 */
export class FileSetRef {
  constructor(
    /** The base the projections apply over. Any FileSource: a delivered set,
     * a built package, or — for an eagerly-applied suspension (the resolver's
     * container/filesystem arms, which construct the ref and manifest it in
     * the same breath) — a live source such as a filesystem query. */
    public readonly source: FileSource,
    public readonly projections: ReadonlyArray<IProjection>,
    /** When set, a projection that manifests to nothing is an error thrown
     * with this context (the property-value literal-must-resolve rule, whose
     * position is only known where the reference was written). */
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
  public find(pattern: Name, prefix = ""): FileSetRef {
    return new FileSetRef(this.source, [...this.projections, { pattern, prefix }], this.miss);
  }
}
