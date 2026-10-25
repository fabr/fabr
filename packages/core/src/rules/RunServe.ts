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
 * change (tool/deps/args/env) restarts it. It does not itself execute.
 */

import { toEnvironment } from "../context/index";
import { BUILD_OPERATION, BUILD_OVERRIDE } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { defineRule, RuleDefinition, RuleResult } from "./Types";

/* deps/files are ordinary build content, read under build rather than the run
 * operation this rule is selected by (constraints otherwise propagate). Both
 * are read for their files, as script's are: each requirement delivers its
 * own — a repository reference the package's files alone, a target what it
 * built — and nothing is resolved together. `tool` is read apart in
 * `evaluate`, under the run operation (getRunnableProperty), as a program to
 * execute on this machine, and built alongside them rather than after. */
export const serveRunRule: RuleDefinition = defineRule({
  type: "serve",
  properties: { [BUILD_OPERATION]: "run" },
  requirements: context => ({
    deps: context.getFileProperty("deps", BUILD_OVERRIDE),
    files: context.getFileProperty("files", BUILD_OVERRIDE),
  }),
  evaluateResolved: (context, requirements) =>
    Computable.forAll(
      [
        requirements.materializeAll(),
        context.getRunnableProperty("tool"),
        context.getProperty("args"),
        context.getMap("env").then(toEnvironment),
      ],
      ({ deps, files }, tool, args, env): RuleResult => {
        const served = FileSet.unionAll(...files);
        /* A same-name collision between content and program is the ordinary
         * two-sided conflict, raised here by the union. */
        const install = FileSet.unionAll(tool, ...deps, served);
        return tool.withServedContent(install, served, args ? args.getValues() : [], env);
      }
    ),
});
