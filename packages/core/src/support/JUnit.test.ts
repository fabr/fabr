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

import { toJUnitXml } from "./JUnit";
import { ITestReport, ITestResult } from "./TestResult";

function reportOf(tests: ITestResult[]): ITestReport {
  const count = (status: string): number => tests.filter(test => test.status === status).length;
  return {
    results: {
      tool: { name: "fabr" },
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        pending: count("pending"),
        skipped: count("skipped"),
        other: count("other"),
        start: 1000,
        stop: 3500,
      },
      tests,
    },
  };
}

describe("toJUnitXml", () => {
  const xml = toJUnitXml(
    reportOf([
      { name: "b holds", status: "passed", duration: 12, filePath: "src/b.test.ts" },
      {
        name: "a fails",
        status: "failed",
        duration: 1500,
        filePath: "src/a.test.ts",
        message: "expected 1 to equal 2",
        trace: "at a.test.ts:3",
      },
      { name: "a waits", status: "skipped", duration: 0, filePath: "src/a.test.ts" },
    ])
  );

  it("states the totals of the whole run", () => {
    expect(xml).to.contain('<testsuites name="fabr" tests="3" failures="1" errors="0" skipped="1" time="2.500">');
  });

  it("makes one suite per test file, in order, each naming its file", () => {
    const suites = [...xml.matchAll(/<testsuite name="([^"]*)" file="([^"]*)" tests="(\d+)" failures="(\d+)"/g)].map(match =>
      match.slice(1)
    );
    expect(suites).to.deep.equal([
      ["src/a.test.ts", "src/a.test.ts", "2", "1"],
      ["src/b.test.ts", "src/b.test.ts", "1", "0"],
    ]);
  });

  it("carries a failure's message and trace, and marks a test that did not run as skipped", () => {
    expect(xml).to.contain(
      '<testcase name="a fails" classname="src/a.test.ts" file="src/a.test.ts" time="1.500">\n      <failure message="expected 1 to equal 2">expected 1 to equal 2\nat a.test.ts:3</failure>'
    );
    expect(xml).to.contain('<testcase name="a waits" classname="src/a.test.ts" file="src/a.test.ts" time="0.000">\n      <skipped/>');
    expect(xml).to.contain('<testcase name="b holds" classname="src/b.test.ts" file="src/b.test.ts" time="0.012"/>');
  });

  it("escapes markup and drops what XML cannot hold", () => {
    const escaped = toJUnitXml(
      reportOf([{ name: 'a <b> & "c"', status: "failed", duration: 0, message: "\u001b[31mred\u001b[39m\u0000" }])
    );
    expect(escaped).to.contain('<testcase name="a &lt;b&gt; &amp; &quot;c&quot;" classname="(no file)" time="0.000">');
    expect(escaped).to.contain('<failure message="red">red</failure>');
  });
});
