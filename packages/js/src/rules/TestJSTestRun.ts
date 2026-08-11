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
 * The js_test_run rule: one execution of a test runner over a staged
 * installation — the cache unit of a test run, composed by the shared test
 * pipeline (which assembles `staged` and `argv`) rather than declared by hand.
 * It exists as a *target* rather than an action the test rules yield directly
 * so that its output is observable in the caller's resolution: that is what
 * lets refreshed snapshot files reach the driver on a cache hit as well as on a
 * miss. See TestPipeline for the run's construction and for the reshaping of
 * this target's output.
 */

import * as fs from "fs";
import { join } from "path";
import { COMPILE_OUT_DIR } from "./BuildJSCompile";
import {
  BuildAction,
  BuildActionInputs,
  Computable,
  execute,
  ExecutionError,
  FileSet,
  fileSetInput,
  findExecutable,
  formatTestFailures,
  getResultFileSet,
  IActionContext,
  IBuildActionDefinition,
  ITestReport,
  mergeTestReports,
  MultiError,
  parseJson,
  RuleRegistration,
  RuleResult,
  stringListInput,
  TargetContext,
  TEST_REPORT_FILENAME,
  TestsFailedError,
  toError,
  toTestReport,
  writeFileSet,
} from "@fabr-build/core";

/**
 * The js_test_run build step: stage the complete installation (built in
 * resolution — deps as node_modules, the runner, the compiled tree, a minimal
 * package.json), execute the runner once per test file, and deliver the
 * collected outputs with the per-invocation reports merged into one. Per-file
 * invocation is a partition the runner contract permits, and it is what makes
 * each test process an ordinary unit of the machine-wide execution funnel —
 * files interleave with every other execution of the build instead of the
 * runner multiplying fabr's parallelism by its own. Only green runs enter the
 * cache — a red run throws (as TestsFailedError when the reports say so),
 * which also removes the partial entry, so tests re-run until they pass. That
 * is also the v1 rule for updates: a run red for any *other* reason yields
 * nothing, so nothing is offered back to the tree.
 */
const JS_TEST_STEP: IBuildActionDefinition = { id: "js:test-run", version: 6, run: runTests };

function runTests(inputs: BuildActionInputs, ctx: IActionContext): Computable<FileSet> {
  const workDir = ctx.workDir;
  const staged = fileSetInput(inputs, "staged");
  const writable = fileSetInput(inputs, "writable");
  const argv = stringListInput(inputs, "argv");
  const testFiles = stringListInput(inputs, "test_files");
  const outputs = stringListInput(inputs, "outputs");
  /* Tests run with a clean environment (no ambient vars that could alter their
   * output); a test that must spawn a tool references it by an absolute path
   * (e.g. process.execPath), which needs no PATH. The argv's leading command
   * (the runner's interpreter) is PATH-resolved here, at run time. */
  return writeFileSet(workDir, staged.minus(writable))
    .then(() => writeFileSet(workDir, writable, { copy: true }))
    .then(() =>
      Computable.forAll(
        /* All issued at once: each execution queues on the funnel, which is
         * what schedules the files — against each other and against every
         * other execution in the build. A red file must not abort its
         * siblings (the report must be complete), so an invocation NEVER
         * rejects here; its outcome is judged as data below. */
        testFiles.map((file, index) => runOneFile(ctx, argv, file, index)),
        (...runs) => concludeRun(workDir, runs)
      )
    )
    .then(() => getResultFileSet(workDir, outputs));
}

/** One invocation's outcome: its report, or the failure no report explains. */
interface IFileRun {
  file: string;
  report?: ITestReport;
  error?: Error;
}

/** The per-invocation report name: distinct per file so parallel invocations
 * never collide, and unselected by the `outputs` projection (only the merged
 * {@link TEST_REPORT_FILENAME} is), so collection discards them. */
function invocationReport(index: number): string {
  return `${TEST_REPORT_FILENAME}.${index}`;
}

function runOneFile(ctx: IActionContext, argv: string[], file: string, index: number): Computable<IFileRun> {
  const reportName = invocationReport(index);
  const invocation = [...argv.slice(1), `--report=${reportName}`, file];
  /* Always captured (never live), as the one-invocation step always was: the
   * report carries the outcomes, the capture backs the no-report failure
   * path, and a per-file fan-out must not chatter a summary per process. */
  return execute(ctx.processLimit, findExecutable(argv[0]), invocation, join(ctx.workDir, COMPILE_OUT_DIR), {}, true)
    .then(
      () => undefined,
      (err: Error) => err
    )
    .then(error => judgeRun(join(ctx.workDir, COMPILE_OUT_DIR), [argv[0], ...invocation], reportName, file, error));
}

/**
 * Judge one invocation from its exit and its report: a red exit the report
 * explains (failed tests) is a test outcome; a red exit with no usable report
 * is the mechanical failure it was; a GREEN exit without a usable report is a
 * broken contract — left unchecked it would cache as a passing file that ran
 * no tests, and stay cached.
 */
function judgeRun(workDir: string, invocation: string[], reportName: string, file: string, error: Error | undefined): IFileRun {
  let report: ITestReport;
  try {
    report = parseJson(fs.readFileSync(join(workDir, reportName)), reportName, toTestReport);
  } catch (readErr) {
    if (error !== undefined) {
      /* Absent or unreadable after a red exit: the invocation's own error is
       * the better story (it carries the captured output). */
      return { file, error };
    }
    const detail = isMissingFile(readErr)
      ? `the test runner exited successfully but wrote no ${reportName} for ${file}`
      : `the test runner's report for ${file} is unusable: ${toError(readErr).message}`;
    return { file, error: new ExecutionError(`$ ${invocation.join(" ")}\n${detail}`) };
  }
  if (error !== undefined && report.results.summary.failed === 0) {
    /* A non-zero exit the report does not explain — the run broke after (or
     * despite) reporting green, and no report can improve on that. */
    return { file, error };
  }
  return { file, report };
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Conclude the whole run from the per-file outcomes. Mechanical failures
 * outrank test outcomes: an invocation that crashed means the run did not
 * happen as specified, so nothing merges and nothing caches. Otherwise the
 * reports merge into the one document the target delivers — written as
 * {@link TEST_REPORT_FILENAME} for collection when green, rendered into the
 * thrown TestsFailedError when red (the action fails, so the driver reads the
 * failure, not the artifact — as before).
 */
function concludeRun(workDir: string, runs: IFileRun[]): void {
  const errors = runs.flatMap(run => (run.error ? [run.error] : []));
  if (errors.length > 0) {
    throw MultiError.of(errors);
  }
  const merged = mergeTestReports(runs.flatMap(run => (run.report ? [run.report] : [])));
  const { summary } = merged.results;
  if (summary.failed > 0) {
    throw new TestsFailedError(formatTestFailures(merged), summary.failed, summary.tests);
  }
  fs.writeFileSync(join(workDir, TEST_REPORT_FILENAME), JSON.stringify(merged, undefined, 2));
}

/**
 * The rule's evaluate: an internal sub-target whose whole job is to be the
 * cache unit for one test run. It is deliberately not a step yielded straight
 * from the test rules — being a target, its output is observable in the
 * caller's resolution (see TestPipeline's planTestRun), which is what lets
 * refreshed snapshots reach the driver on a cache hit as well as a miss. A
 * generic exec can't serve here either: a red run must fail the target while
 * keeping the report.
 */
function evaluateTestRun(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSetProperties(["staged", "writable"]),
      context.getRequiredProperty("argv"),
      context.getRequiredProperty("test_files"),
      context.getRequiredProperty("outputs"),
    ],
    ({ staged, writable }, argv, testFiles, outputs) =>
      new BuildAction(JS_TEST_STEP, {
        staged: FileSet.unionAll(...staged),
        writable: FileSet.unionAll(...writable),
        argv: argv.getValues(),
        test_files: testFiles.getValues(),
        outputs: outputs.getValues(),
      })
  );
}

export const jsTestRunRule: RuleRegistration = { type: "js_test_run", constraints: {}, evaluate: evaluateTestRun };
