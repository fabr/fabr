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
import {
  BuildAction,
  BuildResult,
  configFiles,
  fileSetInput,
  IBuildActionDefinition,
  IStagedStep,
  commandLineConfig,
  stringConfig,
  stringListConfig,
} from "../core/BuildAction";
import { RunnableArgument, toArgv } from "../core/RunnableFileSet";

/*
 * The generic `exec` build action (`core:exec`): stage files, run a command,
 * collect its output. It is no target type: a rule makes one with
 * createExecAction and yields it.
 */

/**
 * @return the action's `outputs` config: the pattern its work directory is
 * collected by, or a list of patterns, each file named by the first that
 * selects it (a result and a tool's report beside it). Defaults to "**".
 */
export function outputsConfig(action: BuildAction): string | string[] {
  return Array.isArray(action.config.outputs) ? stringListConfig(action, "outputs") : stringConfig(action, "outputs", "**");
}

/** Stage the action's files and config files, run its argv in the work directory, and collect its outputs. */
function runExec(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const files = FileSet.unionAll(fileSetInput(action, "files"), configFiles(action));
  const argv = toArgv(commandLineConfig(action, "argv"));
  const outputs = outputsConfig(action);
  return (
    ctx
      .admit(report, () => writeFileSet(ctx.workDir, files))
      .then(() => execute(ctx.processLimit, findExecutable(argv[0], ctx.workDir), argv.slice(1), ctx.workDir, {}, report))
      /* Collecting — reading and hashing what the tool wrote — is admitted as
       * its own unit, once the execution's slot has been given back. */
      .then(() => ctx.admit(report, () => getResultFileSet(ctx.workDir, outputs)))
      .then(result => ({ result }))
  );
}

/* Bump the version when what the step does changes; a change to the shape of
 * the action-key text (BuildAction.actionKey) changes every key already. */
export const EXEC_ACTION: IBuildActionDefinition = { id: "core:exec", version: 4, run: runExec, stage: stageExec };

/** Stage the action into `dir` as runExec would, and describe the command it would run there. */
function stageExec(action: BuildAction, dir: string): Computable<IStagedStep> {
  const argv = toArgv(commandLineConfig(action, "argv"));
  return writeFileSet(dir, FileSet.unionAll(fileSetInput(action, "files"), configFiles(action))).then(() => ({
    cwd: ".",
    commands: [{ stages: [{ argv: [findExecutable(argv[0], dir), ...argv.slice(1)] }] }],
    env: new Map(),
  }));
}

/**
 * @return an action that stages `files`, runs `argv` in the work directory,
 * and collects `outputs`: a "dir:glob" pattern, default "**", or several, each
 * file named by the first that selects it.
 */
export function createExecAction(
  files: FileSet,
  argv: readonly RunnableArgument[],
  outputs: string | string[] = "**",
  label?: string
): BuildAction {
  return new BuildAction(EXEC_ACTION, { files }, { argv, outputs }, { label });
}
