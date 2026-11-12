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
 * The `generate[build]` rule: run a command pipeline over input files and keep
 * its output, as Bazel's genrule does.
 *
 * `run` is a command line, `cmd args… [redirs] | cmd args… [redirs]`. Each
 * command is a runnable, resolved under `run`. A single command's tool is
 * staged at the root of the directory it runs in, beside `srcs`; each stage of
 * a longer pipeline has its own subdirectory, so their tools share no files.
 * An argument is literal text or a glob expanded over the staged `srcs`. `|`
 * connects one stage's stdout to the next's stdin; `> name`, `2> name` and
 * `&> name` capture a stream as the file `name`; `< source` feeds a one-file
 * reference to the first stage's stdin.
 *
 * `srcs` are the input files, staged at the root. `output` (a `dir:glob`
 * projection) selects what is kept, from the files the commands wrote and the
 * captures alike; without it, the captures are kept. `incremental` (a pattern
 * like `output`'s) selects what the command keeps for its next run, and
 * `changes` names the file that run is told what changed in. `env` is the
 * commands' whole environment.
 */

import { MaterializedCommandPipeline, TargetContext, toEnvironment } from "../context/index";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { createPipelineAction, IKeptState, stagePipeline } from "../core/PipelineAction";
import { defineRule, RuleResult } from "./Types";
import { FabrError } from "../core/Errors";

/** The `generate` rule. */
export default defineRule({
  requirements(context) {
    return { build: { srcs: context.getFileProperty("srcs") }, result: "files" };
  },
  evaluateMaterialized(context, { srcs }) {
    return generate(context, srcs);
  },
});

/** Make the pipeline action of the `generate` target `context` evaluates, over `srcSets`. Rejects where `run` is empty. */
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

/** Lay out `stages` beside `srcs` ({@link stagePipeline}) and make the pipeline action that runs them. */
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
