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

import { Computable, executeInteractive, findExecutable, RunnableFileSet, writeFileSet } from "@fabr/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `fabr run`'s execution half — kept apart from the driver's model/dispatch
 * concerns. Stage the runnable's install into a fresh temp dir and launch it
 * *interactively*: inherited stdio, so args, pipes, tty and the exit code all
 * pass through, and it runs in the user's own working directory (the entry is
 * anchored at the staged dir, so its module/resource resolution still points at
 * the install regardless of cwd). Returns the program's exit code.
 *
 * This shares the launch reduction (`toCommandLine`) with the codegen `run`
 * build step; the intentional differences from that path — inherited (not
 * captured) stdio, the user's cwd (not the staged dir), and passing the exit
 * code through rather than failing on non-zero — are exactly what makes running
 * a program interactive rather than a cached build step.
 */
export function runInteractive(runnable: RunnableFileSet, callerArgs: string[]): Computable<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-run-"));
  const argv = runnable.toCommandLine(callerArgs, { anchor: dir });
  return writeFileSet(dir, runnable)
    .then(() => executeInteractive(findExecutable(argv[0]), argv.slice(1)))
    .then(code => {
      fs.rmSync(dir, { recursive: true, force: true });
      return code;
    });
}
