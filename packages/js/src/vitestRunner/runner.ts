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
 * Fabr's test runner for VITEST: it runs the real vitest, from the target's own
 * dependencies, over the compiled test files — configured entirely from the
 * runner contract (no config file is read) and reporting through fabr's test
 * report. Vitest loads the tests through node's own module loader rather than
 * Vite's (`experimental.viteModuleRunner: false`), so what runs is what fabr
 * compiled; Vite's transforms (plugins, aliases, `import.meta.env`) do not
 * apply.
 *
 * Usage (the runner contract, same as every flavour):
 *   node runner.js --report=<path> --env=<node|jsdom> [--update-snapshots]
 *                  [--setup=<module|./staged path>]... <test-file>...
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ITestResult } from "@fabr-build/core";
import { buildReport, formatTestFailures, formatTestSummary } from "../testRunner/Report";
import { IRunnerOptions, parseRunnerArgs } from "../testRunner/RunTests";
import { IReportedError, IReportedModule, toRunFailure, toTestResults, vitestOptions } from "./VitestRun";

/** The first vitest that can load tests through node's own loader. */
const MINIMUM_VITEST = [4, 1] as const;

interface IVitest {
  close(): Promise<void>;
}

interface IVitestNode {
  startVitest(mode: "test", filters: string[], options: Record<string, unknown>): Promise<IVitest>;
}

/* A real `import()`: compiled as CommonJS, the keyword would become a
 * `require`, which cannot load vitest (an ES module graph). */
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

/**
 * Vitest's node API, from the TEST installation (the working directory): the
 * framework and its version are the target's choice, declared among its
 * `test_deps` like any other dependency.
 */
async function loadVitest(root: string): Promise<IVitestNode> {
  const fromInstall = createRequire(path.join(root, "index.js"));
  let manifest: string;
  try {
    manifest = fromInstall.resolve("vitest/package.json");
  } catch {
    throw new Error("These tests run under vitest, but 'vitest' is not among the target's dependencies.\nAdd it to the target's test_deps.");
  }
  const { version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string };
  const [major, minor] = (version ?? "").split(".").map(Number);
  if (!(major > MINIMUM_VITEST[0] || (major === MINIMUM_VITEST[0] && minor >= MINIMUM_VITEST[1]))) {
    throw new Error(`fabr runs vitest ${MINIMUM_VITEST.join(".")} or later, but the target's vitest is ${version ?? "an unreadable version"}.`);
  }
  return (await importModule(pathToFileURL(fromInstall.resolve("vitest/node")).href)) as IVitestNode;
}

/** Run the files and return their results, in the order vitest reports them. */
async function runTests(options: IRunnerOptions, root: string): Promise<ITestResult[]> {
  const { startVitest } = await loadVitest(root);
  const results: ITestResult[] = [];
  const reporter = {
    onTestRunEnd(modules: ReadonlyArray<IReportedModule>, unhandled: ReadonlyArray<IReportedError>): void {
      results.push(...modules.flatMap(toTestResults), ...unhandled.map(toRunFailure));
    },
  };
  const vitest = await startVitest("test", [], vitestOptions(options, root, reporter));
  await vitest.close();
  return results;
}

export function main(argv: string[]): void {
  const options = parseRunnerArgs(argv);
  const start = Date.now();
  runTests(options, process.cwd())
    .then(results => {
      const report = buildReport(results, start, Date.now());
      fs.writeFileSync(options.report, JSON.stringify(report, undefined, 2));
      const failed = report.results.summary.failed;
      console.log(failed > 0 ? formatTestFailures(report) : formatTestSummary(report));
      /* Vitest's server and workers are closed; whatever a test leaked must not
       * keep this process alive. */
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err: Error) => {
      console.error(err.stack ?? err.message);
      process.exit(1);
    });
}

if (require.main === module) {
  main(process.argv.slice(2));
}
