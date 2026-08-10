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
 * Fabr's test runner with a JEST COMPATIBILITY LAYER — the flavour that drives
 * **jest-circus itself** rather than emulating it over node:test.
 *
 * The split: circus owns the test framework (describe/it, hooks, `.each`,
 * `.only`, `.concurrent`, timeouts, `expect` with its snapshot state and
 * assertion counting), and fabr owns the module system (node's real loader plus
 * the mock registry, the load-time hoist and the `jest` object). Neither jest's
 * orchestrator nor `jest-runtime` runs: circus is handed a facade over eleven
 * methods it actually calls, so modules load through node and `require(esm)`
 * keeps working — the capability jest's own vm-based loader lacks.
 *
 * This file is the parent. node:test is not involved at all, so process
 * management is ours: fork a child per test file, bounded, and aggregate what
 * they report into the CTRF document fabr's contract expects. Per-TEST timeouts
 * are circus's, enforced inside the child; the parent's only timing concern is
 * a child that never reports at all. Invoked with a SINGLE file — which is how
 * fabr calls it, once per test file, so the machine-wide scheduling is the
 * build's — the file runs in this process instead (see {@link runHere}).
 *
 * Usage (the runner contract, same as every flavour):
 *   node runner.js --report=<path> --env=<node|jsdom> [--update-snapshots]
 *                  [--setup=<module|./staged path>]... <test-file>...
 */

import { availableParallelism } from "node:os";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ITestResult, TestStatus } from "@fabr-build/core";
import { buildReport, formatTestFailures, formatTestSummary, reportPathOf } from "../testRunner/Report";
import { parseRunnerArgs } from "../testRunner/RunTests";
import { assertSupportedHost, requireEnvironment } from "./Tools";
import { describeThrown, runTestFile } from "./child";
import type { IChildRequest, IChildResult, IChildTestResult } from "./child";

/**
 * Per-test timeout handed to circus. Generous, and a safety net rather than a
 * policy: it only ever catches a genuine hang, and a test (or `jest.setTimeout`)
 * overrides it per jest's own rules. The shim flavour had to bake this in
 * because node:test takes one timeout for the whole run; circus takes it per
 * test, which is why it can simply be passed along here.
 */
const TEST_TIMEOUT_MS = 120_000;

/**
 * How long a child may run without reporting at all. A backstop against a
 * WEDGED process, not a budget for the work: a file's tests are bounded
 * individually by {@link TEST_TIMEOUT_MS} (circus enforces that per test, and
 * fails the test rather than the file), while the file's TOTAL is by design
 * unbounded — it holds as many tests as it holds.
 *
 * So this has to exceed a plausible total, not a plausible test. Sized at ten
 * minutes for that reason: fabr's own heaviest e2e file spawns a `fabr`
 * subprocess per test and legitimately runs several minutes under a saturated
 * gate, and killing it at the old file-budget of three minutes reported a
 * healthy suite as "the test process was killed".
 *
 * A child reports once, at the end, so there is no progress signal to reset
 * this against — the honest fix is for the child to report per test (circus
 * offers `sendMessageToJest` for exactly that), after which this could be a
 * short idle timeout instead of a long total one.
 */
const CHILD_GRACE_MS = 600_000;

export function main(argv: string[]): void {
  const options = parseRunnerArgs(argv);
  /* Fail here, once, rather than identically in every child. */
  assertSupportedHost();
  requireEnvironment(options.env);
  /* Stack frames resolve through the inline maps tsc and the hoist emit, so a
   * failure names the `.ts` line. The forked children get this via execArgv
   * below; THIS process needs it too, because a single-file invocation — which
   * is how fabr calls the runner, once per test file — runs in-process. */
  process.setSourceMapsEnabled(true);

  const start = Date.now();
  const child = path.join(__dirname, "child.js");
  const root = process.cwd();
  const request = (testFile: string): IChildRequest => ({
    testFile: path.resolve(testFile),
    root,
    env: options.env,
    updateSnapshots: options.update,
    timeoutMs: TEST_TIMEOUT_MS,
    setup: options.setup,
  });

  const requests = options.files.map(request);
  (requests.length === 1 ? runHere(requests[0]) : runAll(requests, child))
    .then(results => {
      const report = buildReport(results.flatMap(toTestResults), start, Date.now());
      fs.writeFileSync(options.report, JSON.stringify(report, undefined, 2));
      const failed = report.results.summary.failed;
      console.log(failed > 0 ? formatTestFailures(report) : formatTestSummary(report));
      process.exit(failed > 0 ? 1 : 0);
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
  /** The child's stderr, kept for a file that died without reporting — see
   * toTestResults. */
  stderr: string;
  crash?: string;
}

/**
 * Run every file, at most `availableParallelism()` at a time. A plain bounded
 * pool: the unit of concurrency is the FILE, matching the isolation boundary,
 * and the cap keeps a large suite from spawning hundreds of node processes at
 * once.
 */
async function runAll(requests: IChildRequest[], childModule: string): Promise<ICompletedFile[]> {
  const limit = Math.max(1, Math.min(availableParallelism(), requests.length));
  const queue = [...requests];
  const done: ICompletedFile[] = [];
  const workers = Array.from({ length: limit }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      done.push(await runOne(next, childModule));
    }
  });
  await Promise.all(workers);
  /* Restore the caller's order: the pool completes out of order, and a report
   * whose contents depend on scheduling is a report that churns. */
  const order = new Map(requests.map((request, index) => [request.testFile, index]));
  return done.sort((a, b) => (order.get(a.testFile) ?? 0) - (order.get(b.testFile) ?? 0));
}

/**
 * One file, run in THIS process rather than forked. fabr invokes the runner
 * once per test file (a partition the contract permits), so this process
 * already IS the per-file isolation boundary a fork would provide — forking
 * again would only add a node startup per file. The pool below remains for a
 * standalone invocation with a list.
 *
 * The wedge backstop mirrors the forked path's guard, minus the process to
 * kill: with no result after {@link CHILD_GRACE_MS} the run is declared
 * crashed and reported through the ordinary finish path (whose process.exit
 * takes the wedged work down, as the SIGKILL did). unref'd, so a completed
 * run never waits on it. A throw out of the run is shaped exactly as the
 * forked child shapes it — an execError result — so reporting is one path.
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

function runOne(request: IChildRequest, childModule: string): Promise<ICompletedFile> {
  return new Promise<ICompletedFile>(resolve => {
    /* stdio piped, not inherited: a file that dies before reporting leaves its
     * reason ONLY on stderr, and that is what makes the difference between a
     * report that says why and one that says "test failed". */
    /* `--enable-source-maps` makes node resolve stack frames through the inline
     * maps tsc and the hoist emit, so a failure names the `.ts` line rather than
     * the compiled one. Jest normally does this itself via its transformer's map
     * registry, which fabr does not use. */
    const child = fork(childModule, [], {
      cwd: request.root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [...process.execArgv, "--enable-source-maps"],
    });
    let stderr = "";
    let result: IChildResult | undefined;
    let settled = false;
    /* Settle-once: `close` is the ordinary end, but a spawn failure delivers
     * `error` (with or without a `close` after it), and double-resolving would
     * double-count the file. */
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
    /* A child that could not be spawned at all (EAGAIN under a saturated
     * machine) reports through the same shape as a crash — without this
     * listener the runner itself dies with an uncaught exception and no file
     * gets a result. */
    child.on("error", (err: Error) => finish(`could not run the test process: ${err.message}`));
    /* `close`, not `exit`: exit fires when the process dies, while its last IPC
     * message and stderr tail can still be undelivered; close waits for the
     * stdio (the IPC channel among them) to drain, so a result sent just before
     * exiting is never mistaken for a crash. */
    child.on("close", (code, signal) =>
      finish(result ? undefined : `the test process exited ${signal ? `on ${signal}` : `with status ${code}`} without reporting`)
    );
    child.send(request);
  });
}

/** jest's phrasing for "there is no recorded snapshot and I am not allowed to
 * write one". Its advice — a jest CLI flag, and a guess about CI — is not
 * fabr's, so the tail of the message is replaced. */
const NOT_WRITTEN = "New snapshot was not written";

/** The two ways to reach that failure are "there is no record yet" and "the
 * record exists in your tree but the target wasn't given it" —
 * indistinguishable from inside a hermetic run, so the remedy covers both. */
const FABR_REMEDY =
  "No recorded snapshot for this test.\n\n" +
  "Run `fabr test -u <target>` to record one. If the snapshot file already exists in your source tree, " +
  "add it to the target's inputs — snapshot files are ordinary srcs (e.g. `srcs = src:**/*.ts src:**/__snapshots__/*.snap;`).";

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
 * One file's results as CTRF entries. A file that never reported becomes a
 * single failure named for the file, carrying its stderr as the trace — the
 * same treatment the node:test flavour gives a file that dies while loading,
 * and for the same reason: without it the user is told only that something
 * failed.
 */
function toTestResults(file: ICompletedFile): ITestResult[] {
  /* Named as the TARGET names it — see reportPathOf. */
  const relative = reportPathOf(file.testFile);
  if (!file.result || file.result.execError !== undefined) {
    /* Circus reports a file that failed to LOAD as an execError carrying the
     * real cause, so that is the message; the stack below it becomes the trace.
     * The captured stderr is the fallback for the other shape — a child that
     * died without reporting at all (a crash, an OOM, a broken preload), where
     * nothing else can say why. */
    const [reason, ...rest] = (file.result?.execError ?? file.crash ?? "the test process failed").split("\n");
    const detail = rest.join("\n").trim() || file.stderr.trim();
    return [{ name: relative, filePath: relative, status: "failed", duration: 0, message: reason, trace: detail || undefined }];
  }
  if (file.result.results.length === 0) {
    /* A file that registered nothing is a MISTAKE, not a pass. The way to get
     * here is a test file that imports describe/it from `node:test` directly:
     * those registrations go to node:test, which this flavour never runs, so
     * the file would contribute nothing and the run would stay green — a silent
     * hole exactly where a test suite must not have one. */
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
  return file.result.results.map((test: IChildTestResult) => {
    /* Circus hands back jest's FULLY formatted failure — the matcher diff, the
     * code frame, the stack. Keeping only the first line (as a one-line-per-test
     * summary wants) throws away the part that says what actually differed, so
     * the summary takes the first line and the rest becomes the trace, which the
     * report renders indented beneath it. */
    const [summary, ...detail] = test.failureMessages.length > 0 ? withFabrRemedy(test.failureMessages[0]).split("\n") : [];
    return {
      name: test.fullName,
      filePath: relative,
      status: STATUS[test.status] ?? "other",
      duration: test.duration ?? 0,
      message: summary,
      trace: detail.join("\n").trim() || undefined,
    };
  });
}

if (require.main === module) {
  main(process.argv.slice(2));
}
