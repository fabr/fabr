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
 * The runner-side implementation of the test report contract. The contract
 * itself (document shape and filename) is defined by @fabr/core
 * (support/TestResult.ts) and consumed there by the rules and the driver; the
 * runner executes standalone inside the test working directory — it cannot
 * reach the host's core at runtime — so it carries its own copies of the
 * (small) formatting helpers. Keep them in sync with core.
 */

import type { ITestCounts, ITestReport, ITestResult } from "@fabr/core";

/** The report filename, relative to the test working directory (= core's TEST_REPORT_FILENAME) */
export const TEST_REPORT_FILENAME = "fabr-test-report.json";

export function countResults(tests: ITestResult[]): ITestCounts {
  const counts: ITestCounts = { pass: 0, fail: 0, skip: 0, todo: 0, total: tests.length };
  for (const test of tests) {
    counts[test.status]++;
  }
  return counts;
}

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
