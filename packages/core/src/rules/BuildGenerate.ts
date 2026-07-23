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

import { BUILD_OPERATION, ResolvedCommandPipeline, TargetContext } from "../model/BuildContext";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { StageSpec } from "../support/Execute";
import { createPipelineAction } from "./PipelineAction";
import { RuleRegistration, RuleResult } from "./Types";

function generate(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [context.getFileSet("srcs"), context.getProjection("output")],
    (srcs: FileSet, output: Name | undefined) =>
      context.getCommandProperty("run", srcs).then(stages => {
        if (stages.length === 0) {
          return Computable.reject<RuleResult>(new Error("a 'generate' target requires a 'run' command"));
        }
        return assemblePipeline(srcs, stages, output);
      })
  );
}

/**
 * Stage the install and yield the pipeline action. A **single-stage** command
 * runs the tool *over* `srcs` (the npx-in-project layout: the tool mounts at the
 * sandbox root, its `node_modules` adjacent to the sources — so a source that
 * imports the tool, e.g. `astro.config.mjs` doing `import 'astro/config'`,
 * resolves). A **multi-stage** pipeline instead mounts each stage under its own
 * `.fabr-cmd-<n>/` subdir so the tools don't share a `node_modules`; the streams
 * connect them, and no source imports a pipe stage's modules.
 */
function assemblePipeline(srcs: FileSet, stages: ResolvedCommandPipeline, output: Name | undefined): RuleResult {
  const single = stages.length === 1;
  const mounts: FileSet[] = [];
  const specs: StageSpec[] = stages.map((stage, i) => {
    const dir = single ? undefined : `.fabr-cmd-${i}`;
    mounts.push(dir === undefined ? stage.runnable : FileSet.layout({ [dir]: stage.runnable }));
    return {
      argv: stage.runnable.toCommandLine(stage.args, dir === undefined ? undefined : { base: dir }),
      stdout: stage.stdout,
      stderr: stage.stderr,
      both: stage.both,
    };
  });
  const staged = FileSet.unionAll(srcs, ...mounts);
  return createPipelineAction(staged, specs, stages[0].stdin, output, "generate");
}

export const generateRule: RuleRegistration = { type: "generate", constraints: { [BUILD_OPERATION]: "build" }, evaluate: generate };
