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

import { expect } from "chai";
import { ITestReport, TestStatus } from "@fabr-build/core";
import { combinedReport, failedFiles, IRun } from "./TestRunAction";

/** A report of `tests`, each `[file, name, status]`, its summary counted from them. */
function reportOf(start: number, ...tests: Array<[string | undefined, string, TestStatus]>): ITestReport {
  const count = (status: TestStatus): number => tests.filter(([, , is]) => is === status).length;
  return {
    results: {
      tool: { name: "fabr-junit-runner" },
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        pending: 0,
        skipped: count("skipped"),
        other: 0,
        start,
        stop: start + 1,
      },
      tests: tests.map(([filePath, name, status]) => ({ name, status, duration: 0, ...(filePath === undefined ? {} : { filePath }) })),
    },
  };
}

describe("failedFiles", () => {
  it("names the source files whose tests failed, once each, sorted", () => {
    const report = reportOf(
      0,
      ["b/B.java", "x", "failed"],
      ["a/A.java", "y", "failed"],
      ["b/B.java", "z", "failed"],
      ["c/C.java", "w", "passed"]
    );
    expect(failedFiles(report)).to.deep.equal(["a/A.java", "b/B.java"]);
  });

  it("names none where a failure names no file, so every class runs again", () => {
    expect(failedFiles(reportOf(0, ["a/A.java", "y", "failed"], [undefined, "Engine", "failed"]))).to.equal(undefined);
  });
});

describe("combinedReport", () => {
  it("takes each file's tests from the last run that ran it, marking what passed on a retry as flaky", () => {
    const runs: IRun[] = [
      { report: reportOf(10, ["a/A.java", "flaky", "failed"], ["b/B.java", "steady", "passed"]) },
      { files: ["a/A.java"], report: reportOf(20, ["a/A.java", "flaky", "passed"]) },
    ];
    const report = combinedReport(runs);
    expect(report.results.tests.map(test => [test.filePath, test.name, test.status, test.flaky, test.retries])).to.deep.equal([
      ["a/A.java", "flaky", "passed", true, 1],
      ["b/B.java", "steady", "passed", undefined, undefined],
    ]);
    expect(report.results.summary).to.include({ tests: 2, passed: 2, failed: 0, start: 10, stop: 21 });
  });

  it("keeps a file that failed on every run failed", () => {
    const runs: IRun[] = [
      { report: reportOf(0, ["a/A.java", "broken", "failed"], ["b/B.java", "steady", "passed"]) },
      { files: ["a/A.java"], report: reportOf(1, ["a/A.java", "broken", "failed"]) },
    ];
    expect(combinedReport(runs).results.summary).to.include({ tests: 2, passed: 1, failed: 1 });
  });

  it("counts a run that died as every test of what it ran failing", () => {
    const runs: IRun[] = [
      { report: reportOf(0, ["a/A.java", "t", "failed"]) },
      { files: ["a/A.java"], error: new Error("the JVM crashed") },
      { files: ["a/A.java"], report: reportOf(2, ["a/A.java", "t", "passed"]) },
    ];
    expect(combinedReport(runs).results.tests[0]).to.include({ status: "passed", flaky: true, retries: 2 });
  });

  it("reads a run of every class as the latest for every file", () => {
    const runs: IRun[] = [
      { report: reportOf(0, [undefined, "Engine", "failed"], ["a/A.java", "t", "passed"]) },
      { report: reportOf(1, ["a/A.java", "t", "passed"]) },
    ];
    const report = combinedReport(runs);
    expect(report.results.tests.map(test => test.name)).to.deep.equal(["t"]);
    expect(report.results.summary).to.include({ tests: 1, failed: 0 });
  });
});
