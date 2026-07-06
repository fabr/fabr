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
 * The js_script[build] rule: run a JavaScript file under node — the JS analogue
 * of the generic `script` target. `deps` builds the run directory (packages
 * mount under `node_modules/<name>`, loose filesets land at their own paths);
 * `entry` is a path *within* that run directory, so a package's own script runs
 * from its node_modules mount and its relative imports resolve. `args` are
 * passed through verbatim; the declared `output` pattern is collected as the
 * result.
 */

import {
  BUILD_OPERATION,
  Computable,
  createExecAction,
  FileSet,
  PackageFileSet,
  registerRule,
  RuleResult,
  TargetContext,
} from "@fabr/core";
import { assembleNodeModules } from "../JSPackage";

function runJsScript(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSources("deps"),
      context.getRequiredString("entry"),
      context.getProperty("args"),
      context.getProperty("output"),
    ],
    (depSources, entry, args, output) =>
      /* THE collection point: deps materialize jointly, so packages resolve
       * with the target's own pins. */
      context.collect({ deps: depSources }).then(({ deps }) => {
        /* Build the run directory: packages (and their closures) mount under
         * node_modules/<name>, loose filesets land at their own paths. The
         * script is just a path within it. */
        const packages = deps.filter((d): d is PackageFileSet => d instanceof PackageFileSet);
        const loose = deps.filter(d => !(d instanceof PackageFileSet));
        const runDir = FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules(packages) }), ...loose);
        return runDir.get(entry).then(file => {
          if (!file) {
            throw new Error(
              `js_script 'entry' (${entry}) is not present in the run directory — add the file (or its package) to 'deps'`
            );
          }
          const argv = ["node", entry, ...(args ? args.getValues() : [])];
          return createExecAction(runDir, argv, output?.toString() ?? "**", "script");
        });
      })
  );
}

registerRule("js_script", { [BUILD_OPERATION]: "build" }, runJsScript);
