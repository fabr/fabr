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
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import {
  getTestArtifacts,
  selectTestFiles,
  formatFlakyTests,
  formatTestSummary,
  getTestReport,
  ITestReport,
  retriedReport,
  TEST_REPORT_FILENAME,
  toFlakeRetries,
  toTestReport,
  toTestStability,
} from "./TestResult";

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

  it("sums the reports of a name delivering several test targets", () => {
    const out: { value?: ITestReport } = {};
    getTestReport([reportSet(VALID), new FileSet(new Map()), reportSet(VALID)]).then(report => {
      out.value = report;
    });
    expect(out.value?.results.summary.passed).to.equal(2);
    expect(out.value?.results.tests).to.have.length(2);
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

/** A report of `tests`, each `[name, status]`, its summary counted from them. */
function reportOf(...tests: Array<[string, "passed" | "failed"]>): ITestReport {
  const passed = tests.filter(([, status]) => status === "passed").length;
  return {
    results: {
      tool: { name: "fabr" },
      summary: { tests: tests.length, passed, failed: tests.length - passed, pending: 0, skipped: 0, other: 0, start: 0, stop: 0 },
      tests: tests.map(([name, status]) => ({ name, status, duration: 0, filePath: "src/a.test.ts" })),
    },
  };
}

describe("retriedReport", () => {
  it("is the last run's report, unmarked, where there were no earlier runs", () => {
    const last = reportOf(["a", "passed"]);
    expect(retriedReport([], last)).to.equal(last);
  });

  it("marks a test that failed before and passed last as flaky, and every test with the retries made", () => {
    const report = retriedReport([reportOf(["a", "failed"], ["b", "passed"])], reportOf(["a", "passed"], ["b", "passed"]));
    expect(report.results.tests.map(test => [test.name, test.flaky, test.retries])).to.deep.equal([
      ["a", true, 1],
      ["b", undefined, 1],
    ]);
    expect(formatTestSummary(report)).to.equal("2 tests passed (1 flaky)");
    expect(formatFlakyTests(report)).to.deep.equal(["  a (src/a.test.ts): passed after 1 retry"]);
  });

  it("matches tests of one name by their position among them", () => {
    const report = retriedReport([reportOf(["a", "passed"], ["a", "failed"])], reportOf(["a", "passed"], ["a", "passed"]));
    expect(report.results.tests.map(test => test.flaky)).to.deep.equal([undefined, true]);
  });

  it("counts an earlier run that wrote no report as every test failing", () => {
    const report = retriedReport([undefined, reportOf(["a", "failed"])], reportOf(["a", "passed"]));
    expect(report.results.tests[0]).to.include({ flaky: true, retries: 2 });
  });

  it("leaves a test that failed last failed, not flaky", () => {
    const report = retriedReport([reportOf(["a", "failed"])], reportOf(["a", "failed"]));
    expect(report.results.tests[0].flaky).to.equal(undefined);
    expect(formatTestSummary(report)).to.equal("1 of 1 test failed");
  });
});

describe("toTestStability", () => {
  it("accepts the stabilities there are", () => {
    expect(["stable", "flaky", "unstable"].map(toTestStability)).to.deep.equal(["stable", "flaky", "unstable"]);
  });

  it("refuses any other value, naming those there are", () => {
    expect(() => toTestStability("shaky")).to.throw("'shaky' is not a test stability (stable, flaky, unstable)");
  });
});

describe("toFlakeRetries", () => {
  it("reads a count, and refuses anything else", () => {
    expect(toFlakeRetries("0")).to.equal(0);
    expect(toFlakeRetries("3")).to.equal(3);
    expect(() => toFlakeRetries("-1")).to.throw("TEST_FLAKE_RETRIES must be a number of retries, not '-1'");
  });
});

describe("selectTestFiles", () => {
  const tests = new FileSet(
    new Map<string, IFile>([
      ["dates/a.test.ts", MemoryFile.from("")],
      ["b.test.ts", MemoryFile.from("")],
    ])
  );

  it("keeps the files whose source path (here, with none, their name) the glob matches, and all of them for an empty pattern", () => {
    expect([...selectTestFiles(tests, "dates/**")].map(([name]) => name)).to.deep.equal(["dates/a.test.ts"]);
    expect([...selectTestFiles(tests, "**/b.test.ts")].map(([name]) => name)).to.deep.equal(["b.test.ts"]);
    expect(selectTestFiles(tests, "")).to.equal(tests);
  });
});

describe("getTestArtifacts", () => {
  it("takes the files under each result's artifacts directory, named within it, and nothing else", () => {
    const result = new FileSet(
      new Map<string, IFile>([
        ["ctrf-report.json", MemoryFile.from("{}")],
        ["artifacts/failed/trace.zip", MemoryFile.from("trace")],
        ["artifacts/shot.png", MemoryFile.from("png")],
      ])
    );
    expect([...getTestArtifacts([result])].map(([name]) => name)).to.deep.equal(["failed/trace.zip", "shot.png"]);
    expect(getTestArtifacts([]).isEmpty()).to.equal(true);
  });
});
