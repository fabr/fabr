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

import * as fs from "fs";
import * as path from "path";
import { getResultFileSets, OutputSelection, writeFileSet } from "./Staging";
import { Computable } from "./Computable";
import { ConflictError, FabrError } from "./Errors";
import { EMPTY_FILESET, FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { Name } from "./Name";
import { executePipeline, foundStage, ITaskReport, StageSpec, StageStreams, variableEntry } from "../support/Execute";
import { secure, SecureString } from "./SecureString";
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
 * files into the work dir (laid out by {@link stagePipeline}), run its command
 * list there ({@link runCommandList}), and return what it produced.
 *
 * The result is the redirect captures, each under the name it was redirected
 * to, where the action has no `output`: the last pipeline's as they were
 * captured, and those of the pipelines before it as the work dir holds them
 * once the commands end. With `output`, it is what `output` selects from the
 * last pipeline's captures and the files in the work dir, together
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
    .then(() => runCommandList(action, ctx, specs, ctx.workDir, report))
    .then(({ captured, written }) => {
      /* The captures of the pipelines before the last, collected as files where there is no `output`. */
      const earlier = output === undefined && written.length > 0 ? written.map(name => Name.fromLiteral(name)) : undefined;
      const selections: OutputSelection[] = [];
      const indexOf = (selection: OutputSelection | undefined): number =>
        selection === undefined ? -1 : selections.push(selection) - 1;
      const outputAt = indexOf(output);
      const stateAt = indexOf(incremental);
      const earlierAt = indexOf(earlier);
      if (selections.length === 0) {
        return Computable.resolve<BuildResult>({ result: captured });
      }
      /* One walk of the work dir collects them all: each selection's files
       * under the names it gives them, a file two select in both. */
      return ctx
        .admit(report, () => getResultFileSets(ctx.workDir, selections))
        .then(collected => {
          const state = stateAt === -1 ? undefined : collected[stateAt];
          return {
            result:
              output !== undefined
                ? outputOf(captured, collected[outputAt], output)
                : earlierAt === -1
                  ? captured
                  : FileSet.unionAll(captured, collected[earlierAt]),
            ...(state === undefined || state.size === 0 ? {} : { incrementalState: state }),
          };
        });
    });
}

/**
 * Run `pipelines`, an action's command list ({@link pipelineSpecs}), in `dir`,
 * one after another, each once the one before it has succeeded, with the
 * action's environment. The first stage of each reads the action's stdin input
 * for it ({@link stdinInput}). What a pipeline before the last captures is
 * written into `dir` as it ends, a writable copy replacing whatever is at its
 * name, so that the commands after it read it as a file.
 *
 * @return what the last pipeline captured, and the names of what the ones
 * before it captured, now files in `dir`. Rejects as soon as a pipeline fails
 * (see executePipeline).
 */
export function runCommandList(
  action: BuildAction,
  ctx: ActionContext,
  pipelines: StageSpec[][],
  dir: string,
  report: ITaskReport
): Computable<{ captured: FileSet; written: string[] }> {
  const env = envConfig(action);
  const run = (index: number, written: string[]): Computable<{ captured: FileSet; written: string[] }> => {
    if (index === pipelines.length) {
      return Computable.resolve({ captured: EMPTY_FILESET, written });
    }
    return stdinBytes(stdinInput(action, index))
      .then(bytes => executePipeline(ctx.processLimit, pipelines[index], dir, () => ctx.createOutput(), bytes, report, env))
      .then(captured =>
        index === pipelines.length - 1
          ? { captured, written }
          : ctx
              .admit(report, () => replaceFiles(dir, captured))
              .then(() => run(index + 1, [...written, ...[...captured].map(([name]) => name)]))
      );
  };
  return run(0, []);
}

/** Write `files` into `dir` as writable copies, each first removing what is at
 * its name, so that a file staged there from the cache is replaced rather than
 * written through. */
function replaceFiles(dir: string, files: FileSet): Computable<void> {
  for (const [name] of files) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  return writeFileSet(dir, files, { copy: true });
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
    throw new FabrError(`the command produced no files matching output pattern '${output.toDisplayString()}'`).withHelp(
      `check the output pattern, or that the command writes its output where '${output.toDisplayString()}' looks`
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
  version: 9,
  run: runPipeline,
  stage: stagePipelineStep,
};

/** One stage of a pipeline as an action holds it: its command line, the
 * streams it captures, and the variables its runnable is launched with. */
export interface IPipelineStage extends StageStreams {
  argv: readonly RunnableArgument[];
  /** The variables its runnable is launched with, each `NAME=value`. */
  env?: readonly SecureString[];
}

/** @return the config members holding the command list `pipelines`: `spec`,
 * each pipeline's stages but their command lines and variables, each command
 * line as `argv.<n>`, numbered across the list, and the variables of each
 * stage that has any as `env.<n>`. */
export function pipelineConfig(pipelines: readonly (readonly IPipelineStage[])[]): ActionConfig {
  const stages = pipelines.flat();
  return {
    spec: JSON.stringify(pipelines.map(stages => stages.map(stage => ({ ...stage, argv: undefined, env: undefined })))),
    ...Object.fromEntries(stages.map((stage, index) => [`argv.${index}`, stage.argv])),
    ...Object.fromEntries(stages.flatMap((stage, index) => (stage.env === undefined ? [] : [[`env.${index}`, stage.env]]))),
  };
}

/** Read the command list {@link pipelineConfig} wrote, each command line as the text it is run as. */
export function pipelineSpecs(action: BuildAction): StageSpec[][] {
  const pipelines: Omit<IPipelineStage, "argv" | "env">[][] = JSON.parse(stringConfig(action, "spec"));
  let index = 0;
  return pipelines.map(stages =>
    stages.map(stage => {
      const env = action.config[`env.${index}`];
      return {
        ...stage,
        argv: toArgv(commandLineConfig(action, `argv.${index++}`)),
        ...(Array.isArray(env) ? { env: textEntries(env) } : {}),
      };
    })
  );
}

/** @return the text entries of a config member holding a list of them. */
function textEntries(entries: readonly RunnableArgument[]): SecureString[] {
  return entries.map(entry => {
    if (typeof entry === "string") {
      return SecureString.of(entry);
    }
    if (entry instanceof SecureString) {
      return entry;
    }
    throw new FabrError("internal: a variable of a command is not text");
  });
}

/** @return the inputs holding each pipeline's standard input, `stdin.<n>` for
 * pipeline `n`, where it has one. */
export function stdinInputs(stdins: ReadonlyArray<FileSet | undefined>): Record<string, FileSet> {
  return Object.fromEntries(
    stdins.flatMap((stdin, index): [string, FileSet][] => (stdin === undefined ? [] : [[`stdin.${index}`, stdin]]))
  );
}

/** @return the standard input of pipeline `index` that {@link stdinInputs} wrote, or undefined where it has none. */
export function stdinInput(action: BuildAction, index: number): FileSet | undefined {
  const stdin = action.inputs[`stdin.${index}`];
  return stdin instanceof FileSet ? stdin : undefined;
}

/** Stage each pipeline's standard input into the tree pool, as a path from
 * `dir` through the pool's link beside it: `pool` is that link as a path
 * from `dir`. */
export function stagedStdins(
  action: BuildAction,
  count: number,
  pool: string,
  ensureTree: (files: FileSet) => Computable<string>
): Computable<(string | undefined)[]> {
  return Computable.forAll(
    Array.from({ length: count }, (_, index) => {
      const [input] = [...(stdinInput(action, index) ?? EMPTY_FILESET)];
      return input === undefined
        ? Computable.resolve(undefined)
        : ensureTree(new FileSet(new Map([input]))).then(tree => path.posix.join(pool, path.basename(tree), input[0]));
    }),
    (...paths: (string | undefined)[]) => paths
  );
}

/** @return the variables a command runs with, as the `env` config member holds them. */
export function envEntries(env: ReadonlyMap<string, SecureString>): SecureString[] {
  return [...env].map(([name, value]) => secure`${name}=${value}`);
}

/** Read the `env` config member: each variable written `NAME=value`, a name holding no `=`. */
export function envConfig(action: BuildAction): Map<string, SecureString> {
  return new Map(textEntries(Array.isArray(action.config.env) ? action.config.env : []).map(variableEntry));
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
  return Computable.forAll(
    [
      stagedStdins(action, specs.length, TREE_MOUNT, ensureTree),
      writeFileSet(dir, FileSet.unionAll(fileSetInput(action, "files"), configFiles(action))),
    ],
    (stdins: (string | undefined)[]) => ({
      cwd: ".",
      commands: specs.map((stages, index) => ({
        stages: stages.map(spec => foundStage(spec, dir)),
        ...(stdins[index] === undefined ? {} : { stdin: stdins[index] }),
      })),
      env: envConfig(action),
    })
  );
}

/** One stage as {@link stagePipeline} takes it: the runnable to launch, its
 * arguments and where its streams go. The same shape as context/Commands.ts's
 * `MaterializedCommandStage`, which this module cannot import (context/
 * imports it). */
export interface RunnableStage {
  runnable: RunnableFileSet;
  args: readonly SecureString[];
  stdout?: string;
  stderr?: string;
  mergedTo?: StageStreams["mergedTo"];
}

/**
 * Lay out a resolved command list: return the files to stage (`srcs` and each
 * stage's runnable) and each pipeline's stage specs. A command of one stage
 * has its runnable laid out at the root over `srcs`, so its `node_modules`
 * sits beside the sources and a source importing the tool resolves it. Each
 * stage of any longer command goes under its own `.fabr-cmd-<n>/`, numbered
 * across the list, so the tools do not share a `node_modules`. A runnable that
 * collides with `srcs` is a {@link ConflictError}, and two redirections
 * keeping one name an error.
 *
 * `apart` lays out a single stage under `.fabr-cmd-0/` too, for a command over
 * files that import nothing of its tool (`patched`'s). `cwd` is where the
 * commands run, relative to the root of the layout; each command line is made
 * relative to it.
 */
export function stagePipeline(
  pipelines: ReadonlyArray<ReadonlyArray<RunnableStage>>,
  srcs: FileSet,
  options: { apart?: boolean; cwd?: string } = {}
): { files: FileSet; specs: IPipelineStage[][] } {
  const single = pipelines.length === 1 && pipelines[0].length === 1 && options.apart !== true;
  const cwd = options.cwd ?? ".";
  /* The tree pool, which a runnable interpreter is launched from, as a path from where the commands run. */
  const pool = path.posix.join(path.posix.relative(cwd, "."), TREE_MOUNT);
  const kept = new Set<string>();
  for (const name of pipelines.flat().flatMap(stage => [stage.stdout, stage.stderr])) {
    if (name !== undefined) {
      if (kept.has(name)) {
        throw new FabrError(`'${name}' is kept by two redirections of the command`);
      }
      kept.add(name);
    }
  }
  const mounts: FileSet[] = [];
  let index = 0;
  const specs = pipelines.map(stages =>
    stages.map((stage): IPipelineStage => {
      const dir = single ? undefined : `.fabr-cmd-${index++}`;
      mounts.push(dir === undefined ? stage.runnable : FileSet.layout({ [dir]: stage.runnable }));
      return {
        argv: stage.runnable.toCommandLine(stage.args, dir === undefined ? { pool } : { base: path.posix.relative(cwd, dir), pool }),
        stdout: stage.stdout,
        stderr: stage.stderr,
        mergedTo: stage.mergedTo,
        ...(stage.runnable.env.size > 0 ? { env: envEntries(stage.runnable.env) } : {}),
      };
    })
  );
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
 * lays them out) running the command list `specs`, with each pipeline's
 * optional single-file stdin, the `output` projection (absent to collect only
 * the redirect captures), a display label, the variables every stage runs with
 * (its whole environment), and what it keeps between runs. */
export function createPipelineAction(
  files: FileSet,
  specs: IPipelineStage[][],
  stdins: ReadonlyArray<FileSet | undefined>,
  output: Name | undefined,
  label?: string,
  env: ReadonlyMap<string, SecureString> = new Map(),
  kept: IKeptState = {}
): BuildAction {
  return new BuildAction(
    PIPELINE_ACTION,
    { files, ...stdinInputs(stdins) },
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
