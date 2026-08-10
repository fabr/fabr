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
    name = stripMount(path.relative(process.cwd(), sourcePathOf(file) ?? file));
    reportPaths.set(file, name);
  }
  return name;
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
