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
import { registerRule } from "./Registry";
import { createExecAction } from "./ExecAction";
import { BuildAction } from "./Types";

/**
 * Run an arbitrary command over staged inputs, yielding output files: resolve
 * gathers the declared inputs and yields an `exec` action.
 *
 * (Still a stub in spirit: no sandboxing, and the schema is minimal.)
 */
export function runGeneric(context: TargetContext): Computable<BuildAction> {
  return Computable.forAll(
    [context.getFileSet("inputs"), context.getRequiredString("cmd")],
    (inputs, cmd) => createExecAction(inputs, cmd.split(/\s+/), "**", "script")
  );
}

registerRule("script", { BUILD_OPERATION: "build" }, runGeneric);
