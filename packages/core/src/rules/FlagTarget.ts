/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { TargetContext } from "../model/BuildContext";
import { Computable } from "../core/Computable";
import { FileSource } from "../core/FileSet";
import { registerTargetRule } from "./Registry";
import { Flag } from "../core/Flag";

/**
 * Execute an arbitrary script, yielding some set of output files.
 *
 * Note: this is the main execution point which nearly everything else
 * is built on top of, and can be called directly.
 *
 * Ideally this would be fully sandboxed, but for now we just kind of
 * fake it and hope the tools aren't _too_ badly behaved.
 * @param spec
 * @param config
 */
export function createFlag(context: TargetContext): Computable<FileSource> {
  const name = context.target.name;
  return context.getFlags("provides").then(provides => new Flag(name, provides));
}

registerTargetRule("flag", {}, createFlag);
