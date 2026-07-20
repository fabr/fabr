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

import { Computable } from "./Computable";
import { FileSet } from "./FileSet";
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
 * A resolved fileset with pending projections — deliberately NOT a FileSource
 * (like RepositoryRef): it cannot honestly promise files until the
 * projections are applied, and how they apply may depend on what the base
 * becomes — a converter reinterprets them (js_script's package entry replays
 * them as bin selection on the runnable it builds), while a plain file
 * consumer gets exactly the projected files via {@link manifest} (the
 * polymorphic `find` chain). Produced by resolveFileSource for a projection
 * landing on a target-output *package* (the one base type whose `find` erases
 * the information conversion needs; runnables' own `find` preserves theirs,
 * and plain/directory finds have nothing to preserve, so those stay eager),
 * and uniformly by materializeAll as the internal pending form of every
 * repository delivery (stampProvenance + projections). Manifested by default
 * at the standard delivery points (collection-point shaping, resolveName), so
 * ordinary consumers never see one; `keepProjected` hands a
 * projection-carrying ref to a reinterpreting consumer.
 */
export class FileSetRef {
  constructor(
    public readonly source: FileSet,
    public readonly projections: ReadonlyArray<IProjection>,
    /** When set, a projection that manifests to nothing is an error thrown
     * with this context (the property-value literal-must-resolve rule, whose
     * position is only known where the reference was written). */
    public readonly miss?: () => Error
  ) {}

  /** Narrowing a pending projection accumulates, RepositoryRef-style. */
  public find(pattern: Name, prefix = ""): FileSetRef {
    return new FileSetRef(this.source, [...this.projections, { pattern, prefix }], this.miss);
  }

  /** Apply the pending projections — each on the (possibly narrowed) base's
   * own terms via polymorphic `find` — yielding the plain projected result. */
  public manifest(): Computable<FileSet> {
    let result: Computable<FileSet> = Computable.resolve(this.source);
    for (const projection of this.projections) {
      result = result.then(files => files.find(projection.pattern, projection.prefix));
    }
    if (this.miss) {
      result = result.then(files => {
        if (files.isEmpty() && !this.projections.some(projection => projection.pattern.hasGlob())) {
          throw this.miss!();
        }
        return files;
      });
    }
    return result;
  }
}

/** Manifest any pending refs among `sources` — the settling step of a
 * consumer that collected with keepProjected but wants plain content for a
 * particular part. */
export function manifestAll(sources: ReadonlyArray<FileSet | FileSetRef>): Computable<FileSet[]> {
  return Computable.forAll(
    sources.map(source => (source instanceof FileSetRef ? source.manifest() : Computable.resolve(source))),
    (...sets: FileSet[]) => sets
  );
}
