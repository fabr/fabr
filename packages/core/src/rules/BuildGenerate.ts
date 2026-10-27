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
 * The generic `generate` target: run a command **pipeline** and collect its
 * output — the ecosystem-neutral genrule (Bazel's genrule analogue). It is a
 * *build* step (registered under BUILD_OPERATION=build), unrelated to the
 * interactive `fabr run` verb.
 *
 * `run` is a command line: `cmd args… [redirs] | cmd args… [redirs]`. Each
 * command is a fabr runnable resolved under `run` (a single command mounted at
 * the sandbox root beside `srcs`, each stage of a multi-stage pipeline under
 * its own subdir, so the tools don't share a `node_modules`); args are literal
 * or a glob expanded over the staged `srcs` (never rewritten, never a reference —
 * `<`/redirect targets are the only other reference position). `|` wires
 * stdout→stdin; `> name` / `2> name` / `&> name` capture a stream as content
 * named `name`; `< source` streams a single-file reference to the first stage's
 * stdin. `srcs` are the input files staged at the sandbox root; `output` (a
 * `dir:glob` projection) selects what is collected, from the files the tools
 * wrote and the redirect captures alike — without it, the captures are collected.
 * `incremental` (a pattern like `output`'s) selects what the command keeps for
 * its next run, and `changes` names where that run is told what moved.
 */

import { MaterializedCommandPipeline, TargetContext, toEnvironment } from "../context/index";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { createPipelineAction, IKeptState, stagePipeline } from "./PipelineAction";
import { defineRule, RuleResult } from "./Types";
import { FabrError } from "../core/Errors";

/** The `generate` rule. */
export default defineRule({
  requirements(context) {
    return { srcs: context.getFileProperty("srcs") };
  },
  evaluateMaterialized(context, { srcs }) {
    return generate(context, srcs);
  },
});

function generate(context: TargetContext, srcSets: FileSet[]): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getProjection("output"),
      context.getMap("env").then(toEnvironment),
      context.getProjection("incremental"),
      context.getString("changes"),
    ],
    (output: Name | undefined, env, incremental: Name | undefined, changes: string | undefined) => {
      const srcs = FileSet.unionAll(...srcSets);
      return context.getCommandProperty("run", srcs).then(stages => {
        if (stages.length === 0) {
          return Computable.reject<RuleResult>(new FabrError("a 'generate' target requires a 'run' command"));
        }
        return assemblePipeline(srcs, stages, output, env, { incremental, changes });
      });
    }
  );
}

/** Stage the install (see {@link stagePipeline}, shared with command
 * substitution) and yield the pipeline action. */
function assemblePipeline(
  srcs: FileSet,
  stages: MaterializedCommandPipeline,
  output: Name | undefined,
  env: ReadonlyMap<string, string>,
  kept: IKeptState
): RuleResult {
  const { files, specs } = stagePipeline(stages, srcs);
  return createPipelineAction(files, specs, stages[0].stdin, output, "generate", env, kept);
}
