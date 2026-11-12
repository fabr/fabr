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
 * The native test runner (`fabr-test-runner`): node:test, driven by the runner
 * core (RunTests.ts), with globals.ts preloaded into each test process.
 *
 * Usage: fabr-test-runner [--report=<path>] [--env=node] [--update-snapshots]
 *                         [--name-pattern=<regex>] [--setup=<module|./staged path>]...
 *                         [--pnp=<file>] [--reads=<file>] <test-file>...
 * Exit code 0 if everything passed; 1 if any test failed. The report document
 * (see Report.ts) is written to the given path in either case.
 */

import * as path from "node:path";
import { atLeastNode, IRunnerOptions, parseRunnerArgs, runTestFiles } from "./RunTests";

/** The node version from which node:test's snapshot assertions need no flag. */
const SNAPSHOT_NODE = [23, 4] as const;

/** Refuse every environment but `node`: this flavour installs no DOM (the jest
 * and vitest flavours do). */
function requireSupportedEnvironment(options: IRunnerOptions): void {
  if (options.env !== "node") {
    throw new Error(
      `The fabr test runner provides no '${options.env}' environment — it runs tests directly in node.\n` +
        "A target declaring the `dom` flag (in deps or test_deps) runs its tests under jsdom, which only the jest and vitest " +
        "frameworks supply: set test_framework = jest or vitest (framework on a js_test), or drop the flag if the tests need no DOM."
    );
  }
}

/** Run the test files the invocation names. Throws for an environment other
 * than `node`, and for `--update-snapshots` before node 23.4. */
export function main(argv: string[]): void {
  const options = parseRunnerArgs(argv);
  requireSupportedEnvironment(options);
  if (options.update && !atLeastNode(SNAPSHOT_NODE[0], SNAPSHOT_NODE[1])) {
    throw new Error(
      `Recorded snapshots need node ${SNAPSHOT_NODE.join(".")} or later (this is ${process.versions.node}), so there is nothing to update`
    );
  }
  runTestFiles(options, [path.join(__dirname, "globals.js")]);
}
