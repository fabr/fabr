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

/**
 * The js_script[run] rule: *define* a runnable JavaScript program. `deps`
 * assemble the install (packages mount under `node_modules/<name>`, loose
 * filesets land at their own paths); `entry` is a path *within* that install to
 * launch under node (so a package's own script runs from its node_modules mount
 * and its relative imports resolve); `args` are fixed leading arguments. It
 * yields a `RunnableFileSet` — the assembled install plus how to launch it — for
 * `fabr run`, the generic `run` target, or a golden test to invoke. It does not
 * itself execute (executing a runnable and collecting output is the generic
 * `run` target's job).
 */

import {
  BUILD_OPERATION,
  Computable,
  FileSet,
  PackageFileSet,
  RuleRegistration,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import { assembleNodeModules } from "../JSPackage";

function defineJsRunnable(context: TargetContext): Computable<RuleResult> {
  /* deps are built packages — resolve them under build, not the run operation
   * this rule is selected by (constraints otherwise propagate). */
  return Computable.forAll(
    [
      context.getFileSources("deps", { [BUILD_OPERATION]: "build" }),
      context.getRequiredString("entry"),
      context.getProperty("args"),
    ],
    (depSources, entry, args) =>
      /* THE collection point: deps materialize jointly, so packages resolve
       * with the target's own pins. */
      context.collect({ deps: depSources }).then(({ deps }) => {
        /* Assemble the install: packages (and their closures) mount under
         * node_modules/<name>, loose filesets land at their own paths. */
        const packages = deps.filter((d): d is PackageFileSet => d instanceof PackageFileSet);
        const loose = deps.filter(d => !(d instanceof PackageFileSet));
        const install = FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules(packages) }), ...loose);
        return install.get(entry).then(file => {
          if (!file) {
            throw new Error(
              `js_script 'entry' (${entry}) is not present in the install — add the file (or its package) to 'deps'`
            );
          }
          return RunnableFileSet.forEntry(install, entry, args ? args.getValues() : [], "node");
        });
      })
  );
}

export const jsScriptRule: RuleRegistration = {
  type: "js_script",
  constraints: { [BUILD_OPERATION]: "run" },
  evaluate: defineJsRunnable,
};
