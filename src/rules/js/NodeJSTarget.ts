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

import { TargetContext } from "../../model/BuildContext";
import { Computable } from "../../core/Computable";
import { EMPTY_FILESET, FileSet } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";

/**
 * Execute a NodeJS script, yielding some set of output files.
 * @param spec
 * @param config
 */
function runNodeJs(config: TargetContext): Computable<FileSet> {
  return Computable.resolve(EMPTY_FILESET);
}

registerTargetRule("js_run", {}, runNodeJs);
