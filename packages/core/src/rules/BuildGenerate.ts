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
 * output — the ecosystem-neutral genrule (Bazel's genrule analogue). Named
 * `generate`, not `run`, so it doesn't collide with the interactive `fabr run`
 * verb — it is a *build* step (registered under BUILD_OPERATION=build).
 *
 * `run` is a command line: `cmd args… [redirs] | cmd args… [redirs]`. Each
 * command is a fabr runnable (resolved under `run` and mounted in its own
 * sandbox subdir — tools don't share a `node_modules`); args are literal or a
 * glob expanded over the staged `srcs` (never rewritten, never a reference —
 * `<`/redirect targets are the only other reference position). `|` wires
 * stdout→stdin; `> name` / `2> name` / `&> name` capture a stream as content
 * named `name`; `< source` streams a single-file reference to the first stage's
 * stdin. `srcs` are the input files staged at the sandbox root; `output` (a
 * `dir:glob`) collects files the tools *wrote*, unioned with the redirect
 * captures — omit it for a pure-redirect genrule.
 */

import { ResolvedCommandPipeline, TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { createPipelineAction, stagePipeline } from "./PipelineAction";
import { RuleRegistration, RuleResult } from "./Types";

function generate(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [context.getFileSetProperties(["srcs"]), context.getProjection("output")],
    ({ srcs: srcSets }, output: Name | undefined) => {
      const srcs = FileSet.unionAll(...srcSets);
      return context.getCommandProperty("run", srcs).then(stages => {
        if (stages.length === 0) {
          return Computable.reject<RuleResult>(new Error("a 'generate' target requires a 'run' command"));
        }
        return assemblePipeline(srcs, stages, output);
      });
    }
  );
}

/** Stage the install (see {@link stagePipeline}, shared with command
 * substitution) and yield the pipeline action. */
function assemblePipeline(srcs: FileSet, stages: ResolvedCommandPipeline, output: Name | undefined): RuleResult {
  const { files, specs } = stagePipeline(stages, srcs);
  return createPipelineAction(files, specs, stages[0].stdin, output, "generate");
}

export const generateRule: RuleRegistration = { type: "generate", constraints: { [BUILD_OPERATION]: "build" }, evaluate: generate };
