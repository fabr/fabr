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
import { FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { getTestReport, ITestReport, TEST_REPORT_FILENAME, toTestReport } from "./TestResult";

/** A single-file FileSet holding a report artifact with the given raw content. */
function reportSet(content: string): FileSet {
  return new FileSet(new Map([[TEST_REPORT_FILENAME, MemoryFile.from(content)]]));
}

const VALID = JSON.stringify({
  results: {
    tool: { name: "fabr" },
    summary: { tests: 1, passed: 1, failed: 0, pending: 0, skipped: 0, other: 0, start: 0, stop: 0 },
    tests: [{ name: "a", status: "passed", duration: 0 }],
  },
});

/** Resolve getTestReport synchronously (in-memory sources settle immediately). */
function resolve(set: FileSet): { value?: ITestReport; error?: string } {
  const out: { value?: ITestReport; error?: string } = {};
  getTestReport([set]).then(
    report => {
      out.value = report;
    },
    err => {
      out.error = err.message;
    }
  );
  return out;
}

describe("getTestReport", () => {
  it("parses a present, well-formed CTRF report", () => {
    const { value, error } = resolve(reportSet(VALID));
    expect(error).to.equal(undefined);
    expect(value?.results.summary.passed).to.equal(1);
  });

  it("treats a genuinely absent report artifact as 'no tests' (undefined)", () => {
    const out: { value?: ITestReport; settled?: boolean } = {};
    /* A FileSet with no report file at all. */
    getTestReport([new FileSet(new Map())]).then(report => {
      out.value = report;
      out.settled = true;
    });
    expect(out.settled).to.equal(true);
    expect(out.value).to.equal(undefined);
  });

  it("rejects a present but malformed (unparseable) report rather than swallowing it", () => {
    const { value, error } = resolve(reportSet("{ this is not json"));
    expect(value).to.equal(undefined);
    expect(error).to.match(/Invalid JSON in/);
  });

  it("rejects a present report whose JSON isn't a recognizable CTRF document", () => {
    const { value, error } = resolve(reportSet(JSON.stringify({ some: "other json" })));
    expect(value).to.equal(undefined);
    expect(error).to.match(/not a recognizable CTRF report/);
  });
});

describe("toTestReport", () => {
  /** The parsed report, with one part of the results block replaced. */
  function withResults(overrides: Record<string, unknown>): unknown {
    const results = (JSON.parse(VALID) as ITestReport).results;
    return { results: { ...results, ...overrides } };
  }

  it("reads a well-formed report", () => {
    expect(toTestReport(JSON.parse(VALID)).results.summary.passed).to.equal(1);
  });

  /* The runner is swappable, so the document is third-party: every consumer
   * downstream reads these fields without re-checking them. */
  it("rejects a document that is not an object", () => {
    expect(() => toTestReport(null)).to.throw(/not a recognizable CTRF report/);
    expect(() => toTestReport([])).to.throw(/not a recognizable CTRF report/);
  });

  it("rejects summary counters that are not numbers", () => {
    expect(() => toTestReport(withResults({ summary: { tests: "1", passed: "1", failed: "0" } }))).to.throw(
      /not a recognizable CTRF report/
    );
  });

  it("rejects a tests list that isn't a list of test objects", () => {
    expect(() => toTestReport(withResults({ tests: {} }))).to.throw(/not a recognizable CTRF report/);
    expect(() => toTestReport(withResults({ tests: [null] }))).to.throw(/not a recognizable CTRF report/);
  });
});
