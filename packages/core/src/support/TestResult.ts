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
import { isJsonObject, readJsonFile } from "./Json";

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
  /** Failure description (failed tests only) — one line, the summary of what
   * went wrong. */
  message?: string;
  /**
   * Supporting detail for a failure that the message alone cannot carry (CTRF's
   * `trace`): a stack, or the output of a test file that died before any of its
   * tests ran. Kept apart from `message` because the failure list shows one line
   * per test — a trace is rendered under it, not folded into it.
   */
  trace?: string;
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
 * indented line per failed test — plus, for a failure carrying one, its trace
 * indented beneath. One line per test keeps a large red run readable (a matcher
 * message can be a whole diff); a trace is the exception because a test that
 * never ran has nothing else to say about itself.
 */
export function formatTestFailures(report: ITestReport): string {
  const lines = [formatTestSummary(report)];
  for (const test of report.results.tests) {
    if (test.status === "failed") {
      /* …unless the test IS the file (a load failure), where it would repeat. */
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

/** The summary fields every reader of a report relies on being numbers — the
 * counters, plus `start`/`stop` (CTRF requires them, and the merge computes
 * over them, so a report without them is not usable). */
const SUMMARY_COUNTERS = ["tests", "passed", "failed", "pending", "skipped", "other", "start", "stop"];

/**
 * Merge per-invocation CTRF reports into the one report a test target
 * delivers. The runner contract permits the caller to partition a target's
 * test files across invocations (fabr runs one file per invocation, so each
 * execution is admitted separately by the machine-wide funnel); each
 * invocation writes its own report and the target's is their sum. The order
 * is the caller's (the declared file order), so the merged document never
 * depends on scheduling; start/stop are the earliest and latest — under
 * parallel invocations the span, not the sum.
 */
export function mergeTestReports(reports: ITestReport[]): ITestReport {
  if (reports.length === 0) {
    throw new Error("mergeTestReports: no reports to merge");
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
 * Convert a parsed document to a report. The runner that wrote it is swappable
 * (`JS_TEST_RUNNER`), so this is third-party JSON, and this is the one place it
 * becomes an {@link ITestReport} — every consumer downstream relies on the
 * shape it was handed. Anything unrecognizable throws (attributed to the report
 * file by `readJsonFile`): a corrupt report is a real problem, never a silently
 * empty run.
 */
export function toTestReport(json: unknown): ITestReport {
  if (!isCtrfReport(json)) {
    throw new Error("not a recognizable CTRF report");
  }
  return json;
}

/** Whether a parsed document is a report fabr can read: a `results` block whose
 * summary counters are numbers and whose `tests` are objects — what every
 * formatter and status check here assumes it was given. */
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
      return file && readJsonFile(file, toTestReport);
    }
  );
}

