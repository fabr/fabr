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
import { RuleRegistration } from "./Types";
import { Flag } from "../core/Flag";

/**
 * Flags are inert markers that ride the dependency graph for rules to
 * interpret (platform modes and the like): the rule is an evaluate-less
 * resolve producing the Flag value — flags are never "built" and never touch
 * the cache.
 */
export function createFlag(context: TargetContext): Computable<FileSource> {
  const name = context.name;
  return context.getFlags("provides").then(provides => new Flag(name, provides));
}

export const flagRule: RuleRegistration = { type: "flag", constraints: {}, evaluate: createFlag };
