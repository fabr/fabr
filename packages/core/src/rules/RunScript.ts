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

/**
 * The script[run] rule: *define* a runnable plain shell script — the
 * ecosystem-neutral analogue of js_script. `deps` stage the install (their
 * filesets union flat — no package mounting, this is just files); `entry` is a
 * path *within* that install to launch with the shell; `args` are fixed leading
 * arguments. It yields a `RunnableFileSet` — the staged files plus how to launch
 * them — for `fabr run`, the generic `run` target, or a golden test to invoke.
 * It does not itself execute (executing a runnable and collecting output is the
 * generic `run` target's job).
 */

import { BUILD_OPERATION, TargetContext } from "../model/BuildContext";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { registerRule } from "./Registry";
import { RuleResult } from "./Types";

function defineScriptRunnable(context: TargetContext): Computable<RuleResult> {
  /* deps are ordinary build content — resolve them under build, not the run
   * operation this rule is selected by (constraints otherwise propagate). */
  return Computable.forAll(
    [
      context.getFileSources("deps", { [BUILD_OPERATION]: "build" }),
      context.getRequiredString("entry"),
      context.getProperty("args"),
    ],
    (depSources, entry, args) =>
      /* THE collection point: deps materialize jointly, so any carried external
       * requirements resolve with the target's own pins. */
      context.collect({ deps: depSources }).then(({ deps }) => {
        const install = FileSet.unionAll(...deps);
        return install.get(entry).then(file => {
          if (!file) {
            throw new Error(
              `script 'entry' (${entry}) is not present in the install — add the file (or its target) to 'deps'`
            );
          }
          return RunnableFileSet.forEntry(install, entry, args ? args.getValues() : [], "sh");
        });
      })
  );
}

registerRule("script", { [BUILD_OPERATION]: "run" }, defineScriptRunnable);
