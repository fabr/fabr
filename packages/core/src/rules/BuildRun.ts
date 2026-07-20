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
 * The generic `run` target: execute a runnable and collect its output — the
 * ecosystem-neutral builder that turns "a program that writes files" into build
 * content. `tool` names a runnable target (resolved as a host runnable via
 * getRunnableProperty — it executes now, on this machine); `srcs` are the
 * invocation's input files, staged into the work dir at the install root;
 * `args` are appended to the runnable's own; `output` (a dir:glob pattern,
 * default `**`) selects the files it wrote as this target's content. Any
 * runnable plugs in — the "run and collect" the js_script rule used to do
 * itself, now generic. The tool/srcs split is the concept: the runnable
 * defines the *tool*, the run target says what to *do* with it.
 */

import { BUILD_OPERATION, TargetContext } from "../model/BuildContext";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { createExecAction } from "./ExecAction";
import { RuleRegistration, RuleResult } from "./Types";

/**
 * A runnable is just a staged install plus a launch descriptor, so running it
 * and collecting its output is exactly the generic `exec` action: the install
 * — overlaid with `srcs` at its root, a plain file union with no language
 * knowledge (for a JS tool this happens to be the npx-in-project layout:
 * sources at the root, node_modules adjacent; a name collision with the
 * install is the ordinary two-sided conflict) — is the staged fileset, and
 * `toCommandLine` flattens the descriptor to an argv (interpreter — if any —
 * as the command, `entry` and the runnable's own args, then this target's
 * extra `args`). (An interpreter-based runnable's entry rides as an
 * *argument*, resolved by the interpreter against the work dir; only when a
 * bare executable were itself argv[0] would exec need a work-dir-relative
 * command — which won't arise once commands are absolute, path search being a
 * temporary hack. See findExecutable.) The exec step then runs it clean-env in
 * the work dir and collects `output`.
 */
function runTool(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getRunnableProperty("tool"),
      context.getFileSet("srcs"),
      context.getProperty("args"),
      context.getProperty("output"),
    ],
    (runnable, srcs, args, output) => {
      /* No anchor: the exec step runs with cwd == the staged workDir, so `entry`
       * stays install-relative (resolved there by the interpreter). */
      const argv = runnable.toCommandLine(args ? args.getValues() : []);
      const staged = FileSet.unionAll(runnable, srcs);
      return createExecAction(staged, argv, output?.toString() ?? "**", "run");
    }
  );
}

export const runRule: RuleRegistration = { type: "run", constraints: { [BUILD_OPERATION]: "build" }, evaluate: runTool };
