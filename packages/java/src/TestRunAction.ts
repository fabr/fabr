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

import * as fs from "fs";
import * as path from "path";
import {
  ActionContext,
  BuildAction,
  BuildResult,
  Computable,
  COVERAGE_REPORT_FILENAME,
  execute,
  ExecutionError,
  commandLineConfig,
  FileSet,
  fileSetInput,
  findExecutable,
  getResultFileSet,
  IBuildActionDefinition,
  ITaskReport,
  ITestReport,
  parseJson,
  RunnableArgument,
  stringListConfig,
  TEST_REPORT_FILENAME,
  testFailureOf,
  toArgv,
  toError,
  toTestReport,
  writeFileSet,
} from "@fabr-build/core";

/**
 * The step that runs a Java test suite: stage the install, run the runner once
 * over every test class, and collect its CTRF report, with the coverage report
 * of a measured run beside it. A run whose tests failed is still a result and
 * is cached: its report says what failed, and its task ends as failed. A run
 * that wrote no usable report fails with the runner's own output.
 */
const JAVA_TEST_STEP: IBuildActionDefinition = { id: "java:test-run", version: 4, run: runTests };

function runTests(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const staged = fileSetInput(action, "staged");
  const argv = toArgv(commandLineConfig(action, "argv"));
  const invocation = [...argv.slice(1), `--report=${TEST_REPORT_FILENAME}`];
  return ctx
    .admit(report, () => writeFileSet(ctx.workDir, staged))
    .then(() =>
      /* Run with an empty environment. Keep the runner's output for a failure rather than
       * streaming it: the report carries the outcome. */
      execute(
        ctx.processLimit,
        findExecutable(argv[0], ctx.workDir),
        invocation,
        ctx.workDir,
        {},
        { ...report, output: undefined }
      ).then(
        () => undefined,
        (err: Error) => err
      )
    )
    .then(error => {
      const failure = testFailureOf(judgeRun(ctx.workDir, [argv[0], ...invocation], error));
      if (failure !== undefined) {
        report.fail(failure);
      }
      return getResultFileSet(ctx.workDir, stringListConfig(action, "outputs"));
    })
    .then(result => ({ result }));
}

/**
 * @return the run's report. Throws the run's own `error` where the run failed
 * and its report is unreadable or records no failed test, and an
 * ExecutionError naming `invocation` where the run succeeded but its report is
 * unreadable.
 */
function judgeRun(workDir: string, invocation: string[], error: Error | undefined): ITestReport {
  let report: ITestReport;
  try {
    report = parseJson(fs.readFileSync(path.join(workDir, TEST_REPORT_FILENAME)), TEST_REPORT_FILENAME, toTestReport);
  } catch (readErr) {
    if (error !== undefined) {
      throw error;
    }
    throw new ExecutionError(
      `$ ${invocation.join(" ")}\nthe test runner exited successfully but its report is unusable: ${toError(readErr).message}`
    );
  }
  if (error !== undefined && report.results.summary.failed === 0) {
    throw error;
  }
  return report;
}

/** @return the action that runs `argv` (the runner's command line, less its report) in `staged`,
 * collecting the coverage report too where the run is `measured`. */
export function createTestRunAction(staged: FileSet, argv: readonly RunnableArgument[], measured: boolean): BuildAction {
  return new BuildAction(
    JAVA_TEST_STEP,
    { staged },
    { argv, outputs: [TEST_REPORT_FILENAME, ...(measured ? [COVERAGE_REPORT_FILENAME] : [])] }
  );
}
