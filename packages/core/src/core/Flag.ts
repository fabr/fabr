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

import { FileSet } from "./FileSet";
import { IProvenanceStep } from "./Provenance";

/**
 * A Flag is a named marker carried among a target's `deps` — it selects a
 * build-mode option (e.g. `ts/nostrict`) rather than contributing files. It **is
 * an (empty) FileSet**, so it rides the ordinary source / materialization paths
 * like any other dep: it survives materialization as itself (a rule reads it back
 * with `getFlags`) and mounts to nothing wherever a FileSet's content is consumed
 * (its inherited `find` returns no files). `provides` is its closure of implied
 * flags.
 */
export class Flag extends FileSet {
  public readonly name: string;
  public readonly provides: Flag[];

  constructor(name: string, provides: Flag[], origin?: IProvenanceStep) {
    super(new Map(), origin);
    this.name = name;
    this.provides = provides;
  }

  /** Preserve flag identity through provenance stamping (the PackageFileSet
   * pattern); content derivations deliberately fall back to a plain FileSet. */
  public withOrigin(origin: IProvenanceStep): Flag {
    return new Flag(this.name, this.provides, origin);
  }
}
