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
 * The `serve[run]` rule: a long-lived server with the content it serves.
 * `tool` is the server, any runnable (a `script` or `js_script` target, or an
 * external package run by its bin); `files` is the content, at the install
 * root; `deps` are support files, unioned flat as a script's are; `args` and
 * `env` are added to the tool's launch. The rule yields a `RunnableFileSet`
 * that launches in its staged install root, with `files` as its `served`
 * content: under `fabr run -w` a change to `files` alone is synced into the
 * running server's install, and any other change restarts it. It runs
 * nothing itself.
 */

import { toEnvironment } from "../context/index";
import { BUILD_OVERRIDE } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { defineRule, RuleResult } from "./Types";

/** The `serve` rule, under `run`. */
export default defineRule({
  /* `deps` and `files` are read under `build`, not the `run` operation this
   * rule is selected by, and for their files alone, as script's are. `tool` is
   * read in `evaluate` (`getRunnableProperty`), as a program to run on this
   * machine, and built alongside them. */
  requirements(context) {
    return {
      run: {
        deps: context.getFileProperty("deps", BUILD_OVERRIDE),
        files: context.getFileProperty("files", BUILD_OVERRIDE),
      },
    };
  },
  evaluateResolved(context, requirements) {
    return Computable.forAll(
      [
        requirements.materializeAll(),
        context.getRunnableProperty("tool"),
        context.getProperty("args"),
        context.getMap("env").then(toEnvironment),
      ],
      ({ deps, files }, tool, args, env): RuleResult => {
        const served = FileSet.unionAll(...files);
        /* A file of the content and one of the program under one name are a
         * ConflictError, raised by the union. */
        const install = FileSet.unionAll(tool, ...deps, served);
        return tool.withServedContent(install, served, args ? args.getValues() : [], env);
      }
    );
  },
});
