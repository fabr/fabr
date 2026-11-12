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
 * The jest framework's test runner: test files run by jest-circus, over node's
 * own module loader with fabr's mock registry, load-time hoist and `jest`
 * object (see child.ts).
 *
 * Given one test file, as fabr invokes it, the runner runs it in this process
 * (see {@link runHere}); given several, it forks a child per file, at most
 * `availableParallelism()` at a time. The results are written as one CTRF
 * report, in the order the files were given.
 *
 * Usage (the runner contract, same as every flavour):
 *   node runner.js --report=<path> --env=<node|jsdom> [--update-snapshots]
 *                  [--name-pattern=<regex>] [--setup=<module|./staged path>]... <test-file>...
 */

import { availableParallelism } from "node:os";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ITestResult, TestStatus } from "@fabr-build/core";
import { buildReport, endAfterReport, reportPathOf } from "../testRunner/Report";
import { recordReads, withPnpTable, writeReads } from "../testRunner/Reads";
import { installPnpRuntime } from "../pnp/Runtime";
import { childPreloads, parseRunnerArgs, TEST_TIMEOUT_MS } from "../testRunner/RunTests";
import { assertSupportedHost, requireEnvironment } from "./Tools";
import { describeThrown, runTestFile } from "./child";
import type { IChildRequest, IChildResult, IChildTestResult } from "./child";

/**
 * How long a test file may run before it is reported as crashed. Each test is
 * bounded by {@link TEST_TIMEOUT_MS} (circus fails the test); this bounds the
 * whole file, so must exceed a long file's total (fabr's own heaviest e2e file
 * runs several minutes).
 */
const CHILD_GRACE_MS = 600_000;

export function main(argv: string[]): void {
  const options = parseRunnerArgs(argv);
  /* Check the host once, before any child. */
  assertSupportedHost();
  /* Before anything resolves from the test install (jsdom among it). */
  if (options.pnp !== undefined) {
    installPnpRuntime(options.pnp);
  }
  requireEnvironment(options.env);
  /* So a stack frame names the source line, through the compiler's and the
   * hoist's maps, for a file run in this process; a child gets
   * `--enable-source-maps`. */
  process.setSourceMapsEnabled(true);

  const start = Date.now();
  const child = path.join(__dirname, "child.js");
  const root = process.cwd();
  const request = (testFile: string): IChildRequest => ({
    testFile: path.resolve(testFile),
    root,
    env: options.env,
    updateSnapshots: options.update,
    namePattern: options.namePattern,
    timeoutMs: TEST_TIMEOUT_MS,
    setup: options.setup,
  });

  const requests = options.files.map(request);
  /* A single file runs here, so what it reads is this process's own; several
   * run in children that load what childPreloads makes of the options. */
  const readHere = options.reads !== undefined && requests.length === 1 ? recordReads() : undefined;
  const children = requests.length === 1 ? undefined : childPreloads(options);
  (children === undefined ? runHere(requests[0]) : runAll(requests, child, children.preloads))
    .then(results => {
      if (options.reads !== undefined && readHere !== undefined) {
        writeReads(options.reads, withPnpTable(readHere(), options.pnp));
      }
      children?.finish();
      const report = buildReport(results.flatMap(toTestResults), start, Date.now());
      fs.writeFileSync(options.report, JSON.stringify(report, undefined, 2));
      const failed = report.results.summary.failed;
      endAfterReport(failed > 0 ? 1 : 0);
    })
    .catch((err: Error) => {
      console.error(err.stack ?? err.message);
      process.exit(1);
    });
}

/** One child's outcome as the parent sees it: what it reported, or why it did not. */
interface ICompletedFile {
  testFile: string;
  result?: IChildResult;
  /** The child's stderr, the trace of a file that died without reporting. */
  stderr: string;
  crash?: string;
}

/**
 * Run each file in a child of its own, at most `availableParallelism()` at a
 * time.
 * @return the outcomes, in the order of `requests`.
 */
async function runAll(requests: IChildRequest[], childModule: string, preloads: string[]): Promise<ICompletedFile[]> {
  const limit = Math.max(1, Math.min(availableParallelism(), requests.length));
  const queue = [...requests];
  const done: ICompletedFile[] = [];
  const workers = Array.from({ length: limit }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      done.push(await runOne(next, childModule, preloads));
    }
  });
  await Promise.all(workers);
  /* The caller's order, not the order the files finished. */
  const order = new Map(requests.map((request, index) => [request.testFile, index]));
  return done.sort((a, b) => (order.get(a.testFile) ?? 0) - (order.get(b.testFile) ?? 0));
}

/**
 * Run one file in this process. With no result after {@link CHILD_GRACE_MS}
 * the file is reported as crashed (the run's exit then ends the work still
 * going). A rejection becomes an `execError` result, as a child reports it.
 */
function runHere(request: IChildRequest): Promise<ICompletedFile[]> {
  return new Promise(resolve => {
    const guard = setTimeout(() => {
      resolve([
        {
          testFile: request.testFile,
          stderr: "",
          crash: `no result after ${Math.round(CHILD_GRACE_MS / 1000)}s — the test run appears wedged`,
        },
      ]);
    }, CHILD_GRACE_MS);
    guard.unref();
    runTestFile(request).then(
      result => {
        clearTimeout(guard);
        resolve([{ testFile: request.testFile, result, stderr: "" }]);
      },
      (err: unknown) => {
        clearTimeout(guard);
        resolve([
          {
            testFile: request.testFile,
            result: { testFile: request.testFile, results: [], execError: describeThrown(err) },
            stderr: "",
          },
        ]);
      }
    );
  });
}

function runOne(request: IChildRequest, childModule: string, preloads: string[]): Promise<ICompletedFile> {
  return new Promise<ICompletedFile>(resolve => {
    /* Pipe stderr, which holds the only reason a file that dies before
     * reporting gives. `--enable-source-maps`, so a stack frame names the
     * source line. */
    const child = fork(childModule, [], {
      cwd: request.root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [...process.execArgv, "--enable-source-maps", ...preloads.flatMap(preload => ["--require", preload])],
    });
    let stderr = "";
    let result: IChildResult | undefined;
    let settled = false;
    /* Settle once: a spawn failure delivers `error`, with or without a `close`
     * after it. */
    const finish = (crash: string | undefined): void => {
      if (!settled) {
        settled = true;
        clearTimeout(guard);
        resolve({ testFile: request.testFile, result, stderr, crash });
      }
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.stdout?.pipe(process.stdout);
    child.on("message", (message: IChildResult) => {
      result = message;
    });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\nfabr: no result after ${Math.round(CHILD_GRACE_MS / 1000)}s — the test process was killed`;
    }, CHILD_GRACE_MS);
    /* A child that could not be spawned (EAGAIN) is reported as a crash. */
    child.on("error", (err: Error) => finish(`could not run the test process: ${err.message}`));
    /* Use `close`, not `exit`: only `close` waits for the last IPC message and
     * stderr to arrive. */
    child.on("close", (code, signal) =>
      finish(result ? undefined : `the test process exited ${signal ? `on ${signal}` : `with status ${code}`} without reporting`)
    );
    child.send(request);
  });
}

/** The start of jest's failure for a missing snapshot it may not write, whose
 * advice (a jest CLI flag) is replaced by {@link FABR_REMEDY}. */
const NOT_WRITTEN = "New snapshot was not written";

/** The remedy for a missing snapshot: record one, or declare the existing one
 * as an expectation of the target (the run cannot tell which applies). */
const FABR_REMEDY =
  "No recorded snapshot for this test.\n\n" +
  "Run `fabr test -u <target>` to record one. If the snapshot file already exists in your source tree, " +
  "declare it as a recorded expectation of the target — `test_expectations = src:**/__snapshots__/*.snap;` on a " +
  "js_package, `expectations = …` on a js_test — not among its srcs.";

function withFabrRemedy(message: string): string {
  const at = message.indexOf(NOT_WRITTEN);
  return at === -1 ? message : message.slice(0, at) + FABR_REMEDY;
}

/** Circus's statuses, in fabr's (CTRF) vocabulary. */
const STATUS: Record<string, TestStatus> = {
  passed: "passed",
  failed: "failed",
  pending: "skipped",
  skipped: "skipped",
  todo: "pending",
  disabled: "skipped",
};

/**
 * Convert one file's results to CTRF entries: one per test it ran, plus one
 * named for the file where the file itself failed: it never reported (a crash,
 * an OOM, a broken preload; its stderr is the trace), circus could not load it,
 * or an error was raised outside any test (an unhandled rejection, a failed
 * `afterAll`). A file that reported neither a test nor an error is one failed
 * entry, "This test file registered no tests". Exported for its tests.
 */
export function toTestResults(file: ICompletedFile): ITestResult[] {
  /* The file's source path (see reportPathOf). */
  const relative = reportPathOf(file.testFile);
  const results = file.result?.results ?? [];
  const execError = file.result === undefined ? (file.crash ?? "the test process failed") : file.result.execError;
  if (execError === undefined && results.length === 0) {
    /* A failure: usually a file importing describe/it from `node:test`, whose
     * tests register with node:test, which this runner does not run. */
    return [
      {
        name: relative,
        filePath: relative,
        status: "failed",
        duration: 0,
        message: "This test file registered no tests",
        trace:
          "Nothing called describe/it in a way this runner can see. The usual cause is importing them from " +
          "'node:test' directly — those tests register with node:test, which the jest runner does not drive. " +
          "Use the globals (or '@jest/globals'), or run this target under a node:test-based runner.",
      },
    ];
  }
  const tests = results.map((test: IChildTestResult) => {
    /* Every formatted failure of the test (its body and a failing hook, say),
     * blank-line separated as jest prints them: the first line is the message,
     * the rest the trace. */
    const [summary, ...detail] =
      test.failureMessages.length > 0 ? test.failureMessages.map(withFabrRemedy).join("\n\n").split("\n") : [];
    return {
      name: test.fullName,
      filePath: relative,
      status: STATUS[test.status] ?? "other",
      duration: test.duration ?? 0,
      message: summary,
      trace: detail.join("\n").trim() || undefined,
    };
  });
  if (execError === undefined) {
    return tests;
  }
  /* The first line is the message and the rest the trace, else the captured
   * stderr. */
  const [reason, ...rest] = execError.split("\n");
  const detail = rest.join("\n").trim() || file.stderr.trim();
  return [
    ...tests,
    { name: relative, filePath: relative, status: "failed", duration: 0, message: reason, trace: detail || undefined },
  ];
}
