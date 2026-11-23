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
 * Cypress's results as fabr's test report: the conversions the Cypress runner
 * makes, apart from running Cypress.
 */

import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ITestResult } from "@fabr-build/core";
import { framesOf, reportPathOf } from "../testRunner/Report";
import { FocusHandling, focusForbidden } from "../testRunner/RunTests";

/** The part of a test's result Cypress's `run` reports that is read. */
export interface ICypressTest {
  title: string[];
  state: string;
  displayError?: string | null;
  duration?: number | null;
  attempts?: ReadonlyArray<{ state: string }>;
}

/** The part of a spec's run Cypress's `run` reports that is read. */
export interface ICypressRun {
  spec: { absolute: string };
  tests?: ReadonlyArray<ICypressTest> | null;
  error?: string | null;
}

/** What Cypress's `run` resolves with: a finished run's specs, or why it could not run. */
export type ICypressResult = { runs: ReadonlyArray<ICypressRun> } | { status: "failed"; message?: string };

/**
 * Convert a run to test results: each test named by its suites' titles and
 * its own, joined by ` › `, for its spec's source. A run that could not start
 * fails every file of `files`; a spec that could not run fails its own file,
 * beside the tests it reported.
 */
export function toTestResults(result: ICypressResult, files: ReadonlyArray<string>): ITestResult[] {
  if (!("runs" in result)) {
    return files.map(file => runFailure(file, result.message ?? "Cypress could not run"));
  }
  return result.runs.flatMap(run => {
    const filePath = reportPathOf(run.spec.absolute);
    const tests = (run.tests ?? []).map(test => toTestResult(test, filePath));
    return run.error !== undefined && run.error !== null ? [...tests, runFailure(run.spec.absolute, run.error)] : tests;
  });
}

/** Convert one test: passed (flaky where an earlier attempt failed), failed with its error, or pending or skipped. */
function toTestResult(test: ICypressTest, filePath: string): ITestResult {
  const name = test.title.join(" › ");
  const duration = test.duration ?? 0;
  const attempts = test.attempts ?? [];
  switch (test.state) {
    case "passed":
      return attempts.length > 1
        ? { name, filePath, status: "passed", duration, flaky: true, retries: attempts.length - 1 }
        : { name, filePath, status: "passed", duration };
    case "failed":
      return { name, filePath, status: "failed", duration, ...describeError(test.displayError ?? "failed") };
    case "pending":
      return { name, filePath, status: "pending", duration };
    default:
      return { name, filePath, status: "skipped", duration };
  }
}

/** Report an error outside every test of `file` (a spec that could not be bundled, a run that could not start) as its failure. */
function runFailure(file: string, error: string): ITestResult {
  const filePath = reportPathOf(file);
  return { name: filePath, filePath, status: "failed", duration: 0, ...describeError(error) };
}

/** Split Cypress's rendered error into its first line, without colour codes, and the rest as its trace: the further lines and the frames in the code under test. */
export function describeError(error: string): { message: string; trace?: string } {
  const text = stripVTControlCharacters(error);
  const at = text.search(/\n\s+at /);
  const [message = "failed", ...rest] = (at === -1 ? text : text.substring(0, at)).split("\n");
  const frames = at === -1 ? undefined : framesOf(text.substring(at + 1));
  const trace = [rest.join("\n").trim(), frames ?? ""].filter(part => part !== "").join("\n");
  return { message, ...(trace === "" ? {} : { trace }) };
}

/**
 * Make the source of the support file fabr runs a suite with: each of
 * `supports` loaded in turn (the suite's own support file, then its setup
 * files), then, where `pattern` (a regular expression) is given, a filter
 * registering only the tests whose full name, their suites' titles and their
 * own joined by spaces, it matches. The filter wraps the test globals as each
 * spec file defines its tests, so a test not matched is never registered.
 */
export function supportSource(supports: ReadonlyArray<string>, pattern: string | undefined, only: FocusHandling = "allow"): string {
  return [
    "/* Written by fabr. */",
    ...supports.map(support => `require(${JSON.stringify(support)});`),
    ...(pattern === undefined ? [] : nameFilter(pattern)),
    ...focusHandling(only),
    "",
  ].join("\n");
}

/** Make the lines of a support file rebinding the focused forms of Mocha's test functions (`it.only`, `describe.only`) as `only` says: to the plain function under `ignore`, to one failing the spec under `forbid`. */
function focusHandling(only: FocusHandling): string[] {
  if (only === "allow") {
    return [];
  }
  const [before, after] = focusForbidden("\u0000").split("\u0000");
  return [
    "for (const name of ['describe', 'context', 'it', 'specify']) {",
    "  const define = globalThis[name];",
    only === "ignore"
      ? "  define.only = define;"
      : `  define.only = () => { throw new Error(${JSON.stringify(before)} + Cypress.spec.relative + ${JSON.stringify(after)}); };`,
    "}",
  ];
}

/** Make the lines of a support file registering only the tests whose full name `pattern` matches (see {@link supportSource}). */
function nameFilter(pattern: string): string[] {
  return [
    `const pattern = new RegExp(${JSON.stringify(pattern)});`,
    "const suites = [];",
    "const suite = define => function (title, ...rest) {",
    "  const at = rest.length - 1;",
    "  if (typeof rest[at] === 'function') {",
    "    const body = rest[at];",
    "    rest[at] = function () { suites.push(title); try { return body.apply(this, arguments); } finally { suites.pop(); } };",
    "  }",
    "  return define.call(this, title, ...rest);",
    "};",
    "const test = define => function (title, ...rest) {",
    "  return pattern.test([...suites, title].join(' ')) ? define.call(this, title, ...rest) : undefined;",
    "};",
    "for (const name of ['describe', 'context']) {",
    "  const define = globalThis[name];",
    "  globalThis[name] = Object.assign(suite(define), define, { only: suite(define.only), skip: define.skip });",
    "}",
    "for (const name of ['it', 'specify']) {",
    "  const define = globalThis[name];",
    "  globalThis[name] = Object.assign(test(define), define, { only: test(define.only), skip: define.skip });",
    "}",
  ];
}

/**
 * @return where the suite's own support file is in the compiled tree at
 * `root`, given what its config names (`e2e.supportFile`): that file, or its
 * compiled one where it names a TypeScript source; Cypress's default location
 * (`cypress/support/e2e.*`) where it names none and one is there; undefined
 * where it is `false` or none is found.
 */
export function supportFileOf(root: string, named: unknown, exists: (file: string) => boolean): string | undefined {
  if (named === false) {
    return undefined;
  }
  const candidates =
    typeof named === "string"
      ? [named.replace(/\.[cm]?tsx?$/, ".js"), named]
      : ["js", "jsx", "ts", "tsx"].map(extension => `cypress/support/e2e.${extension}`);
  return candidates.map(candidate => path.resolve(root, candidate)).find(exists);
}
