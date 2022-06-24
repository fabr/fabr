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

import { Computable } from "../core/Computable";
import { BuildConfig } from "../model/BuildModel";
import { ITargetDecl } from "../model/AST";
import { resolveTarget } from "./Resolve";
import { getTargetRule } from "./Registry";
import { Target } from "../model/Target";

/**
 * Resolve everything needed to actually be able to build the target and yield a resolved
 * version of the target schema. Assumes that the target has already been validated.
 *
 * @param decl
 * @param schema
 * @param config
 * @returns
 */
export function evaluateTarget(target: ITargetDecl, config: BuildConfig): Computable<Target> {
  const rule = getTargetRule(target.type)!; /* Target has been validated already */
  return resolveTarget(target, rule.schema, config).then(rule.evaluate);
}
