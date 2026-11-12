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

import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import type { SourceRef } from "../core/Repository";
import { isJsonObject, readJsonFile } from "./Json";
import { FabrError, TestsFailedError } from "../core/Errors";

/*
 * The test report, the document a test runner writes and a test target
 * produces, is CTRF (Common Test Report Format, https://ctrf.io). Each runner
 * invocation writes one to the file its `--report` names; the test-run step
 * merges them ({@link mergeTestReports}) into TEST_REPORT_FILENAME, and the
 * driver reads it back to summarize the run.
 *
 * @fabr-build/js-tools has its own copy of these shapes
 * (testRunner/Report.ts): keep the two in step.
 */

/** A test's outcome. */
export type TestStatus = "passed" | "failed" | "skipped" | "pending" | "other";

export interface ITestResult {
  /** The test's own name, without its suites' names */
  name: string;
  status: TestStatus;
  /** Elapsed time in milliseconds */
  duration: number;
  /** The test file's source path (`packages/x/src/Foo.test.ts`), or its
   * compiled name where no source map names a source */
  filePath?: string;
  /** A one-line description of the failure (failed tests only). */
  message?: string;
  /** A failure's further detail (CTRF's `trace`): a stack, or the output of a
   * test file that died before any of its tests ran. Shown beneath the
   * message. */
  trace?: string;
}

export interface ITestSummary {
  tests: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  other: number;
  /** The wall-clock start and stop of the run, in epoch milliseconds; a
   * report served from the cache keeps its original run's. */
  start: number;
  stop: number;
}

/** A CTRF test report. */
export interface ITestReport {
  results: {
    tool: { name: string };
    summary: ITestSummary;
    tests: ITestResult[];
  };
}

/** The report's file name, relative to the test working directory */
export const TEST_REPORT_FILENAME = "ctrf-report.json";

/** The file name of a measured test run's coverage, an lcov document naming
 * each source by its source path. */
export const COVERAGE_REPORT_FILENAME = "lcov.info";

/**
 * @return a one-line description of the run ("12 tests passed", "2 of 14
 * tests failed", ...).
 */
export function formatTestSummary(report: ITestReport): string {
  const { tests, passed, failed, pending, skipped, other } = report.results.summary;
  const notRun = skipped + pending + other;
  if (failed > 0) {
    return `${failed} of ${testCount(tests)} failed`;
  } else if (notRun > 0) {
    return `${testCount(passed)} passed (${notRun} skipped)`;
  } else {
    return `${testCount(passed)} passed`;
  }
}

/**
 * @return a multi-line failure report: the summary line, then one indented
 * line per failed test (its name, file and the first line of its message),
 * each with its trace, if any, indented beneath.
 */
export function formatTestFailures(report: ITestReport): string {
  const lines = [formatTestSummary(report)];
  for (const test of report.results.tests) {
    if (test.status === "failed") {
      /* The file, unless the test is named as the file (a load failure). */
      const where = test.filePath && test.filePath !== test.name ? ` (${test.filePath})` : "";
      const detail = test.message ? `: ${firstLine(test.message)}` : "";
      lines.push(`  ${test.name}${where}${detail}`);
      if (test.trace) {
        lines.push(...test.trace.split("\n").map(line => `    ${line}`));
      }
    }
  }
  return lines.join("\n");
}

function testCount(n: number): string {
  return `${n} test${n === 1 ? "" : "s"}`;
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.substring(0, newline);
}

/** The summary fields a readable report must have as numbers. */
const SUMMARY_COUNTERS = ["tests", "passed", "failed", "pending", "skipped", "other", "start", "stop"];

/**
 * Merge the reports of several runner invocations into one: the counts
 * summed, the tests concatenated in the order given, `start` the earliest and
 * `stop` the latest, and the first report's tool.
 * @throws FabrError if `reports` is empty.
 */
export function mergeTestReports(reports: ITestReport[]): ITestReport {
  if (reports.length === 0) {
    throw new FabrError("mergeTestReports: no reports to merge");
  }
  const parts = reports.map(report => report.results);
  const summaries = parts.map(part => part.summary);
  const sum = (pick: (summary: ITestSummary) => number): number => summaries.reduce((total, summary) => total + pick(summary), 0);
  return {
    results: {
      tool: parts[0].tool,
      summary: {
        tests: sum(summary => summary.tests),
        passed: sum(summary => summary.passed),
        failed: sum(summary => summary.failed),
        pending: sum(summary => summary.pending),
        skipped: sum(summary => summary.skipped),
        other: sum(summary => summary.other),
        start: Math.min(...summaries.map(summary => summary.start)),
        stop: Math.max(...summaries.map(summary => summary.stop)),
      },
      tests: parts.flatMap(part => part.tests),
    },
  };
}

/**
 * Convert a parsed document to an {@link ITestReport}.
 * @throws FabrError if it is not a CTRF report fabr can read.
 */
export function toTestReport(json: unknown): ITestReport {
  if (!isCtrfReport(json)) {
    throw new FabrError("not a recognizable CTRF report");
  }
  return json;
}

/** @return true if a parsed document is a report fabr can read (a `results`
 * block whose summary fields are numbers and whose `tests` are objects),
 * otherwise false. */
function isCtrfReport(document: unknown): document is ITestReport {
  if (!isJsonObject(document) || !isJsonObject(document.results)) {
    return false;
  }
  const { summary, tests } = document.results;
  return (
    isJsonObject(summary) &&
    SUMMARY_COUNTERS.every(counter => typeof summary[counter] === "number") &&
    Array.isArray(tests) &&
    tests.every(isJsonObject)
  );
}

/** @return the failure a test report states, or undefined where every test passed. */
export function testFailureOf(report: ITestReport): TestsFailedError | undefined {
  const { summary } = report.results;
  return summary.failed > 0 ? new TestsFailedError(formatTestFailures(report), summary.failed, summary.tests, report) : undefined;
}

/**
 * @return true if the test report among a test run's `output` records a failed
 * test, otherwise false (and false where the output holds no report).
 */
export function hasTestFailures(output: FileSet): Computable<boolean> {
  const file = output.getFile(TEST_REPORT_FILENAME);
  if (file === undefined) {
    return Computable.resolve(false);
  }
  return readJsonFile(file, toTestReport).then(report => report.results.summary.failed > 0);
}

/**
 * @return the test report among `sources` (what a name was built to): one
 * source's report as it is, several sources' merged, or undefined where none
 * holds one. Rejects where a report is present but is not a readable CTRF
 * report.
 */
export function getTestReport(sources: SourceRef[]): Computable<ITestReport | undefined> {
  const sets = sources.filter((source): source is FileSet => source instanceof FileSet);
  return Computable.forAll(
    sets.map(set => set.get(TEST_REPORT_FILENAME)),
    (...files): Computable<ITestReport | undefined> | undefined => {
      const present = files.filter((file): file is IFile => file !== undefined);
      if (present.length === 0) {
        return undefined;
      }
      return Computable.forAll(
        present.map(file => readJsonFile(file, toTestReport)),
        (...reports: ITestReport[]) => (reports.length === 1 ? reports[0] : mergeTestReports(reports))
      );
    }
  );
}
