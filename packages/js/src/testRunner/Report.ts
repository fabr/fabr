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
 * itself — a CTRF document (https://ctrf.io) — is defined by @fabr-build/core
 * (support/TestResult.ts) and consumed there by the rules and the driver; the
 * runner executes standalone inside the test working directory — it cannot
 * reach the host's core at runtime — so it carries its own copies of the
 * (small) helpers. Keep them in sync with core.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ITestReport, ITestResult, ITestSummary } from "@fabr-build/core";

/**
 * The mounts a test installation is laid out under — the compile's own `src/`
 * and `build/`, reproduced there so each `.js.map` resolves (see TestPipeline).
 * Duplicated from the host rather than imported: a runner executes standalone in
 * the test process and cannot reach core at runtime. Keep in sync with
 * BuildJSCompile's COMPILE_SRC_DIR/COMPILE_OUT_DIR.
 */
const INSTALL_MOUNTS = ["src", "build"];

/**
 * How a test file should be NAMED in the report: as the target named it.
 *
 * Two corrections to the path a runner is handed. It should name what the user
 * wrote rather than the artifact that ran — fabr compiles ahead of the run, so
 * the file executed is `build/Foo.test.js` while the thing to point at is
 * `Foo.test.ts` — and the `.js.map` beside it records that authoritatively,
 * where a stem guess in the parallel source directory could not tell
 * `Foo.test.ts` from a `Foo.test.js` next to it. And the install's mount point
 * is not part of the name: a target whose `srcs` are `src:**` calls the file
 * `Foo.test.ts`, so reporting `src/Foo.test.ts` would be naming fabr's staging
 * rather than the target's own namespace.
 *
 * Degrades rather than fails: no map (a release build emits none) leaves the
 * compiled name, which is still mount-stripped. Memoized because the node:test
 * flavour asks per *test*, not per file.
 */
const reportPaths = new Map<string, string>();

export function reportPathOf(file: string): string {
  let name = reportPaths.get(file);
  if (name === undefined) {
    name = stripMount(path.relative(installRoot(), sourcePathOf(file) ?? file));
    reportPaths.set(file, name);
  }
  return name;
}

/** The root of the staged install, under which the mounts sit: a runner is
 * invoked with the compiled mount (`build/`) as its working directory. */
function installRoot(): string {
  return path.dirname(process.cwd());
}

/** Drop the leading install mount, so the name is the target's own. */
function stripMount(relative: string): string {
  const [first, ...rest] = relative.split(path.sep);
  return rest.length > 0 && INSTALL_MOUNTS.includes(first) ? rest.join(path.sep) : relative;
}

/**
 * The source a compiled file was emitted from, per its own `.js.map`, or
 * undefined when it cannot be known — no map (a release build emits none),
 * unreadable, or not JSON. Absolute, since a map's `sources` are relative to
 * the map itself.
 *
 * Shared rather than private: the snapshot resolver needs the same answer, to
 * name a record for the source rather than for the artifact that ran.
 */
export function sourcePathOf(compiled: string): string | undefined {
  try {
    const map = JSON.parse(fs.readFileSync(`${compiled}.map`, "utf8")) as { sources?: string[]; sourceRoot?: string };
    /* tsc emits one source per output; a `sources` with anything else in it is
     * not something this can meaningfully name, so take the first or nothing. */
    const [first] = map.sources ?? [];
    if (typeof first === "string") {
      return path.resolve(path.dirname(compiled), map.sourceRoot ?? "", first);
    }
  } catch {
    /* Fall through: the caller decides what an unknown source means. */
  }
  return undefined;
}

/** The directory a test file's recorded snapshots live in, beside it. */
const SNAPSHOT_DIR = "__snapshots__";
export const SNAPSHOT_EXT = ".snap";

/**
 * Where the compiled test file `testPath` keeps its recorded snapshots:
 * `__snapshots__/<source file name>.snap` beside it, the source being the one
 * its `.js.map` names. Without a map it is an existing record matching the
 * test by **stem**, and failing that one named for the compiled file.
 */
export function snapshotPathOf(testPath: string): string {
  const dir = path.join(path.dirname(testPath), SNAPSHOT_DIR);
  const source = sourcePathOf(testPath);
  if (source !== undefined) {
    return path.join(dir, path.basename(source) + SNAPSHOT_EXT);
  }
  const stem = stemOf(path.basename(testPath));
  const existing = readdir(dir).find(name => name.endsWith(SNAPSHOT_EXT) && stemOf(name.slice(0, -SNAPSHOT_EXT.length)) === stem);
  return path.join(dir, existing ?? path.basename(testPath) + SNAPSHOT_EXT);
}

/** A file's name with its final extension removed. */
function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    /* No records for this file yet — the ordinary first-run case. */
    return [];
  }
}

/** How a failure reads in the report: its one-line `message`, and a `trace`
 * where the message cannot carry the diagnosis. */
export interface IFailureDescription {
  message: string;
  trace?: string;
}

/** The frame every failure of node:test's snapshot assertion carries. */
const SNAPSHOT_FRAME = "(node:internal/test_runner/snapshot:";

/** node's advice for a missing record: a flag of the `node` command line,
 * which nobody running `fabr test` can pass. */
const NODE_UPDATE_ADVICE = /\s*Missing snapshots can be generated[^.]*\./;

/**
 * A failure of node:test's `t.assert.snapshot`, described in fabr's terms —
 * the remedy is `fabr test -u`, and a mismatch is a line diff of the recorded
 * value against the actual one — or undefined if `cause` is any other failure.
 */
export function describeSnapshotFailure(cause: Error): IFailureDescription | undefined {
  if (!cause.stack?.includes(SNAPSHOT_FRAME)) {
    return undefined;
  }
  const { actual, expected, code, cause: reason } = cause as Error & { actual?: unknown; expected?: unknown; code?: string; cause?: { code?: string } };
  if (typeof actual === "string" && typeof expected === "string") {
    return {
      message: "The value does not match its recorded snapshot. Run 'fabr test -u' to record the new value.",
      trace: `- recorded\n+ actual\n\n${lineDiff(expected.trim().split("\n"), actual.trim().split("\n")).join("\n")}`,
    };
  }
  /* No record file, or (with no underlying reason) no entry for this test in it. */
  if (code === "ERR_INVALID_STATE" && (reason === undefined || reason.code === "ENOENT")) {
    return { message: "This test has no recorded snapshot. Run 'fabr test -u' to record one." };
  }
  return { message: cause.message.replace(NODE_UPDATE_ADVICE, " Run 'fabr test -u' to record them again.") };
}

/** A line diff of `before` against `after`: common lines indented, the rest
 * marked `-` (only in `before`) or `+` (only in `after`). */
function lineDiff(before: string[], after: string[]): string[] {
  /* common[i][j]: the longest common subsequence of before[i..] and after[j..]. */
  const common = before.map(() => new Array<number>(after.length + 1).fill(0));
  common.push(new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
    } else if (j >= after.length || (i < before.length && common[i + 1][j] >= common[i][j + 1])) {
      lines.push(`- ${before[i++]}`);
    } else {
      lines.push(`+ ${after[j++]}`);
    }
  }
  return lines;
}


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
 * indented line per failed test, plus any trace indented beneath it. (Keep in
 * sync with core's copy.)
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
