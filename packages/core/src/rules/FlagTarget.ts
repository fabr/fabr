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

import { TargetContext } from "../context/index";
import { Computable } from "../core/Computable";
import { FileSource } from "../core/FileSet";
import { defineRule } from "./Types";
import { Flag } from "../core/Flag";

/**
 * The `flag` rule: a flag is a value, made where its target is resolved, never
 * built or cached.
 */
export default defineRule({
  value: true,
  evaluateResolved(context) {
    return createFlag(context);
  },
});

/**
 * Make the Flag a `flag` target is: a marker of the target's name among the
 * sources of a property that names it, which a rule reads back with
 * `getFlags`, implying the flags its `provides` names.
 */
function createFlag(context: TargetContext): Computable<FileSource> {
  const name = context.name;
  return context.getFlags("provides").then(provides => new Flag(name, provides));
}
