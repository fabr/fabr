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

import { Name } from "./Name";
import { Computable } from "./Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "./FileSet";

/**
 * A Flag is a special target that has no contents and exists purely as a named marker.
 */
export class Flag implements FileSource {
  public name: string;
  public provides: Flag[];

  constructor(name: string, provides: Flag[]) {
    this.name = name;
    this.provides = provides;
  }

  find(name: Name): Computable<FileSet> {
    return Computable.resolve(EMPTY_FILESET);
  }
  get(name: string): Computable<IFile | undefined> {
    return Computable.resolve(undefined);
  }
}
