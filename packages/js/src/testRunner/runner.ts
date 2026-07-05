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
 * Usage: node runner.js [--report=<path>] <test-file>...
 * Exit code 0 if everything passed; 1 if any test failed. The report document
 * (see Report.ts) is written to the given path in either case.
 */

import { run } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ITestResult } from "@fabr/core";
import { buildReport, formatTestFailures, formatTestSummary, TEST_REPORT_FILENAME } from "./Report";

/**
 * The fields we consume from node:test's test:pass / test:fail event data,
 * declared structurally so that the harness tolerates the (typed) shape
 * differences between node versions.
 */
interface ITestEvent {
  name: string;
  file?: string;
  skip?: boolean | string;
  todo?: boolean | string;
  details: {
    duration_ms?: number;
    /** 'suite' for describe-block completions, which aggregate their children */
    type?: string;
    error?: Error & { cause?: unknown };
  };
}

interface IRunnerOptions {
  report: string;
  files: string[];
}

function parseArgs(argv: string[]): IRunnerOptions {
  const options: IRunnerOptions = { report: TEST_REPORT_FILENAME, files: [] };
  for (const arg of argv) {
    if (arg.startsWith("--report=")) {
      options.report = arg.substring("--report=".length);
    } else {
      options.files.push(arg);
    }
  }
  return options;
}

function record(results: ITestResult[], event: ITestEvent, kind: "pass" | "fail"): void {
  if (event.details.type === "suite") {
    /* Suite completions aggregate their children; only individual tests (and
     * whole-file crashes, which arrive as failed tests) are recorded */
    return;
  }
  let status: ITestResult["status"] = kind === "fail" ? "failed" : "passed";
  if (kind === "pass" && event.skip) {
    status = "skipped";
  } else if (kind === "pass" && event.todo) {
    status = "pending";
  }
  results.push({
    name: event.name,
    filePath: event.file ? path.relative(process.cwd(), event.file) : undefined,
    status,
    duration: event.details.duration_ms ?? 0,
    message: kind === "fail" ? describeError(event.details.error) : undefined,
  });
}

/**
 * node:test wraps the thrown assertion error in an ERR_TEST_FAILURE error
 * whose cause is the interesting part; unwrap it where present.
 */
function describeError(error: (Error & { cause?: unknown }) | undefined): string {
  if (!error) {
    return "failed";
  }
  const cause = error.cause;
  if (cause instanceof Error) {
    return cause.message;
  } else if (cause !== undefined) {
    return String(cause);
  }
  return error.message;
}

function finish(results: ITestResult[], reportPath: string, start: number): void {
  const report = buildReport(results, start, Date.now());
  fs.writeFileSync(reportPath, JSON.stringify(report, undefined, 2));
  const failed = report.results.summary.failed;
  console.log(failed > 0 ? formatTestFailures(report) : formatTestSummary(report));
  process.exitCode = failed > 0 ? 1 : 0;
}

export function main(argv: string[]): void {
  const options = parseArgs(argv);
  const results: ITestResult[] = [];
  const start = Date.now();
  /* Each test file runs in its own child process; preload the test-globals
   * shim (describe/it/expect/...) into them via the inherited environment */
  const preload = `--require ${JSON.stringify(path.join(__dirname, "globals.js"))}`;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  const stream = run({ files: options.files.map(file => path.resolve(file)) });
  stream.on("test:pass", data => record(results, data as unknown as ITestEvent, "pass"));
  stream.on("test:fail", data => record(results, data as unknown as ITestEvent, "fail"));
  stream.once("end", () => finish(results, options.report, start));
  /* The event stream only flows (and thus only ends) if it is consumed */
  stream.resume();
}

if (require.main === module) {
  main(process.argv.slice(2));
}
