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
 * The structured test report: the contract between a test rule and its
 * runner. The document is CTRF (Common Test Report Format, https://ctrf.io) —
 * a standard JSON test-results schema, so the artifact a test target delivers
 * is directly consumable by third-party tooling. The runner writes the
 * document as the test working directory's TEST_REPORT_FILENAME; the rule
 * delivers it as the test target's output artifact, and the driver reads it
 * back to summarize the run for the user.
 *
 * Note the summary start/stop are wall-clock times of the original run: a
 * cached-green report deliberately retains its original timings.
 *
 * (The runner side is standalone at runtime, so @fabr-build/js carries its own
 * implementation of this contract; the shapes must be kept in sync.)
 */

export type TestStatus = "passed" | "failed" | "skipped" | "pending" | "other";

export interface ITestResult {
  /** The test's own name (not including ancestor suite names) */
  name: string;
  status: TestStatus;
  /** Elapsed time in milliseconds */
  duration: number;
  /** Path of the test file, relative to the test working directory */
  filePath?: string;
  /** Failure description (failed tests only) */
  message?: string;
}

export interface ITestSummary {
  tests: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  other: number;
  /** Wall-clock start/stop of the run, epoch milliseconds */
  start: number;
  stop: number;
}

export interface ITestReport {
  results: {
    tool: { name: string };
    summary: ITestSummary;
    tests: ITestResult[];
  };
}

/** The report filename, relative to the test working directory */
export const TEST_REPORT_FILENAME = "ctrf-report.json";

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

/**
 * @return the parsed test report a test target delivered, or `undefined` if the
 * target produced no report artifact at all (rendered as "no tests"). A report
 * that IS present but cannot be parsed — malformed JSON, or valid JSON that
 * isn't a recognizable CTRF report — is a genuine failure and rejects, rather
 * than being silently swallowed as "no tests": a corrupt report is a real
 * problem worth surfacing.
 */
export function getTestReport(sources: SourceRef[]): Computable<ITestReport | undefined> {
  const sets = sources.filter((source): source is FileSet => source instanceof FileSet);
  return Computable.forAll(
    sets.map(set => set.get(TEST_REPORT_FILENAME)),
    (...files): Computable<ITestReport | undefined> | undefined => {
      const file = files.find(f => f !== undefined);
      return file?.readString().then((content): ITestReport => {
        let report: Partial<ITestReport>;
        try {
          report = JSON.parse(content) as Partial<ITestReport>;
        } catch (err) {
          throw new Error(
            `Malformed test report (${TEST_REPORT_FILENAME}): ${err instanceof Error ? err.message : String(err)}`
          );
        }
        if (!report.results?.summary || !Array.isArray(report.results.tests)) {
          throw new Error(`Malformed test report (${TEST_REPORT_FILENAME}): not a recognizable CTRF report`);
        }
        return report as ITestReport;
      });
    }
  );
}

