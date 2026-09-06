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
import { Computable } from "../core/Computable";
import { attachHelp } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { executePipeline, ITaskReport, StageSpec, StageStreams } from "../support/Execute";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { BuildAction, BuildResult, fileSetInput, stringInput } from "../core/BuildAction";
import { ActionContext } from "../core/BuildCache";

/**
 * The `command-pipeline` build action: stage the combined install (each stage's
 * runnable under its own subdir, plus the shared `srcs` at the root), run the
 * stages as a pipeline (stdout→stdin wired, first stage fed the `stdin` file if
 * present), and collect the result — the redirect captures (streamed straight to
 * the content store, each named content) unioned with the `output` glob over
 * files the tools wrote. One cacheable unit, keyed by the staged content + the
 * stage specs (see {@link runPipeline}).
 */
function runPipeline(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const files = fileSetInput(action, "files");
  const specs: StageSpec[] = JSON.parse(stringInput(action, "spec"));
  /* `output` is a projection Name (selector + optional `-> tmpl` rename), or
   * absent for a pure-redirect genrule that collects only its captures. */
  const output = action.options.output instanceof Name ? action.options.output : undefined;
  const stdin = action.inputs.stdin instanceof FileSet ? action.inputs.stdin : undefined;

  return ctx
    .admit(report, () => writeFileSet(ctx.workDir, files))
    .then(() => stdinBytes(stdin))
    .then(bytes => executePipeline(ctx.processLimit, specs, ctx.workDir, () => ctx.createOutput(), bytes, report))
    .then(captured =>
      /* Plus any files the tools wrote, when an `output` projection is given (a
       * pure redirect genrule omits it and collects only the captures). A given
       * `output` that matches nothing is an error, not a silent empty success:
       * the command ran but produced none of the files the target declares it
       * collects — almost always a wrong selector or a tool that wrote
       * elsewhere. (A pure-redirect genrule has no output and skips this; its
       * captures are the output.) */
      output === undefined
        ? Computable.resolve(captured)
        : ctx
            .admit(report, () => getResultFileSet(ctx.workDir, output))
            .then(written => {
              if (written.isEmpty()) {
                throw attachHelp(
                  new Error(`the command produced no files matching output pattern '${output.toString()}'`),
                  `check the output pattern, or that the command writes its output where '${output.toString()}' looks`
                );
              }
              return FileSet.unionAll(written, captured);
            })
    )
    .then(result => ({ result }));
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

/* v2: a declared `output` glob that matches nothing is now an error, not a
 * cached empty success — bump so entries cached green under v1 re-run.
 * v3: the stage spec's stream members changed shape (`both` → `stdout` +
 * `mergeErr`), and the spec is serialized into the key, so v2 entries would key
 * differently for the same command. */
export const PIPELINE_ACTION = { id: "core:command-pipeline", version: 3, run: runPipeline };

/** One stage as {@link stagePipeline} needs it: the runnable to launch plus its
 * argv and stream destinations. Structurally the model's `ResolvedCommandStage`,
 * spelt without naming it — this module sits *below* the model (which imports it),
 * so it cannot import the model's types back. */
export interface RunnableStage extends StageStreams {
  runnable: RunnableFileSet;
  args: string[];
}

/**
 * Stage a resolved pipeline: mount each stage's runnable and turn it into a run
 * spec. A **single-stage** command mounts the tool *at the root*, over `srcs` (the
 * npx-in-project layout: the tool's `node_modules` sits adjacent to the sources,
 * so a source importing the tool resolves). A **multi-stage** pipeline instead
 * mounts each stage under its own `.fabr-cmd-<n>/` so the tools don't share a
 * `node_modules`; the streams connect them, and no source imports a pipe stage's
 * modules.
 *
 * Shared by `generate` and by command substitution, which differ only in what
 * they collect afterwards — the mounting rule is the same either way.
 */
export function stagePipeline(stages: ReadonlyArray<RunnableStage>, srcs: FileSet): { files: FileSet; specs: StageSpec[] } {
  const single = stages.length === 1;
  const mounts: FileSet[] = [];
  const specs: StageSpec[] = stages.map((stage, i) => {
    const dir = single ? undefined : `.fabr-cmd-${i}`;
    mounts.push(dir === undefined ? stage.runnable : FileSet.layout({ [dir]: stage.runnable }));
    return {
      argv: stage.runnable.toCommandLine(stage.args, dir === undefined ? undefined : { base: dir }),
      stdout: stage.stdout,
      stderr: stage.stderr,
      mergedTo: stage.mergedTo,
    };
  });
  return { files: FileSet.unionAll(srcs, ...mounts), specs };
}

/** @return a command-pipeline action from the resolved per-stage specs, the
 * combined staged fileset, an optional single-file stdin, and the `output`
 * projection (absent to collect only the redirect captures). */
export function createPipelineAction(
  files: FileSet,
  specs: StageSpec[],
  stdin: FileSet | undefined,
  output: Name | undefined,
  label?: string
): BuildAction {
  return new BuildAction(
    PIPELINE_ACTION,
    { files, ...(stdin ? { stdin } : {}) },
    { spec: JSON.stringify(specs), ...(output ? { output } : {}) },
    undefined,
    label
  );
}
