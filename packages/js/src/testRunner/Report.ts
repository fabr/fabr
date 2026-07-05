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
 * itself — a CTRF document (https://ctrf.io) — is defined by @fabr/core
 * (support/TestResult.ts) and consumed there by the rules and the driver; the
 * runner executes standalone inside the test working directory — it cannot
 * reach the host's core at runtime — so it carries its own copies of the
 * (small) helpers. Keep them in sync with core.
 */

import type { ITestReport, ITestResult, ITestSummary } from "@fabr/core";

/** The report filename, relative to the test working directory (= core's TEST_REPORT_FILENAME) */
export const TEST_REPORT_FILENAME = "ctrf-report.json";

export function buildReport(tests: ITestResult[], start: number, stop: number): ITestReport {
  const summary: ITestSummary = { tests: tests.length, passed: 0, failed: 0, pending: 0, skipped: 0, other: 0, start, stop };
  for (const test of tests) {
    summary[test.status]++;
  }
  return { results: { tool: { name: "fabr" }, summary, tests } };
}

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
 * @return a multi-line failure report: the summary line followed by one
 * indented line per failed test, or just the summary if everything passed.
 */
export function formatTestFailures(report: ITestReport): string {
  const lines = [formatTestSummary(report)];
  for (const test of report.results.tests) {
    if (test.status === "failed") {
      const where = test.filePath ? ` (${test.filePath})` : "";
      const detail = test.message ? `: ${firstLine(test.message)}` : "";
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
