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
import * as path from "node:path";
import { reportPathOf } from "../testRunner/Report";
import { toTestResults } from "./runner";

const TEST_FILE = path.resolve("build", "Thing.test.js");

describe("toTestResults", () => {
  const passed = { fullName: "Thing works", status: "passed", duration: 3, failureMessages: [] };
  const failed = {
    fullName: "Thing breaks",
    status: "failed",
    duration: 1,
    failureMessages: ["expected 1 to equal 2\n  at Thing.test.ts:4:3"],
  };

  it("reports each test the file ran", () => {
    const results = toTestResults({ testFile: TEST_FILE, stderr: "", result: { testFile: TEST_FILE, results: [passed, failed] } });
    expect(results.map(r => [r.name, r.status, r.message])).to.deep.equal([
      ["Thing works", "passed", undefined],
      ["Thing breaks", "failed", "expected 1 to equal 2"],
    ]);
    expect(results[1].trace).to.equal("at Thing.test.ts:4:3");
    expect(results.every(r => r.filePath === reportPathOf(TEST_FILE))).to.equal(true);
  });

  it("keeps the tests that ran beside an error raised outside any test", () => {
    const results = toTestResults({
      testFile: TEST_FILE,
      stderr: "",
      result: {
        testFile: TEST_FILE,
        results: [passed, failed],
        execError: "Error: connection lost\n  at afterAll (Thing.test.ts:20:5)",
      },
    });
    expect(results.map(r => [r.name, r.status])).to.deep.equal([
      ["Thing works", "passed"],
      ["Thing breaks", "failed"],
      [reportPathOf(TEST_FILE), "failed"],
    ]);
    expect(results[2].message).to.equal("Error: connection lost");
    expect(results[2].trace).to.equal("at afterAll (Thing.test.ts:20:5)");
  });

  it("reports a file circus could not load as one failure carrying the cause", () => {
    const results = toTestResults({
      testFile: TEST_FILE,
      stderr: "",
      result: { testFile: TEST_FILE, results: [], execError: "Cannot find module 'missing'\n  at Thing.test.ts:1:1" },
    });
    expect(results).to.have.length(1);
    expect(results[0].message).to.equal("Cannot find module 'missing'");
    expect(results[0].trace).to.equal("at Thing.test.ts:1:1");
  });

  it("reports a file that never reported with its stderr as the trace", () => {
    const results = toTestResults({
      testFile: TEST_FILE,
      stderr: "Segmentation fault\n",
      crash: "the test process exited on SIGSEGV without reporting",
    });
    expect(results.map(r => [r.status, r.message, r.trace])).to.deep.equal([
      ["failed", "the test process exited on SIGSEGV without reporting", "Segmentation fault"],
    ]);
  });

  it("fails a file that registered no tests", () => {
    const results = toTestResults({ testFile: TEST_FILE, stderr: "", result: { testFile: TEST_FILE, results: [] } });
    expect(results.map(r => [r.status, r.message])).to.deep.equal([["failed", "This test file registered no tests"]]);
  });
});
