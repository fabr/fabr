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
 * The fabr test runner: a thin harness over node:test. Fabr owns the
 * orchestration — it invokes this entry point with the test files to run and
 * collects the structured report — while the test files themselves use
 * node:test's native describe/it plus whatever assertion/mock libraries the
 * target declares as ordinary dependencies.
 *
 * Usage: node runner.js [--report=<path>] [--env=node] [--update-snapshots] <test-file>...
 * Exit code 0 if everything passed; 1 if any test failed. The report document
 * (see Report.ts) is written to the given path in either case.
 *
 * This is the base flavour: the runner core (RunTests.ts) plus a preload that
 * installs the describe/it globals and nothing else. The jest-compatibility
 * flavour (../jestRunner) is the same core with a much larger preload.
 */

import * as path from "node:path";
import { IRunnerOptions, parseRunnerArgs, runTestFiles } from "./RunTests";

/**
 * Environments this flavour provides. It runs tests in the node process it is
 * given, so `node` is the only one it can honestly claim — a target compiled
 * for the browser needs a runner that installs a DOM (the jest flavour does).
 * Said plainly rather than by silently running DOM tests without a DOM.
 */
function requireSupportedEnvironment(options: IRunnerOptions): void {
  if (options.env !== "node") {
    throw new Error(
      `The fabr test runner provides no '${options.env}' environment — it runs tests directly in node.\n` +
        "Use a runner that supplies one (test_runner = @fabr-build/js-tools/jest-runner), or build the target for node."
    );
  }
}

export function main(argv: string[]): void {
  const options = parseRunnerArgs(argv);
  requireSupportedEnvironment(options);
  if (options.update) {
    /* Nothing in this flavour records expectations yet, so `fabr test -u` would
     * silently do nothing. Better to say so. */
    throw new Error("The fabr test runner does not support recorded snapshots yet, so there is nothing to update");
  }
  /* Each test file runs in its own child process; the test-globals shim
   * (describe/it/...) is preloaded into each. */
  runTestFiles(options, [path.join(__dirname, "globals.js")]);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
