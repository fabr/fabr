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
 * Fabr's test runner for vitest: it runs the real vitest, from the target's own
 * dependencies, over the compiled test files, configured entirely from the
 * runner contract (no config file is read), and writes fabr's test report.
 * Vitest loads the tests through node's own module loader
 * (`experimental.viteModuleRunner: false`), so Vite's transforms (plugins,
 * aliases, `import.meta.env`) do not apply.
 *
 * Usage (the runner contract, as for every runner):
 *   node runner.js --report=<path> --env=<node|jsdom> [--update-snapshots]
 *                  [--name-pattern=<regex>] [--setup=<module|./staged path>]...
 *                  [--pnp=<file>] [--reads=<file>] <test-file>...
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ITestResult } from "@fabr-build/core";
import { parseJson, toJsonObject } from "../support/Json";
import { buildReport, endAfterReport } from "../testRunner/Report";
import { childPreloads, IRunnerOptions, parseRunnerArgs } from "../testRunner/RunTests";
import { installPnpRuntime } from "../pnp/Runtime";
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
 * Load vitest's node API from the test installation, resolved from `root`, the
 * working directory inside it. Throws where vitest is not installed there (it
 * belongs in the target's `test_deps`) or is older than
 * {@link MINIMUM_VITEST}.
 */
async function loadVitest(root: string): Promise<IVitestNode> {
  const fromInstall = createRequire(path.join(root, "index.js"));
  let manifest: string;
  try {
    manifest = fromInstall.resolve("vitest/package.json");
  } catch {
    throw new Error(
      "These tests run under vitest, but 'vitest' is not among the target's dependencies.\nAdd it to the target's test_deps."
    );
  }
  const written = parseJson(fs.readFileSync(manifest, "utf8"), manifest, toJsonObject).version;
  const version = typeof written === "string" ? written : undefined;
  const [major, minor] = (version ?? "").split(".").map(Number);
  if (!(major > MINIMUM_VITEST[0] || (major === MINIMUM_VITEST[0] && minor >= MINIMUM_VITEST[1]))) {
    throw new Error(
      `fabr runs vitest ${MINIMUM_VITEST.join(".")} or later, but the target's vitest is ${version ?? "an unreadable version"}.`
    );
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
  const children = childPreloads(options);
  const vitest = await startVitest(
    "test",
    [],
    vitestOptions(options, root, [path.join(__dirname, "preload.js")], reporter, children.preloads)
  );
  await vitest.close();
  children.finish();
  return results;
}

/**
 * Run the test files `argv` names under vitest and write the report. The
 * process exits 1 where a test failed or the run could not be made.
 */
export function main(argv: string[]): void {
  const options = parseRunnerArgs(argv);
  if (options.pnp !== undefined) {
    installPnpRuntime(options.pnp);
  }
  const start = Date.now();
  runTests(options, process.cwd())
    .then(results => {
      const report = buildReport(results, start, Date.now());
      fs.writeFileSync(options.report, JSON.stringify(report, undefined, 2));
      const failed = report.results.summary.failed;
      /* Vitest's server and workers are closed; end the process whatever a test
       * left running. */
      endAfterReport(failed > 0 ? 1 : 0);
    })
    .catch((err: Error) => {
      console.error(err.stack ?? err.message);
      process.exit(1);
    });
}
