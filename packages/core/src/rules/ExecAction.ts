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

import { ActionContext } from "../core/BuildCache";
import { getResultFileSet, writeFileSet } from "../core/Staging";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { execute, findExecutable, ITaskReport } from "../support/Execute";
import { BuildAction, BuildResult, fileSetInput, IBuildActionDefinition, stringInput, stringListInput } from "../core/BuildAction";

/**
 * The generic `exec` build action core ships for rules to compose: stage a
 * fileset, run a command, collect an output pattern — the execution point
 * most build steps are built on. A plain BuildAction descriptor, not a
 * registered target type — a rule constructs it and yields it (typically as
 * the build step of a sub-target whose output feeds the next).
 */

/**
 * The `outputs` option: what the run's work dir is collected by. One pattern is
 * the ordinary case; a LIST is for a step collecting a second thing beside its
 * result — a tool's report about the run — which has to be collected rather
 * than read in place, since collection sweeps away everything it does not
 * select.
 */
export function outputsInput(action: BuildAction): string | string[] {
  return Array.isArray(action.options.outputs) ? stringListInput(action, "outputs") : stringInput(action, "outputs", "**");
}

function runExec(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const files = fileSetInput(action, "files");
  const argv = stringListInput(action, "argv");
  const outputs = outputsInput(action);
  return (
    ctx
      .admit(report, () => writeFileSet(ctx.workDir, files))
      .then(() => execute(ctx.processLimit, findExecutable(argv[0]), argv.slice(1), ctx.workDir, {}, report))
      /* Collecting is the other half of the step's own machine work — reading
       * and hashing what the tool wrote — and is admitted for the same reason as
       * staging, once the execution's slot has been given back. */
      .then(() => ctx.admit(report, () => getResultFileSet(ctx.workDir, outputs)))
      .then(result => ({ result }))
  );
}

/* The version tracks what the step DOES; a change to the action-key text's
 * shape (see BuildAction.actionKey) already invalidates mechanically and needs
 * no bump here. */
export const EXEC_ACTION: IBuildActionDefinition = { id: "core:exec", version: 2, run: runExec };

/**
 * @return an action that stages `files`, runs `argv` in the work directory,
 * and collects `outputs` (a "dir:glob" pattern, default "**").
 */
export function createExecAction(files: FileSet, argv: string[], outputs = "**", label?: string): BuildAction {
  return new BuildAction(EXEC_ACTION, { files }, { argv, outputs }, undefined, label);
}
