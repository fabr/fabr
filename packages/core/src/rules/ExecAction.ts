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

import { getResultFileSet, writeFileSet } from "../core/Staging";
import { IActionContext } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { execute, findExecutable } from "../support/Execute";
import { BuildAction, BuildActionInputs, IBuildActionDefinition } from "./Types";

/**
 * The generic `exec` build action core ships for rules to compose: stage a
 * fileset, run a command, collect an output pattern — the execution point
 * most build steps are built on. A plain BuildAction descriptor, not a
 * registered target type — a rule constructs it and yields it (typically as
 * the build step of a sub-target whose output feeds the next).
 */

export function fileSetInput(inputs: BuildActionInputs, name: string): FileSet {
  const value = inputs[name];
  if (!(value instanceof FileSet)) {
    throw new Error(`Input '${name}' must be a fileset`);
  }
  return value;
}

export function stringListInput(inputs: BuildActionInputs, name: string): string[] {
  const value = inputs[name];
  if (!Array.isArray(value) || value.some(element => typeof element !== "string")) {
    throw new Error(`Input '${name}' must be a list of strings`);
  }
  return value as string[];
}

export function stringInput(inputs: BuildActionInputs, name: string, fallback?: string): string {
  const value = inputs[name] ?? fallback;
  if (typeof value !== "string") {
    throw new Error(`Input '${name}' must be a string`);
  }
  return value;
}

function runExec(inputs: BuildActionInputs, ctx: IActionContext): Computable<FileSet> {
  const files = fileSetInput(inputs, "files");
  const argv = stringListInput(inputs, "argv");
  const outputs = stringInput(inputs, "outputs", "**");
  return ctx.admit(() => writeFileSet(ctx.workDir, files))
    .then(() => execute(ctx.processLimit, findExecutable(argv[0]), argv.slice(1), ctx.workDir, {}, ctx.report))
    /* Collecting is the other half of the step's own machine work — reading
     * and hashing what the tool wrote — and is admitted for the same reason as
     * staging, once the execution's slot has been given back. */
    .then(() => ctx.admit(() => getResultFileSet(ctx.workDir, outputs)));
}

export const EXEC_ACTION: IBuildActionDefinition = { id: "core:exec", version: 2, run: runExec };

/**
 * @return an action that stages `files`, runs `argv` in the work directory,
 * and collects `outputs` (a "dir:glob" pattern, default "**").
 */
export function createExecAction(files: FileSet, argv: string[], outputs = "**", label?: string): BuildAction {
  return new BuildAction(EXEC_ACTION, { files, argv, outputs }, label);
}
