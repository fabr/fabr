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
 * ecosystem-neutral analogue of js_script. `entry` is the script FILE itself,
 * contributed to the install at its resolved name and launched with the shell;
 * `deps` stage any further support files (their filesets union flat — no
 * package mounting, this is just files); `args` are fixed leading arguments.
 * It yields a `RunnableFileSet` — the staged files plus how to launch them —
 * for `fabr run`, the generic `run` target, or a golden test to invoke. It
 * does not itself execute (executing a runnable and collecting output is the
 * generic `run` target's job).
 */

import { TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION, BUILD_OVERRIDE } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { RuleRegistration, RuleResult } from "./Types";

function defineScriptRunnable(context: TargetContext): Computable<RuleResult> {
  /* deps/entry are ordinary build content — resolve them under build, not the
   * run operation this rule is selected by (constraints otherwise propagate). */
  return Computable.forAll(
    [
      context.getFileProperty("deps", BUILD_OVERRIDE),
      context.getFileProperty("entry", BUILD_OVERRIDE),
      context.getProperty("args"),
    ],
    (depSources, entrySources, args) =>
      /* THE collection point: deps and entry materialize jointly, so any
       * carried external requirements resolve with the target's own pins. The
       * install is a sealed program, so resolution repairs are accepted (a
       * multi-version npm closure in a flat-unioned script install still
       * conflicts loudly at the union). */
      context.collect({ deps: depSources, entry: entrySources }, { resolutionMode: "permissive" }).then(({ deps, entry }) => {
        /* The entry is the script file itself — exactly one. (A shell script
         * has no notion of a package bin; a packaged tool is js_script's job.) */
        const entrySet = FileSet.unionAll(...entry);
        const names = [...entrySet].map(([name]) => name);
        if (names.length !== 1) {
          throw new Error(
            names.length === 0
              ? "script 'entry' resolved to no file — name the script file itself"
              : `script 'entry' resolved to ${names.length} files (${names.slice(0, 5).join(", ")}) — name exactly one`
          );
        }
        const install = FileSet.unionAll(...deps, entrySet);
        return RunnableFileSet.forEntry(install, names[0], args ? args.getValues() : [], "sh");
      })
  );
}

export const scriptRunRule: RuleRegistration = {
  type: "script",
  constraints: { [BUILD_OPERATION]: "run" },
  evaluate: defineScriptRunnable,
};
