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

/* Note: this file is run by the fabr test harness itself (node:test based),
 * not by the workspace jest setup. */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { ITestResult } from "@fabr/core";
import { buildReport, formatTestFailures, formatTestSummary } from "./Report";

function test(name: string, status: ITestResult["status"], extra?: Partial<ITestResult>): ITestResult {
  return { name, status, duration: 0, ...extra };
}

describe("buildReport", () => {
  it("summarizes by status", () => {
    const report = buildReport(
      [test("a", "passed"), test("b", "failed"), test("c", "passed"), test("d", "skipped"), test("e", "pending")],
      100,
      250
    );
    assert.deepEqual(report.results.summary, {
      tests: 5,
      passed: 2,
      failed: 1,
      pending: 1,
      skipped: 1,
      other: 0,
      start: 100,
      stop: 250,
    });
    assert.equal(report.results.tool.name, "fabr");
  });

  it("summarizes an empty run", () => {
    assert.deepEqual(buildReport([], 5, 7).results.summary, {
      tests: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      other: 0,
      start: 5,
      stop: 7,
    });
  });
});

describe("formatTestSummary", () => {
  it("reports an all-green run", () => {
    assert.equal(formatTestSummary(buildReport([test("a", "passed"), test("b", "passed")], 0, 0)), "2 tests passed");
  });

  it("mentions skipped tests", () => {
    assert.equal(
      formatTestSummary(buildReport([test("a", "passed"), test("b", "skipped")], 0, 0)),
      "1 test passed (1 skipped)"
    );
  });

  it("reports failures", () => {
    assert.equal(formatTestSummary(buildReport([test("a", "failed"), test("b", "passed")], 0, 0)), "1 of 2 tests failed");
  });
});

describe("formatTestFailures", () => {
  it("lists each failed test with its location and first message line", () => {
    const text = formatTestFailures(
      buildReport(
        [
          test("works", "passed"),
          test("breaks", "failed", { filePath: "core/Thing.test.js", message: "expected 1 to equal 2\nlong stack" }),
          test("also breaks", "failed"),
        ],
        0,
        0
      )
    );
    assert.deepEqual(text.split("\n"), [
      "2 of 3 tests failed",
      "  breaks (core/Thing.test.js): expected 1 to equal 2",
      "  also breaks",
    ]);
  });
});
