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
 */

/**
 * The runner core, shared by every flavour of fabr's test runner: parse the
 * invocation fabr makes, drive node:test over the test files with a given set
 * of preloads, and write the CTRF report.
 *
 * A "flavour" is this core plus a preload — the module that furnishes each test
 * process with whatever the test files expect to find already there. The native
 * runner's preload installs describe/it; the jest-compatibility flavour's
 * installs a whole jest environment. Nothing below knows which.
 */

import { run } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ITestResult } from "@fabr-build/core";
import { buildReport, formatTestFailures, formatTestSummary, reportPathOf, TEST_REPORT_FILENAME } from "./Report";

/**
 * The fields we consume from node:test's test:pass / test:fail event data,
 * declared structurally so that the harness tolerates the (typed) shape
 * differences between node versions.
 */
interface ITestEvent {
  name: string;
  file?: string;
  skip?: boolean | string;
  todo?: boolean | string;
  details: {
    duration_ms?: number;
    /** 'suite' for describe-block completions, which aggregate their children */
    type?: string;
    error?: Error & { cause?: unknown };
  };
}

/**
 * The runner invocation fabr constructs (see TestPipeline): where to write the
 * report, which environment the tests were compiled for, whether recorded
 * expectations are to be rewritten rather than checked, and the test files.
 */
export interface IRunnerOptions {
  report: string;
  env: string;
  update: boolean;
  /** What every test process loads before any test file, in the order given: a
   * bare module name, or a `./`-prefixed path within the installation. The
   * prefix is the whole distinction — see the `setup` property in JS.fabr. */
  setup: string[];
  files: string[];
}

export function parseRunnerArgs(argv: string[]): IRunnerOptions {
  const options: IRunnerOptions = { report: TEST_REPORT_FILENAME, env: "node", update: false, setup: [], files: [] };
  for (const arg of argv) {
    if (arg.startsWith("--report=")) {
      options.report = arg.substring("--report=".length);
    } else if (arg.startsWith("--env=")) {
      options.env = arg.substring("--env=".length);
    } else if (arg === "--update-snapshots") {
      options.update = true;
    } else if (arg.startsWith("--setup=")) {
      options.setup.push(arg.substring("--setup=".length));
    } else if (arg.startsWith("-")) {
      /* The contract is fabr's, and fabr passes exactly what is documented: an
       * unknown option means the two sides disagree, which must not degrade
       * into treating a flag as a test file path. */
      throw new Error(`Unknown test runner option '${arg}'`);
    } else {
      options.files.push(arg);
    }
  }
  return options;
}

/**
 * Output a test file wrote to stderr, accumulated per file. Kept because a
 * whole-FILE failure carries no error detail of its own (see describeError):
 * node:test streams the real cause here instead, and without this the report
 * would record such a failure as, literally, "test failed".
 */
class CapturedStderr {
  private readonly byFile = new Map<string, string>();

  public add(file: string | undefined, message: string | undefined): void {
    if (file !== undefined && message !== undefined) {
      this.byFile.set(file, (this.byFile.get(file) ?? "") + message);
    }
  }

  /** The tail of what `file` wrote — the tail because a crash is the last thing
   * to happen, and a chatty test file should not push its own cause out of the
   * report. Empty output reads as "nothing to add". */
  public tail(file: string | undefined): string | undefined {
    const captured = file === undefined ? undefined : this.byFile.get(file)?.trim();
    if (!captured) {
      return undefined;
    }
    const lines = captured.split("\n");
    return lines.length > STDERR_TAIL_LINES ? lines.slice(-STDERR_TAIL_LINES).join("\n") : captured;
  }
}

/** How much of a failed file's stderr the report carries. Generous — this is a
 * crash dump, and truncating the interesting end of one is how a diagnostic
 * becomes useless. */
const STDERR_TAIL_LINES = 40;

function record(results: ITestResult[], event: ITestEvent, kind: "pass" | "fail", stderr: CapturedStderr): void {
  if (event.details.type === "suite") {
    /* Suite completions aggregate their children; only individual tests (and
     * whole-file crashes, which arrive as failed tests) are recorded */
    return;
  }
  let status: ITestResult["status"] = kind === "fail" ? "failed" : "passed";
  if (kind === "pass" && event.skip) {
    status = "skipped";
  } else if (kind === "pass" && event.todo) {
    status = "pending";
  }
  const filePath = event.file ? reportPathOf(event.file) : undefined;
  results.push({
    /* node:test names a whole-file failure by the file's ABSOLUTE path, which
     * here is inside a transient work directory — meaningless to the reader and
     * different on every run. The relative path is what the failure is about. */
    name: isFileFailure(event) && filePath !== undefined ? filePath : event.name,
    filePath,
    status,
    duration: event.details.duration_ms ?? 0,
    message: kind === "fail" ? describeError(event.details.error) : undefined,
    trace: kind === "fail" ? fileFailureDetail(event, stderr) : undefined,
  });
}

/**
 * The captured stderr to attach to a failure as its trace, or undefined for none.
 *
 * Only a whole-FILE failure gets it. node:test names such a failure after the
 * file itself (there is no test to name — none registered), which is what tells
 * the two apart; a failure of a *test* is left alone, since the file's stderr
 * belongs to all of its tests and attaching it to one would misattribute
 * whatever the others logged.
 */
function fileFailureDetail(event: ITestEvent, stderr: CapturedStderr): string | undefined {
  return isFileFailure(event) ? stderr.tail(event.file) : undefined;
}

/** Whether this event is the FILE failing rather than a test in it: node:test
 * names such a failure after the file, there being no test to name. */
function isFileFailure(event: ITestEvent): boolean {
  return event.file !== undefined && event.name === event.file;
}

/**
 * What a failure should say.
 *
 * A failed TEST arrives wrapped in an ERR_TEST_FAILURE whose `cause` is the
 * assertion error — the interesting part, unwrapped here.
 *
 * A failed FILE — one that threw while loading, so none of its tests ever
 * registered — has no diagnosis to offer here at all: its `cause` is the bare
 * STRING `"test failed"` (node's failure *category*, not a reason). What it
 * actually died of went to the child's stderr; see fileFailureDetail, which
 * supplies it as the result's `trace`.
 */
function describeError(error: (Error & { cause?: unknown }) | undefined): string {
  if (!error) {
    return "failed";
  }
  const cause = error.cause;
  /* An Error cause is the assertion failure itself, and says everything. */
  if (cause instanceof Error) {
    return cause.message;
  }
  return cause !== undefined ? String(cause) : error.message;
}

function finish(results: ITestResult[], reportPath: string, start: number): void {
  const report = buildReport(results, start, Date.now());
  fs.writeFileSync(reportPath, JSON.stringify(report, undefined, 2));
  const failed = report.results.summary.failed;
  console.log(failed > 0 ? formatTestFailures(report) : formatTestSummary(report));
  process.exitCode = failed > 0 ? 1 : 0;
}

/** Per-test timeout: a safety net so a hung test (a runaway loop, a subprocess
 * blocked on stdin that never closes) fails as a timeout rather than hanging the
 * whole run forever — node:test defaults to no timeout, unlike jest's 5s. Baked
 * in (tests run with a clean env, so an env knob could not reach here) and set
 * generously — well above the slowest legit test (the watch/serve suites cap
 * themselves at 90s) — so it only ever catches a genuine hang. Shared across
 * flavours: node:test takes it for the run here, and the jest flavour hands it
 * to circus, which enforces it per test and honours a test's own override. */
export const TEST_TIMEOUT_MS = 120_000;

/* The timeout's complement: the timeout fails a hung TEST, but cannot make a
 * test-file PROCESS exit — JS can't preempt, so a test that leaked live handles
 * (child pipes, watchers, timers) keeps the file's event loop alive after its
 * tests finish, the run's stream never ends, and the whole build hangs waiting.
 * forceExit exits each file's process once its tests complete regardless of
 * stray handles; anything the tests *spawned* and left behind is then reaped by
 * the host's process-group sweep at the action boundary (see core's Execute).
 * Not available before node 20.14/22.0 — older hosts keep the old behavior
 * rather than choke on an unknown option. */
function forceExitOption(): { forceExit?: boolean } {
  return atLeastNode(20, 14) ? { forceExit: true } : {};
}

/** Whether the running node is at least the given version. */
export function atLeastNode(major: number, minor: number): boolean {
  const [runningMajor, runningMinor] = process.versions.node.split(".").map(Number);
  return runningMajor > major || (runningMajor === major && runningMinor >= minor);
}

/**
 * Deliver the preloads to each test child. `run({ execArgv })` reaches ONLY the
 * runner's own test processes, which is what we want: NODE_OPTIONS is inherited
 * by every node process descended from a test, so a preload that installs a
 * whole environment (module patches, DOM globals) would contaminate arbitrary
 * helper processes the tests spawn. `execArgv` needs node 22.10; older hosts
 * keep the inherited-environment route rather than silently running with no
 * preload at all.
 */
function preloadOptions(preloads: string[]): { execArgv?: string[] } {
  const args = preloads.flatMap(preload => ["--require", preload]);
  if (atLeastNode(22, 10)) {
    return { execArgv: args };
  }
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, ...args.map(arg => JSON.stringify(arg))].filter(Boolean).join(" ");
  return {};
}

/** A setup entry as a preload path. A local entry is relative to the
 * installation (the runner's own cwd); a bare module name is left to node's
 * resolution, which finds it in the installation's node_modules. */
function resolveSetup(entry: string): string {
  return entry.startsWith("./") ? path.resolve(entry) : entry;
}

/**
 * Run the given test files under node:test — each in its own child process,
 * with `preloads` (absolute paths) required into every one — collecting the
 * results and writing the report. Sets `process.exitCode`: 0 if everything
 * passed, 1 if any test failed.
 */
export function runTestFiles(options: IRunnerOptions, preloads: string[]): void {
  const results: ITestResult[] = [];
  const stderr = new CapturedStderr();
  const start = Date.now();
  const stream = run({
    files: options.files.map(file => path.resolve(file)),
    timeout: TEST_TIMEOUT_MS,
    /* Setup entries preload AFTER the flavour's own: the globals they use
     * (describe/it, and whatever else a flavour installs) must already be
     * there. That is jest's `setupFilesAfterEnv` ordering, and here it is the
     * only one available — there is nothing to run before the globals. */
    ...preloadOptions([...preloads, ...options.setup.map(entry => resolveSetup(entry))]),
    ...forceExitOption(),
  });
  /* Before the outcome handlers, so a file's output is already captured by the
   * time its failure is recorded. */
  stream.on("test:stderr", data => {
    const output = data as unknown as { file?: string; message?: string };
    stderr.add(output.file, output.message);
  });
  stream.on("test:pass", data => record(results, data as unknown as ITestEvent, "pass", stderr));
  stream.on("test:fail", data => record(results, data as unknown as ITestEvent, "fail", stderr));
  stream.once("end", () => finish(results, options.report, start));
  /* The event stream only flows (and thus only ends) if it is consumed */
  stream.resume();
}
