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
 * The vitest runner's two conversions: from fabr's runner contract to the
 * options vitest runs with, and from what vitest reports to fabr's test
 * results. They are apart from runner.ts so they can be tested without vitest.
 *
 * Vitest's interfaces are typed here, structurally: vitest comes from the
 * target's dependencies, at the version the project chose.
 */

import * as path from "node:path";
import type { ITestResult, TestStatus } from "@fabr-build/core";
import { framesOf, reportPathOf, snapshotPathOf } from "../testRunner/Report";
import { IRunnerOptions, TEST_TIMEOUT_MS } from "../testRunner/RunTests";
import { posixRelative } from "../support/Paths";

/** An error as vitest reports one. */
export interface IReportedError {
  message?: string;
  stack?: string;
  /** The matcher's rendered difference, where the failure was an assertion. */
  diff?: string;
}

/** One test, as vitest's reporter interface presents it. */
export interface IReportedTest {
  fullName: string;
  options: { mode?: string };
  result(): { state: string; errors?: ReadonlyArray<IReportedError> };
  diagnostic(): { duration: number } | undefined;
}

/** One test file, as vitest's reporter interface presents it. */
export interface IReportedModule {
  moduleId: string;
  errors(): ReadonlyArray<IReportedError>;
  children: { allTests(): Iterable<IReportedTest> };
}

/**
 * Make the options one invocation runs vitest with, for the test files of
 * `options` in the installation whose working directory is `root`, reporting
 * to `reporter`. Each worker loads `preloads` and the target's setup entries
 * as `setupFiles`, after what the runner put on `NODE_OPTIONS`. No config file
 * is read.
 *
 * Tests load through node's own loader (`viteModuleRunner: false`). Snapshots
 * are written only where `options.update` is set; otherwise a missing one
 * fails.
 */
export function vitestOptions(options: IRunnerOptions, root: string, preloads: string[], reporter: object): Record<string, unknown> {
  return {
    config: false,
    root,
    watch: false,
    include: options.files.map(file => posixRelative(root, path.resolve(root, file))),
    environment: options.env,
    setupFiles: [...preloads, ...options.setup.map(entry => (entry.startsWith("./") ? path.resolve(root, entry) : entry))],
    update: options.update ? "all" : "none",
    ...(options.namePattern === undefined ? {} : { testNamePattern: options.namePattern }),
    resolveSnapshotPath: (testPath: string) => snapshotPathOf(testPath),
    testTimeout: TEST_TIMEOUT_MS,
    reporters: [reporter],
    pool: "forks",
    cache: false,
    experimental: { viteModuleRunner: false },
  };
}

/** How vitest's error for a test file that registered nothing begins. */
const NO_TESTS = "No test suite found in file";

const STATUS: Record<string, TestStatus> = { passed: "passed", failed: "failed", skipped: "skipped" };

/**
 * Convert one test file's results: one per test, or a single failure of the
 * file where vitest reports an error of the file (it could not be loaded) or
 * the file registered no tests. A `todo` test is `pending`, and a state fabr
 * has no name for is `other`.
 */
export function toTestResults(module: IReportedModule): ITestResult[] {
  const filePath = reportPathOf(module.moduleId);
  const fileFailure = (failure: { message: string; trace?: string }): ITestResult[] => [
    { name: filePath, filePath, status: "failed", duration: 0, ...failure },
  ];
  const tests = [...module.children.allTests()];
  const errors = module.errors();
  /* Vitest reports a file with no tests as an error of the file, naming a path
   * inside the installation; report it in fabr's words. */
  if (tests.length === 0 && errors.every(error => error.message?.startsWith(NO_TESTS) ?? false)) {
    return fileFailure({ message: "This test file registered no tests" });
  }
  if (errors.length > 0) {
    return fileFailure(describeErrors(errors));
  }
  return tests.map((test): ITestResult => {
    const result = test.result();
    const status = result.state === "skipped" && test.options.mode === "todo" ? "pending" : (STATUS[result.state] ?? "other");
    return {
      name: test.fullName,
      filePath,
      status,
      duration: test.diagnostic()?.duration ?? 0,
      ...(status === "failed" ? describeErrors(result.errors ?? []) : {}),
    };
  });
}

/** Report a failure not attributable to any test file: an error vitest caught
 * outside every test (an unhandled rejection, a failure of the run itself). */
export function toRunFailure(error: IReportedError): ITestResult {
  return { name: "(outside any test)", status: "failed", duration: 0, ...describeErrors([error]) };
}

/**
 * Split a failure into its one-line message — the first line of its first
 * error — and the rest as its trace: the remainder of each message, the
 * matcher's difference, and the stack, a test with several errors keeping them
 * all.
 */
function describeErrors(errors: ReadonlyArray<IReportedError>): { message: string; trace?: string } {
  const [summary = "failed", ...detail] = errors
    .map(error =>
      [withFabrRemedy(error.message ?? "failed"), error.diff, framesOf(error.stack)]
        .filter(part => part !== undefined && part !== "")
        .join("\n")
    )
    .join("\n\n")
    .split("\n");
  return { message: summary, trace: detail.join("\n").trim() || undefined };
}

/** Vitest's wording for a snapshot that does not match its record, or has none. */
const SNAPSHOT_MISMATCH = /^Snapshot `.*` mismatched$/;

/** Add to a failed snapshot's message how to record the new value with fabr
 * (`fabr test -u`). */
function withFabrRemedy(message: string): string {
  return SNAPSHOT_MISMATCH.test(message) ? `${message}. Run 'fabr test -u' to record the new value.` : message;
}
