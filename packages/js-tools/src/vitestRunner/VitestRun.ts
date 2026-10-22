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
 * What the vitest runner asks of vitest and what it makes of the answer — the
 * two conversions between fabr's runner contract and vitest's own interfaces,
 * kept apart from the process that performs them (runner.ts) so they can be
 * exercised without vitest installed.
 *
 * Vitest is typed structurally and locally: it comes from the TARGET's
 * dependencies, in whatever version the project chose, so there is no type
 * package of it to compile this against.
 */

import * as fs from "node:fs";
import { SourceMap, SourceMapPayload } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ITestResult, TestStatus } from "@fabr-build/core";
import { reportPathOf, snapshotPathOf } from "../testRunner/Report";
import { IRunnerOptions, TEST_TIMEOUT_MS } from "../testRunner/RunTests";

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
 * The options one invocation runs vitest with, for the test files of `options`
 * in the installation whose working directory is `root`, each worker loading
 * the runner's own `preloads` before the target's setup entries. Nothing is
 * read from a config file: what a suite needs is what the target declares.
 *
 * Modules load through node's own loader (`viteModuleRunner: false`), which is
 * what the compiled tests are built for, and recorded snapshots are checked
 * strictly unless they are being updated — vitest would otherwise record a
 * missing one and pass.
 */
export function vitestOptions(options: IRunnerOptions, root: string, preloads: string[], reporter: object): Record<string, unknown> {
  return {
    config: false,
    root,
    watch: false,
    include: options.files.map(file => path.relative(root, path.resolve(root, file)).split(path.sep).join("/")),
    environment: options.env,
    setupFiles: [...preloads, ...options.setup.map(entry => (entry.startsWith("./") ? path.resolve(root, entry) : entry))],
    update: options.update ? "all" : "none",
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
 * The results of one test file: each of its tests, or a single failure of the
 * file where it could not be loaded, or registered no tests at all — which is a
 * mistake to report, not a suite that passed.
 */
export function toTestResults(module: IReportedModule): ITestResult[] {
  const filePath = reportPathOf(module.moduleId);
  const fileFailure = (failure: { message: string; trace?: string }): ITestResult[] => [
    { name: filePath, filePath, status: "failed", duration: 0, ...failure },
  ];
  const tests = [...module.children.allTests()];
  const errors = module.errors();
  /* Vitest reports a file with no tests as an error of the file, worded around
   * a path inside the installation. */
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

/** A failure not attributable to any test file: an error vitest caught outside
 * every test (an unhandled rejection, a failure of the run itself). */
export function toRunFailure(error: IReportedError): ITestResult {
  return { name: "(outside any test)", status: "failed", duration: 0, ...describeErrors([error]) };
}

/**
 * A failure's one-line message — the first line of its first error — and the
 * rest as its trace: the remainder of each message, the matcher's difference,
 * and the stack, a test with several errors keeping them all.
 */
function describeErrors(errors: ReadonlyArray<IReportedError>): { message: string; trace?: string } {
  const [summary = "failed", ...detail] = errors
    .map(error => [withFabrRemedy(error.message ?? "failed"), error.diff, framesOf(error.stack)].filter(part => part !== undefined && part !== "").join("\n"))
    .join("\n\n")
    .split("\n");
  return { message: summary, trace: detail.join("\n").trim() || undefined };
}

/** Vitest's wording for a snapshot that does not match its record, or has none. */
const SNAPSHOT_MISMATCH = /^Snapshot `.*` mismatched$/;

/** A failed snapshot's message with the way to accept the new value, which
 * vitest's own flag is not: nobody running `fabr test` can pass it. */
function withFabrRemedy(message: string): string {
  return SNAPSHOT_MISMATCH.test(message) ? `${message}. Run 'fabr test -u' to record the new value.` : message;
}

/** One stack frame's location: `file:line:column`, bare or parenthesized. */
const FRAME_LOCATION = /^\s*(at (?:.*? )?)\(?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?$/;

/**
 * A stack's frames in the code under test — those inside a dependency, and
 * those with no file of their own, dropped — each naming the SOURCE position its compiled one came from,
 * where the compiled file has a source map.
 */
export function framesOf(stack: string | undefined): string | undefined {
  const frames = (stack ?? "")
    .split("\n")
    .filter(line => !line.includes("/node_modules/"))
    .flatMap(line => {
      const located = FRAME_LOCATION.exec(line);
      if (!located) {
        return [];
      }
      const [, prefix, file, lineNumber, column] = located;
      const compiled = file.startsWith("file://") ? fileURLToPath(file) : file;
      const position = sourcePositionOf(compiled, Number(lineNumber), Number(column));
      return [`${prefix}(${reportPathOf(compiled)}:${position.line}:${position.column})`];
    });
  return frames.length > 0 ? frames.join("\n") : undefined;
}

/** The source position (1-based) the given compiled one maps to, or the
 * compiled position itself where the file has no usable source map. */
function sourcePositionOf(compiled: string, line: number, column: number): { line: number; column: number } {
  try {
    const map = new SourceMap(JSON.parse(fs.readFileSync(`${compiled}.map`, "utf8")) as SourceMapPayload);
    const entry = map.findEntry(line - 1, column - 1) as { originalLine?: number; originalColumn?: number };
    if (entry.originalLine !== undefined && entry.originalColumn !== undefined) {
      return { line: entry.originalLine + 1, column: entry.originalColumn + 1 };
    }
  } catch {
    /* No map, or not one node can read. */
  }
  return { line, column };
}
