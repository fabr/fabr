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
import { FileSet } from "../core/FileSet";
import type { SourceRef } from "../core/Repository";

/**
 * The structured test report: the contract between a test rule and its runner.
 * The runner writes the document as the test working directory's
 * TEST_REPORT_FILENAME; the rule delivers it as the test target's output
 * artifact, and the driver reads it back to summarize the run for the user.
 * (The runner side is standalone at runtime, so @fabr/js carries its own
 * implementation of this contract; the shapes must be kept in sync.)
 */

export type TestStatus = "pass" | "fail" | "skip" | "todo";

export interface ITestResult {
  /** The test's own name (not including ancestor suite names) */
  name: string;
  /** Path of the test file, relative to the test working directory */
  file?: string;
  status: TestStatus;
  durationMs?: number;
  /** Failure description (failed tests only) */
  error?: string;
}

export interface ITestCounts {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  total: number;
}

export interface ITestReport {
  version: 1;
  counts: ITestCounts;
  tests: ITestResult[];
}

/** The report filename, relative to the test working directory */
export const TEST_REPORT_FILENAME = "fabr-test-report.json";

/**
 * @return a one-line description of the run ("12 tests passed", "2 of 14
 * tests failed", ...).
 */
export function formatTestSummary(report: ITestReport): string {
  const { pass, fail, skip, todo, total } = report.counts;
  const notRun = skip + todo;
  if (fail > 0) {
    return `${fail} of ${testCount(total)} failed`;
  } else if (notRun > 0) {
    return `${testCount(pass)} passed (${notRun} skipped)`;
  } else {
    return `${testCount(pass)} passed`;
  }
}

/**
 * @return a multi-line failure report: the summary line followed by one
 * indented line per failed test, or just the summary if everything passed.
 */
export function formatTestFailures(report: ITestReport): string {
  const lines = [formatTestSummary(report)];
  for (const test of report.tests) {
    if (test.status === "fail") {
      const where = test.file ? ` (${test.file})` : "";
      const detail = test.error ? `: ${firstLine(test.error)}` : "";
      lines.push(`  ${test.name}${where}${detail}`);
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

/**
 * @return the parsed test report delivered by a test target's sources, if
 * there is one (an artifact that isn't a recognizable report is treated as
 * absent rather than failing the caller's rendering).
 */
export function getTestReport(sources: SourceRef[]): Computable<ITestReport | undefined> {
  const sets = sources.filter((source): source is FileSet => source instanceof FileSet);
  return Computable.forAll(
    sets.map(set => set.get(TEST_REPORT_FILENAME)),
    (...files): Computable<ITestReport | undefined> | undefined => {
      const file = files.find(f => f !== undefined);
      return file?.readString().then(content => {
        const report = JSON.parse(content) as Partial<ITestReport>;
        return report.version === 1 && report.counts && report.tests ? (report as ITestReport) : undefined;
      });
    }
  );
}

/**
 * A test run completed mechanically but some tests failed — as distinct from
 * an ExecutionError (the run itself couldn't be performed). Test rules throw
 * this with a pre-rendered summary ("N of M tests failed: ..."), which the
 * driver reports against the target under test rather than as a build failure.
 */
export class TestsFailedError extends Error {
  /** Number of failing tests */
  public readonly failed: number;
  /** Total number of tests that ran */
  public readonly total: number;

  constructor(message: string, failed: number, total: number) {
    super(message);
    this.failed = failed;
    this.total = total;
  }
}
