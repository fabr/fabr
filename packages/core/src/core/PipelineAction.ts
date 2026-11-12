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

import * as path from "path";
import { getResultFileSets, writeFileSet } from "./Staging";
import { Computable } from "./Computable";
import { ConflictError, FabrError } from "./Errors";
import { EMPTY_FILESET, FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { Name } from "./Name";
import { executePipeline, findExecutable, ITaskReport, StageSpec, StageStreams, variableEntry } from "../support/Execute";
import { RunnableArgument, RunnableFileSet, toArgv } from "./RunnableFileSet";
import {
  ActionConfig,
  BuildAction,
  BuildResult,
  commandLineConfig,
  configFiles,
  fileSetInput,
  IBuildActionDefinition,
  IStagedStep,
  stringConfig,
} from "./BuildAction";
import { ActionContext, IChangedFiles, toChangesDocument, TREE_MOUNT } from "./BuildCache";

/**
 * Run the `command-pipeline` build step: stage the action's `files` and config
 * files into the work dir (laid out by {@link stagePipeline}), run the stages
 * as one pipeline, each stage's standard output feeding the next stage's
 * input and the first stage reading the `stdin` input where there is one, and
 * return what it produced.
 *
 * The result is the redirect captures, each under the name it was redirected
 * to, where the action has no `output`; with `output`, it is what `output`
 * selects from the captures and the files the commands wrote, together
 * ({@link outputOf}). Where the action keeps state ({@link IKeptState}) and
 * its target has a successful run before this one, the files that run kept are
 * staged back (writable) and the changes document written at `changes` before
 * the command runs; the files `incremental` selects afterwards are returned
 * as the run's incremental state, where there are any.
 *
 * Rejects where a stage fails (see executePipeline), where `output` selects
 * nothing, or where two files are collected under one name.
 */
function runPipeline(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const files = FileSet.unionAll(fileSetInput(action, "files"), configFiles(action));
  const specs = pipelineSpecs(action);
  /* A projection (a selector, optionally with a `-> tmpl` rename), or absent
   * to collect only the redirect captures. */
  const output = action.config.output instanceof Name ? action.config.output : undefined;
  const stdin = action.inputs.stdin instanceof FileSet ? action.inputs.stdin : undefined;
  const env = envConfig(action);

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
      return ctx
        .admit(report, () => getResultFileSets(ctx.workDir, selections))
        .then(collected => {
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
 * Collect what `output` selects from both the redirect captures and the files
 * the command wrote (`written`, already selected), each named as `output`
 * projects it. Throws a {@link ConflictError} where a capture is selected
 * under the name of a written file, and an error where nothing is selected at
 * all.
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
 * Make the files staged back for a run that has a successful one before it:
 * the files that run kept (`state`), at their names, and the changes document
 * at `changes`, where given. Undefined where there is no such run (`changed`
 * undefined), so the command finds neither.
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

/** Select the redirect captures `output` names, under the names it gives them,
 * or every capture under its own name where there is no `output`. A capture
 * selected under the name of a written file is a conflict, reported with each
 * side named as the command produced it. */
export function selectedCaptures(captured: FileSet, written: FileSet, output?: Name): FileSet {
  const project = output === undefined ? (name: string): string | undefined => name : output.makeProjector();
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

/** @return the bytes of the first file of `stdin` (a single-file set), or
 * undefined where there is no stdin or it is empty. */
export function stdinBytes(stdin: FileSet | undefined): Computable<Buffer | undefined> {
  if (!stdin) {
    return Computable.resolve(undefined);
  }
  const files = [...stdin];
  return files.length === 0 ? Computable.resolve(undefined) : files[0][1].getBuffer();
}

/* Bump the version when what the step does, or what its serialized stage
 * spec means, changes. */
export const PIPELINE_ACTION: IBuildActionDefinition = {
  id: "core:command-pipeline",
  version: 6,
  run: runPipeline,
  stage: stagePipelineStep,
};

/** One stage of a pipeline as an action holds it: its command line, the
 * streams it captures, and the variables its runnable is launched with. */
export interface IPipelineStage extends StageStreams {
  argv: readonly RunnableArgument[];
  env?: string[];
}

/** @return the config members holding `stages`: `spec`, each stage but its
 * command line, and each command line as `argv.<n>`. */
export function pipelineConfig(stages: readonly IPipelineStage[]): ActionConfig {
  return {
    spec: JSON.stringify(stages.map(stage => ({ ...stage, argv: undefined }))),
    ...Object.fromEntries(stages.map((stage, index) => [`argv.${index}`, stage.argv])),
  };
}

/** Read the stages {@link pipelineConfig} wrote, each command line as the text it is run as. */
export function pipelineSpecs(action: BuildAction): StageSpec[] {
  const stages: Omit<IPipelineStage, "argv">[] = JSON.parse(stringConfig(action, "spec"));
  return stages.map((stage, index) => ({ ...stage, argv: toArgv(commandLineConfig(action, `argv.${index}`)) }));
}

/** @return the variables a command runs with, as the `env` config member holds them. */
export function envEntries(env: ReadonlyMap<string, string>): string[] {
  return [...env].map(([name, value]) => `${name}=${value}`);
}

/** Read the `env` config member: each variable written `NAME=value`, a name holding no `=`. */
export function envConfig(action: BuildAction): Map<string, string> {
  return new Map((Array.isArray(action.config.env) ? action.config.env : []).map(variableEntry));
}

/** Stage the pipeline's files into `dir` for `fabr shell`, and describe the
 * pipeline to run there. Its standard input is a path into the cache's tree
 * pool, through the link beside `dir`. */
function stagePipelineStep(
  action: BuildAction,
  dir: string,
  ensureTree: (files: FileSet) => Computable<string>
): Computable<IStagedStep> {
  const specs = pipelineSpecs(action);
  const [input] = action.inputs.stdin instanceof FileSet ? [...action.inputs.stdin] : [];
  const stdin =
    input === undefined
      ? Computable.resolve(undefined)
      : ensureTree(new FileSet(new Map([input]))).then(tree => path.posix.join(TREE_MOUNT, path.basename(tree), input[0]));
  return Computable.forAll(
    [stdin, writeFileSet(dir, FileSet.unionAll(fileSetInput(action, "files"), configFiles(action)))],
    stdinPath => ({
      cwd: ".",
      commands: [
        {
          stages: specs.map(spec => ({ ...spec, argv: [findExecutable(spec.argv[0], dir), ...spec.argv.slice(1)] })),
          ...(stdinPath === undefined ? {} : { stdin: stdinPath }),
        },
      ],
      env: envConfig(action),
    })
  );
}

/** One stage as {@link stagePipeline} takes it: the runnable to launch, its
 * arguments and where its streams go. The same shape as context/Commands.ts's
 * `MaterializedCommandStage`, which this module cannot import (context/
 * imports it). */
export interface RunnableStage extends StageStreams {
  runnable: RunnableFileSet;
  args: string[];
}

/**
 * Lay out a resolved pipeline: return the files to stage (`srcs` and each
 * stage's runnable) and each stage's run spec. A single-stage command's
 * runnable is laid out at the root over `srcs`, so its `node_modules` sits
 * beside the sources and a source importing the tool resolves it. Each stage
 * of a longer pipeline goes under its own `.fabr-cmd-<n>/`, so the tools do
 * not share a `node_modules`. A runnable that collides with `srcs` is a
 * {@link ConflictError}.
 *
 * `apart` lays out a single stage under `.fabr-cmd-0/` too, for a command over
 * files that import nothing of its tool (`patched`'s). `cwd` is where the
 * commands run, relative to the root of the layout; each command line is made
 * relative to it.
 */
export function stagePipeline(
  stages: ReadonlyArray<RunnableStage>,
  srcs: FileSet,
  options: { apart?: boolean; cwd?: string } = {}
): { files: FileSet; specs: IPipelineStage[] } {
  const single = stages.length === 1 && options.apart !== true;
  const cwd = options.cwd ?? ".";
  /* The tree pool, which a runnable interpreter is launched from, as a path from where the commands run. */
  const pool = path.posix.join(path.posix.relative(cwd, "."), TREE_MOUNT);
  const mounts: FileSet[] = [];
  const specs: IPipelineStage[] = stages.map((stage, i) => {
    const dir = single ? undefined : `.fabr-cmd-${i}`;
    mounts.push(dir === undefined ? stage.runnable : FileSet.layout({ [dir]: stage.runnable }));
    return {
      argv: stage.runnable.toCommandLine(stage.args, dir === undefined ? { pool } : { base: path.posix.relative(cwd, dir), pool }),
      stdout: stage.stdout,
      stderr: stage.stderr,
      mergedTo: stage.mergedTo,
      ...(stage.runnable.env.size > 0 ? { env: envEntries(stage.runnable.env) } : {}),
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

/** @return a command-pipeline action over `files` (as {@link stagePipeline}
 * lays them out) running `specs`, with an optional single-file `stdin`, the
 * `output` projection (absent to collect only the redirect captures), a
 * display label, the variables every stage runs with (its whole environment),
 * and what it keeps between runs. */
export function createPipelineAction(
  files: FileSet,
  specs: IPipelineStage[],
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
      ...pipelineConfig(specs),
      ...(output ? { output } : {}),
      ...(env.size > 0 ? { env: envEntries(env) } : {}),
      ...(kept.incremental ? { incremental: kept.incremental } : {}),
      ...(kept.changes !== undefined ? { changes: kept.changes } : {}),
    },
    { label, trackChangedFiles: kept.incremental !== undefined || kept.changes !== undefined }
  );
}
