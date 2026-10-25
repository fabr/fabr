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

import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { FileSet, FileSource } from "../core/FileSet";
import { FileSetRef } from "../core/FileSetRef";
import { PackageFileSet } from "../core/PackageFileSet";
import { Name } from "../core/Name";
import { Repository, SourceRef } from "../core/Repository";
import { PERMISSIVE_RESOLUTION } from "./CollectionPoint";
import { ResolutionContext } from "../resolver/Types";
import { collectLists } from "./CollectionPoint";
import { RunnableFileSet, toRunnable } from "../core/RunnableFileSet";
import { INameValue, IPropertyDecl, ITargetDecl, StreamName } from "../model/AST";
import { StageStreams } from "../support/Execute";
import type { InternalBuildContext } from "./BuildContext";

/**
 * A name in a command after its `${NAME}` substitutions: `name` is the
 * substituted name, materialized as a runnable or matched against `srcs`, and
 * `ref` the value as written, for provenance and error positions.
 * {@link InternalBuildContext.lookupCommand} makes it, and a rule sees only the
 * {@link MaterializedCommandStage} made from it.
 */
export interface IPositionedName {
  name: Name;
  ref: INameValue;
}

/**
 * One {@link ICommandStage} with every name substituted and a bare name of
 * another COMMAND property followed (see
 * {@link InternalBuildContext.lookupCommand}), which
 * {@link TargetContext.getCommandProperty} materializes as a
 * {@link MaterializedCommandStage}. Not rule-facing.
 */
export interface ICommandStageLookup {
  /** The property the stage is written in, and its target, where it has one. */
  site?: { property: IPropertyDecl; target?: ITargetDecl };
  command: IPositionedName;
  args: IPositionedName[];
  stdin?: IPositionedName;
  stdout?: IPositionedName;
  stderr?: IPositionedName;
  /** Carried straight through from the parse — a dup names streams, not names,
   * so there is nothing in it to substitute or position. */
  mergedTo?: StreamName;
}

/**
 * A COMMAND property's value as read: its stages with variables substituted
 * and every name still carrying where it was written, not yet materialized.
 * Opaque to a rule: read with {@link TargetContext.getCommand}, and handed to a
 * sub-target as the input its own {@link TargetContext.getCommandProperty}
 * materializes.
 */
export class CommandValue {
  /** @internal */
  constructor(public readonly stages: ReadonlyArray<ICommandStageLookup>) {}
}

/**
 * One materialized pipeline stage, as a `generate` rule reads it (see
 * {@link TargetContext.getCommandProperty}): its command as a `runnable`, `args`
 * with globs expanded over `srcs`, `stdin` as a single-file set, and the
 * redirections ({@link StageStreams}: `stdout`, `stderr`, `mergedTo`). Nothing
 * here is positioned: errors were raised as it was materialized.
 */
export interface MaterializedCommandStage extends StageStreams {
  runnable: RunnableFileSet;
  args: string[];
  stdin?: FileSet;
}

/** A materialized command pipeline: the rule-facing counterpart of the parsed
 * {@link CommandPipeline}, yielded by {@link TargetContext.getCommandProperty}. */
export type MaterializedCommandPipeline = MaterializedCommandStage[];

/**
 * Collect `sources` as the tool `name` names and return its runnable. A tool
 * is a collection of its own, resolved permissively, for `context`.
 */
export function collectRunnable(
  config: InternalBuildContext,
  context: ResolutionContext,
  sources: SourceRef[],
  name: string
): Computable<RunnableFileSet> {
  return collectLists(context, [sources], PERMISSIVE_RESOLUTION)
    .then(([materialized]) => config.applyProjections(materialized))
    .then(finished => asRunnable(finished, name));
}

/** Pick the runnable out of materialized sources, or throw naming the
 * property or global that was expected to yield one. Plain files with no
 * runnable among them are one, launched directly: its entry the sole file. */
function asRunnable(sources: ReadonlyArray<FileSource | Repository | FileSetRef>, name: string): RunnableFileSet {
  for (const source of sources) {
    /* A projected runnable arrives pending; demanding a launcher is exactly the
     * point it collapses (a projection that matched nothing yields no runnable,
     * so it reports as "not a runnable" like any other non-runnable value). */
    const runnable = toRunnable(source);
    if (runnable) {
      return runnable;
    }
  }
  const files = sources.filter((source): source is FileSet => source instanceof FileSet && !(source instanceof PackageFileSet));
  if (files.length > 0 && files.length === sources.length) {
    const install = FileSet.unionAll(...files);
    if (!install.isEmpty()) {
      return new RunnableFileSet(install, [], undefined, "", install);
    }
  }
  throw new FabrError(`'${name}' must name a runnable (its BUILD_OPERATION=run result)`);
}

/** The content name a command substitution's stdout is captured under. */
export const SUBST_CAPTURE = ".value";

/**
 * Point a substitution's streams at where its value comes from, and everything
 * else at nothing. The last stage's stdout is captured as the value
 * ({@link SUBST_CAPTURE}). A redirected stream is captured under a generated
 * name and discarded, so `2> log` silences the stream and writes no file. A
 * command that redirects its own stdout captures nothing, and its value is
 * empty, as `$(cmd > f)` is in a shell.
 */
export function captureStages(stages: MaterializedCommandStage[]): MaterializedCommandStage[] {
  const last = stages.length - 1;
  return stages.map((stage, i) => ({
    ...stage,
    stdout: stage.stdout !== undefined ? `.drop-${i}-out` : i === last && stage.mergedTo !== "err" ? SUBST_CAPTURE : undefined,
    stderr: stage.stderr !== undefined ? `.drop-${i}-err` : undefined,
  }));
}

/**
 * Normalize a command's output to substituted text: trailing whitespace
 * trimmed, then every internal whitespace run collapsed to a single space.
 *
 * This is what a shell's word splitting produces: `"a\n\nb\n"` becomes `"a b"`.
 */
export function normalizeCommandOutput(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
