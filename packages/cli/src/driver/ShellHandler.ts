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

import { join } from "node:path";
import {
  BuildAction,
  BuildCache,
  Computable,
  Diagnostic,
  executeInteractive,
  IStagedCommand,
  IStagedStep,
  Log,
  variableEntry,
} from "@fabr-build/core";
import { withTerminalSuspended } from "./Terminal";

const DIAG_SHELL = Diagnostic.Info<{ name: string; dir: string; commands: string }>(
  "Sandbox for '{name}' staged at {dir}\nThe build step would run:\n{commands}\nOpening a shell there with the build's own environment — exit to clean up. Bare tools like `ls` won't resolve (no PATH); run the command above (absolute paths) or set PATH yourself."
);
const DIAG_NO_SANDBOX = Diagnostic.Error<{ name: string }>(
  "'{name}' has no command sandbox to shell into (it yields content directly, not a build step)"
);

/** The most commands printed; a step running more (a test run, one per file) is summarised. */
const SHOWN_COMMANDS = 3;

/**
 * Stage `action`'s inputs and tool mounts for `fabr shell`, as its build step
 * would see them, into a work dir in the cache's work tree, log the
 * commands the step would run, and open an interactive shell (`$SHELL`, else
 * `/bin/sh`) in the step's working directory with the step's environment.
 * `action` itself is not run. The work dir is removed when the shell exits.
 * The step stages itself ({@link IBuildActionDefinition.stage}).
 *
 * Resolves to the shell's exit status. Where there is no action, or its step
 * cannot stage itself, an error is logged and it resolves to 1.
 */
export function shellInto(cache: BuildCache, name: string, action: BuildAction | undefined, log: Log): Computable<number> {
  const stage = action?.step.stage;
  if (action === undefined || stage === undefined) {
    log.log(DIAG_NO_SANDBOX, { name });
    return Computable.resolve(1);
  }
  const sandbox = cache.createWorkDir("shell-");
  /* Laid out as the step's own directory, so a printed command, which names
   * the tree pool from the working directory, runs there as written. */
  const dir = cache.makeStepDir(sandbox);
  return stage(action, dir, files => cache.ensureTree(files))
    .then(staged => {
      const cwd = join(dir, staged.cwd);
      log.log(DIAG_SHELL, { name, dir: cwd, commands: describeCommands(staged) });
      /* The shell gets the step's environment, not fabr's, and owns the
       * terminal until it exits. */
      return withTerminalSuspended(() => executeInteractive(process.env.SHELL || "/bin/sh", [], cwd, Object.fromEntries(staged.env)));
    })
    .finally(() => cache.releaseWorkDir(sandbox));
}

/** Describe the commands a staged step would run, as `$ …` lines to reproduce by hand:
 * a pipeline's stages joined with `|`, each with its redirections, the first
 * {@link SHOWN_COMMANDS} and a count of the rest. */
function describeCommands({ commands, env }: IStagedStep): string {
  if (commands.length === 0) {
    return "  (this step runs no external command)";
  }
  const lines = commands.slice(0, SHOWN_COMMANDS).map(command => `  $ ${commandText(command, env)}`);
  if (commands.length > SHOWN_COMMANDS) {
    lines.push(`  … and ${commands.length - SHOWN_COMMANDS} more like it`);
  }
  if (env.size > 0) {
    lines.push(`  with ${[...env].map(([variable, value]) => `${variable}=${quote(value)}`).join(" ")}`);
  }
  return lines.join("\n");
}

/** Write `command` as a shell writes it: each stage's own variables that `env`, the
 * step's, does not set, its argv and its redirections, the first stage's standard
 * input after its argv, the stages joined with `|`. */
function commandText({ stages, stdin }: IStagedCommand, env: ReadonlyMap<string, string>): string {
  return stages
    .map(({ argv, stdout, stderr, mergedTo, env: own = [] }, index) =>
      [
        ...own.map(variableEntry).flatMap(([name, value]) => (env.has(name) ? [] : [`${name}=${quote(value)}`])),
        ...argv.map(quote),
        ...(index === 0 && stdin !== undefined ? [`< ${quote(stdin)}`] : []),
        ...(stdout === undefined ? [] : [`> ${quote(stdout)}`]),
        ...(stderr === undefined ? [] : [`2> ${quote(stderr)}`]),
        ...(mergedTo === "out" ? ["2>&1"] : mergedTo === "err" ? ["1>&2"] : []),
      ].join(" ")
    )
    .join(" | ");
}

/** Quote an argument minimally for the shell, so a printed command is copy-pasteable. */
function quote(arg: string): string {
  return /[^\w./:@=-]/.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg;
}
