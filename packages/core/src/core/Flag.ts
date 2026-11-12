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
 * A named marker among a target's `deps` that selects a build-mode option
 * (`ts/no_strict`) and contributes no files. It is an empty FileSet: it comes
 * through materialization as itself, where a rule reads it back with
 * `getFlags`, and adds nothing wherever a FileSet's files are used.
 * `provides` is the flags it implies, each with its own `provides`.
 */
export class Flag extends FileSet {
  private readonly flagName: string;
  public readonly provides: Flag[];

  constructor(name: string, provides: Flag[], origin?: IProvenanceStep) {
    super(new Map(), origin);
    this.flagName = name;
    this.provides = provides;
  }

  /** The flag's name. */
  public override get name(): string {
    return this.flagName;
  }

  /** @return a copy of this flag carrying `origin`. A derivation of its
   * content (`find`, `rename`, …) is a plain FileSet. */
  public withOrigin(origin: IProvenanceStep): Flag {
    return new Flag(this.name, this.provides, origin);
  }
}
