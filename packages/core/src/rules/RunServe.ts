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
 * The serve[run] rule: *define* a served program — a long-lived server (`tool`,
 * any runnable: a script/js_script target or an external package run via its
 * bin) decorated with the content it serves (`files`, staged at the install
 * root) and any support files (`deps`, unioned flat like a script's). It
 * yields a `RunnableFileSet` whose descriptor records the app persona: launch
 * cwd anchored at the staged install (the content is the program's world, so a
 * stock static server serves it with no path argument), and `files` as the
 * hot-swappable `served` partition — under `fabr run -w` a content-only change
 * is synced into the running server's staging area in place, while a program
 * change (tool/deps/args) restarts it. It does not itself execute.
 */

import { TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION, BUILD_OVERRIDE } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { RuleRegistration, RuleResult } from "./Types";

function defineServeRunnable(context: TargetContext): Computable<RuleResult> {
  /* deps/files are ordinary build content — resolve them under build, not the
   * run operation this rule is selected by (constraints otherwise propagate).
   * `tool` resolves apart under runOverrides (getRunnableProperty): a program
   * to execute on this machine, so its constraint set differs by design. */
  return Computable.forAll(
    [
      context.getRunnableProperty("tool"),
      context.getFileProperty("deps", BUILD_OVERRIDE),
      context.getFileProperty("files", BUILD_OVERRIDE),
      context.getProperty("args"),
    ],
    (tool, depSources, fileSources, args) =>
      /* THE collection point: deps and files materialize jointly, so any
       * carried external requirements resolve with the target's own pins. The
       * install is a sealed program, so resolution repairs are accepted (as
       * script/js_script). */
      context.collect({ deps: depSources, files: fileSources }, { resolutionMode: "permissive" }).then(({ deps, files }) => {
        const served = FileSet.unionAll(...files);
        /* A same-name collision between content and program is the ordinary
         * two-sided conflict, raised here by the union. */
        const install = FileSet.unionAll(tool, ...deps, served);
        return tool.withServedContent(install, served, args ? args.getValues() : []);
      })
  );
}

export const serveRunRule: RuleRegistration = {
  type: "serve",
  constraints: { [BUILD_OPERATION]: "run" },
  evaluate: defineServeRunnable,
};
