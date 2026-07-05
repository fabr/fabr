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
import type { ITestReport, ITestResult } from "@fabr/core";
import { countResults, formatTestFailures, formatTestSummary } from "./Report";

function report(tests: ITestResult[]): ITestReport {
  return { version: 1, counts: countResults(tests), tests };
}

describe("countResults", () => {
  it("counts by status", () => {
    const counts = countResults([
      { name: "a", status: "pass" },
      { name: "b", status: "fail" },
      { name: "c", status: "pass" },
      { name: "d", status: "skip" },
      { name: "e", status: "todo" },
    ]);
    assert.deepEqual(counts, { pass: 2, fail: 1, skip: 1, todo: 1, total: 5 });
  });

  it("counts an empty run", () => {
    assert.deepEqual(countResults([]), { pass: 0, fail: 0, skip: 0, todo: 0, total: 0 });
  });
});

describe("formatTestSummary", () => {
  it("reports an all-green run", () => {
    assert.equal(
      formatTestSummary(
        report([
          { name: "a", status: "pass" },
          { name: "b", status: "pass" },
        ])
      ),
      "2 tests passed"
    );
  });

  it("mentions skipped tests", () => {
    assert.equal(
      formatTestSummary(
        report([
          { name: "a", status: "pass" },
          { name: "b", status: "skip" },
        ])
      ),
      "1 test passed (1 skipped)"
    );
  });

  it("reports failures", () => {
    assert.equal(
      formatTestSummary(
        report([
          { name: "a", status: "fail" },
          { name: "b", status: "pass" },
        ])
      ),
      "1 of 2 tests failed"
    );
  });
});

describe("formatTestFailures", () => {
  it("lists each failed test with its location and first error line", () => {
    const text = formatTestFailures(
      report([
        { name: "works", status: "pass" },
        { name: "breaks", status: "fail", file: "core/Thing.test.js", error: "expected 1 to equal 2\nlong stack" },
        { name: "also breaks", status: "fail" },
      ])
    );
    assert.deepEqual(text.split("\n"), [
      "2 of 3 tests failed",
      "  breaks (core/Thing.test.js): expected 1 to equal 2",
      "  also breaks",
    ]);
  });
});
