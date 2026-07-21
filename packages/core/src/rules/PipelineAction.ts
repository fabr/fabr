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
 */

import { getResultFileSet, writeFileSet } from "../core/Staging";
import { IActionContext } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { executePipeline, StageSpec } from "../support/Execute";
import { BuildAction, BuildActionInputs } from "./Types";
import { fileSetInput, stringInput } from "./ExecAction";

/**
 * The `command-pipeline` build action: stage the combined install (each stage's
 * runnable under its own subdir, plus the shared `srcs` at the root), run the
 * stages as a pipeline (stdout→stdin wired, first stage fed the `stdin` file if
 * present), and collect the result — the redirect captures (streamed straight to
 * the content store, each named content) unioned with the `output` glob over
 * files the tools wrote. One cacheable unit, keyed by the staged content + the
 * stage specs (see {@link runPipeline}).
 */
function runPipeline(inputs: BuildActionInputs, ctx: IActionContext): Computable<FileSet> {
  const files = fileSetInput(inputs, "files");
  const specs: StageSpec[] = JSON.parse(stringInput(inputs, "spec"));
  const output = stringInput(inputs, "output", "");
  const stdin = inputs.stdin instanceof FileSet ? inputs.stdin : undefined;

  return writeFileSet(ctx.workDir, files)
    .then(() => stdinBytes(stdin))
    .then(bytes => executePipeline(specs, ctx.workDir, () => ctx.createOutput(), bytes))
    .then(captured =>
      /* Plus any files the tools wrote, when an `output` glob is given (a pure
       * redirect genrule omits it and collects only the captures). */
      output === "" ? Computable.resolve(captured) : getResultFileSet(ctx.workDir, output).then(written => FileSet.unionAll(written, captured))
    );
}

/** @return the first (only) file's bytes of a single-file stdin fileset, or
 * undefined if no stdin was supplied. */
function stdinBytes(stdin: FileSet | undefined): Computable<Buffer | undefined> {
  if (!stdin) {
    return Computable.resolve(undefined);
  }
  const files = [...stdin];
  return files.length === 0 ? Computable.resolve(undefined) : files[0][1].getBuffer();
}

export const PIPELINE_ACTION = { id: "core:command-pipeline", version: 1, run: runPipeline };

/** @return a command-pipeline action from the resolved per-stage specs, the
 * combined staged fileset, an optional single-file stdin, and the `output`
 * glob (empty to collect only the redirect captures). */
export function createPipelineAction(
  files: FileSet,
  specs: StageSpec[],
  stdin: FileSet | undefined,
  output: string,
  label?: string
): BuildAction {
  const inputs: BuildActionInputs = { files, spec: JSON.stringify(specs), output };
  if (stdin) {
    inputs.stdin = stdin;
  }
  return new BuildAction(PIPELINE_ACTION, inputs, label);
}
