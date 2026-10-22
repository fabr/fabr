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
 * Run a tool's `main` as this process's entry point. A `main` that returns (or
 * resolves to) a number sets the exit status to it; one that fails reports its
 * message alone and exits with `failureStatus`.
 */
export function runMain(main: () => number | void | Promise<number | void>, failureStatus = 1): void {
  Promise.resolve()
    .then(main)
    .then(
      status => {
        if (typeof status === "number") {
          process.exitCode = status;
        }
      },
      (err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = failureStatus;
      }
    );
}
