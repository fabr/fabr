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

/*
 * A test report as JUnit XML, the de facto format CI systems read test results
 * in (CircleCI's store_test_results, GitLab, Jenkins): one <testsuite> per test
 * file, each test a <testcase> whose classname and file are the file's path.
 */

import XMLBuilder from "fast-xml-builder";

import { compareText } from "./Functional";
import type { ITestReport, ITestResult } from "./TestResult";

/** The name of the suite holding the tests a report names no file for. */
const UNFILED_SUITE = "(no file)";

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
});

/** @return `text` with what XML 1.0 cannot hold removed: a terminal's colour codes, and the other control characters. */
function xmlText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "");
}

/** @return a duration in milliseconds as JUnit's seconds. */
function seconds(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1000).toFixed(3);
}

function testcase(test: ITestResult, suite: string): Record<string, unknown> {
  const attributes = {
    "@_name": xmlText(test.name),
    "@_classname": xmlText(suite),
    ...(test.filePath === undefined ? {} : { "@_file": xmlText(test.filePath) }),
    "@_time": seconds(test.duration),
  };
  switch (test.status) {
    case "passed":
      return attributes;
    case "failed": {
      const body = [test.message, test.trace].filter((part): part is string => part !== undefined).join("\n");
      const message = test.message === undefined ? {} : { "@_message": xmlText(test.message) };
      return { ...attributes, failure: { ...message, "#text": xmlText(body) } };
    }
    default:
      return { ...attributes, skipped: "" };
  }
}

/** @return `report` as a JUnit XML document. */
export function toJUnitXml(report: ITestReport): string {
  const bySuite = new Map<string, ITestResult[]>();
  for (const test of report.results.tests) {
    const suite = test.filePath ?? UNFILED_SUITE;
    bySuite.set(suite, [...(bySuite.get(suite) ?? []), test]);
  }
  const { summary } = report.results;
  const testsuite = [...bySuite]
    .sort(([a], [b]) => compareText(a, b))
    .map(([suite, tests]) => ({
      "@_name": xmlText(suite),
      ...(suite === UNFILED_SUITE ? {} : { "@_file": xmlText(suite) }),
      "@_tests": tests.length,
      "@_failures": tests.filter(test => test.status === "failed").length,
      "@_errors": 0,
      "@_skipped": tests.filter(test => test.status !== "passed" && test.status !== "failed").length,
      "@_time": seconds(tests.reduce((total, test) => total + Math.max(0, test.duration), 0)),
      testcase: tests.map(test => testcase(test, suite)),
    }));
  const testsuites = {
    "@_name": xmlText(report.results.tool.name),
    "@_tests": summary.tests,
    "@_failures": summary.failed,
    "@_errors": 0,
    "@_skipped": summary.skipped + summary.pending + summary.other,
    "@_time": seconds(summary.stop - summary.start),
    testsuite,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ testsuites })}`;
}
