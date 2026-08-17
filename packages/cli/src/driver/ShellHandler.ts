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

import {
  BuildAction,
  BuildCache,
  Computable,
  Diagnostic,
  executeInteractive,
  FileSet,
  findExecutable,
  Log,
  writeFileSet,
} from "@fabr-build/core";
import { withTerminalSuspended } from "./Terminal";

const DIAG_SHELL = Diagnostic.Info<{ name: string; dir: string; commands: string }>(
  "Sandbox for '{name}' staged at {dir}\nThe build step would run:\n{commands}\nOpening a shell there with the build's own (clean) environment — exit to clean up. Bare tools like `ls` won't resolve (no PATH); run the command above (absolute paths) or set PATH yourself."
);
const DIAG_NO_SANDBOX = Diagnostic.Error<{ name: string }>(
  "'{name}' has no command sandbox to shell into (it yields content directly, not a build step)"
);

/**
 * `fabr shell <target>`: stage the target's build-action sandbox — its resolved
 * inputs (`srcs`) and tool mounts, exactly as the build step would see them —
 * into a work dir — the real thing, from the cache's own work tree, so the
 * sandbox sits exactly where the step's would — print the command the step would
 * run, and open an interactive shell there so the environment can be reproduced
 * and inspected by hand. The dir is removed when the shell exits. Fabr's
 * analogue of Bazel's --sandbox_debug.
 *
 * The target's own action is withheld (the point is to run it by hand); its
 * dependencies are built as usual, since they are what fills the sandbox.
 */
export function shellInto(cache: BuildCache, name: string, action: BuildAction | undefined, log: Log): Computable<number> {
  const files = action?.inputs.files;
  if (!(files instanceof FileSet)) {
    log.log(DIAG_NO_SANDBOX, { name });
    return Computable.resolve(1);
  }
  const dir = cache.createWorkDir("shell-");
  return writeFileSet(dir, files)
    .then(() => {
      log.log(DIAG_SHELL, { name, dir, commands: describeCommands(action!) });
      /* $SHELL is the user's login shell; fall back to a POSIX shell. Launched
       * with the build step's own env (a clean {}), NOT the parent's — so the
       * sandbox faithfully reflects what the build runs under (the printed command
       * uses absolute paths so it stays runnable there). The shell owns the
       * terminal for as long as the user is in it. */
      return withTerminalSuspended(() => executeInteractive(process.env.SHELL || "/bin/sh", [], dir, {}));
    })
    .finally(() => cache.releaseWorkDir(dir));
}

/** The command(s) the staged step would run, as `$ …` lines for the user to
 * reproduce by hand: a pipeline's stages joined with `|`, or a single exec argv.
 * The leading executable of each is resolved to an absolute path (as the build
 * itself resolves it), so the command runs in the sandbox's clean, PATH-less env. */
function describeCommands(action: BuildAction): string {
  const { spec, argv } = action.inputs;
  if (typeof spec === "string") {
    const stages = JSON.parse(spec) as Array<{ argv: string[] }>;
    return "  $ " + stages.map(stage => renderArgv(stage.argv)).join(" | ");
  }
  if (Array.isArray(argv)) {
    return "  $ " + renderArgv(argv as string[]);
  }
  return "  (this step runs no external command)";
}

/** Quote an argv, resolving its executable (argv[0]) to an absolute path — the
 * build resolves it via the same {@link findExecutable}, and the sandbox shell
 * has no PATH, so a bare name would not run there. Best-effort: an unresolvable
 * name is left as written. */
function renderArgv(argv: string[]): string {
  const [cmd, ...rest] = argv;
  let resolved = cmd;
  try {
    resolved = findExecutable(cmd);
  } catch {
    /* leave the bare name — the user can still see what it was */
  }
  return [resolved, ...rest].map(quote).join(" ");
}

/** Minimal shell quoting so a printed command is copy-pasteable. */
function quote(arg: string): string {
  return /[^\w./:@=-]/.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg;
}
