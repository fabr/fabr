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

import { getResultFileSets, writeFileSet } from "../core/Staging";
import { Computable } from "../core/Computable";
import { ConflictError, FabrError } from "../core/Errors";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { executePipeline, ITaskReport, StageSpec, StageStreams } from "../support/Execute";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { BuildAction, BuildResult, configFiles, fileSetInput, stringConfig } from "../core/BuildAction";
import { ActionContext, IChangedFiles, toChangesDocument } from "../core/BuildCache";

/**
 * Run the `command-pipeline` build action: stage the combined install (see
 * {@link stagePipeline}: a single stage's runnable at the root over `srcs`,
 * each stage of a pipeline under its own `.fabr-cmd-<n>/`), run the
 * stages as a pipeline (stdout→stdin wired, first stage fed the `stdin` file if
 * present), and collect the result: the redirect captures (streamed straight to
 * the content store, each named content) where there is no `output`, else what
 * `output` selects from the captures and the files the tools wrote together. One
 * cacheable unit, keyed by the staged content + the stage specs (see
 * {@link createPipelineAction}). Where the action keeps state ({@link IKeptState})
 * and its target has a successful run before, what that run kept is staged back
 * and the changes document written, before the command runs.
 */
function runPipeline(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const files = FileSet.unionAll(fileSetInput(action, "files"), configFiles(action));
  const specs: StageSpec[] = JSON.parse(stringConfig(action, "spec"));
  /* `output` is a projection Name (selector + optional `-> tmpl` rename), or
   * absent for a pure-redirect genrule that collects only its captures. */
  const output = action.config.output instanceof Name ? action.config.output : undefined;
  const stdin = action.inputs.stdin instanceof FileSet ? action.inputs.stdin : undefined;
  /* Each variable as `NAME=value`: a name holds no `=`, so the first one splits it. */
  const env = new Map(
    (Array.isArray(action.config.env) ? action.config.env : []).map((entry): [string, string] => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    })
  );

  const incremental = action.config.incremental instanceof Name ? action.config.incremental : undefined;
  const changes = typeof action.config.changes === "string" ? action.config.changes : undefined;
  const handover =
    incremental === undefined && changes === undefined
      ? Computable.resolve<FileSet | undefined>(undefined)
      : Computable.forAll([ctx.changedFiles(), ctx.incrementalState()], (changed, state) => keptBase(changed, state, changes));

  return handover
    .then(base =>
      ctx.admit(report, () =>
        writeFileSet(ctx.workDir, files).then(() => (base === undefined ? undefined : writeFileSet(ctx.workDir, base, { copy: true })))
      )
    )
    .then(() => stdinBytes(stdin))
    .then(bytes => executePipeline(ctx.processLimit, specs, ctx.workDir, () => ctx.createOutput(), bytes, report, env))
    .then(captured => {
      if (output === undefined && incremental === undefined) {
        return Computable.resolve<BuildResult>({ result: captured });
      }
      /* One walk of the work dir collects both: each selection's files under the
       * names it gives them, a file both select in both. */
      const selections = [output, incremental].filter((selection): selection is Name => selection !== undefined);
      return ctx.admit(report, () => getResultFileSets(ctx.workDir, selections)).then(collected => {
        const written = output === undefined ? undefined : collected[0];
        const state = incremental === undefined ? undefined : collected[collected.length - 1];
        return {
          result: output === undefined || written === undefined ? captured : outputOf(captured, written, output),
          ...(state === undefined || state.size === 0 ? {} : { incrementalState: state }),
        };
      });
    });
}

/**
 * Collect what `output` selects, from everything the command produced — a
 * redirect names a file in the sandbox as surely as a tool writing one does —
 * through the one projector, so its `dir:` strip and `-> tmpl` rename apply to
 * both alike; a redirect it does not select is not collected, and one named
 * like a selected written file is a conflict. Selecting nothing is an error, not
 * a silent empty success: almost always a wrong selector or a tool that wrote
 * elsewhere.
 */
function outputOf(captured: FileSet, written: FileSet, output: Name): FileSet {
  const collected = FileSet.unionAll(written, selectedCaptures(captured, written, output));
  if (collected.isEmpty()) {
    throw new FabrError(`the command produced no files matching output pattern '${output.toString()}'`).withHelp(
      `check the output pattern, or that the command writes its output where '${output.toString()}' looks`
    );
  }
  return collected;
}

/**
 * Make what a run with a successful one before it is handed: the files that run kept,
 * where they were, and the changes document at `changes`. Undefined where there
 * is no such run, so the command finds neither and runs cold.
 */
function keptBase(changed: IChangedFiles | undefined, state: FileSet | undefined, changes: string | undefined): FileSet | undefined {
  if (changed === undefined) {
    return undefined;
  }
  return FileSet.unionAll(
    state ?? EMPTY_FILESET,
    changes === undefined ? EMPTY_FILESET : FileSet.layout({ [changes]: MemoryFile.from(toChangesDocument(changed)) })
  );
}

/** Select the redirect captures `output` names, under the names it gives them. A
 * capture selected under the name of a selected written file is a conflict,
 * reported with each side named as the command produced it. */
function selectedCaptures(captured: FileSet, written: FileSet, output: Name): FileSet {
  const project = output.makeProjector();
  for (const [redirect] of captured) {
    const name = project(redirect);
    if (name !== undefined && written.getFile(name) !== undefined) {
      throw new ConflictError(
        "collected files",
        name,
        { provenance: undefined, detail: "a file the command wrote" },
        { provenance: undefined, detail: `the redirect "> ${redirect}"` }
      );
    }
  }
  return captured.rename(project);
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

/* The version tracks what the step does and what its serialized stage spec
 * means; either changing is a bump. */
export const PIPELINE_ACTION = { id: "core:command-pipeline", version: 4, run: runPipeline };

/** One stage as {@link stagePipeline} needs it: the runnable to launch plus its
 * argv and stream destinations. Structurally the build context's
 * `MaterializedCommandStage` (context/Commands.ts), spelt without naming it:
 * context/ imports this module, so it cannot import context's types back. */
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

/** What a command keeps between its runs: `incremental`, the pattern selecting
 * the files it keeps (named as it names them), and `changes`, where it is told
 * what moved in its inputs. */
export interface IKeptState {
  incremental?: Name;
  changes?: string;
}

/** @return a command-pipeline action from the combined staged fileset, the
 * resolved per-stage specs, an optional single-file stdin, the `output`
 * projection (absent to collect only the redirect captures), the task label,
 * the variables every stage runs with (its whole environment), and what it
 * keeps between runs. */
export function createPipelineAction(
  files: FileSet,
  specs: StageSpec[],
  stdin: FileSet | undefined,
  output: Name | undefined,
  label?: string,
  env: ReadonlyMap<string, string> = new Map(),
  kept: IKeptState = {}
): BuildAction {
  return new BuildAction(
    PIPELINE_ACTION,
    { files, ...(stdin ? { stdin } : {}) },
    {
      spec: JSON.stringify(specs),
      ...(output ? { output } : {}),
      ...(env.size > 0 ? { env: [...env].map(([name, value]) => `${name}=${value}`) } : {}),
      ...(kept.incremental ? { incremental: kept.incremental } : {}),
      ...(kept.changes !== undefined ? { changes: kept.changes } : {}),
    },
    undefined,
    label,
    kept.incremental !== undefined || kept.changes !== undefined
  );
}
