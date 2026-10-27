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
  execute,
  ExecutionError,
  FileSet,
  fileSetInput,
  findExecutable,
  formatTestFailures,
  getResultFileSet,
  IBuildActionDefinition,
  ITaskReport,
  ITestReport,
  parseJson,
  stringListConfig,
  TEST_REPORT_FILENAME,
  TestsFailedError,
  toError,
  toTestReport,
  writeFileSet,
} from "@fabr-build/core";

/**
 * The step that runs a Java test suite: stage the install, run the runner once
 * on every test class, and deliver its CTRF report. A red run fails the
 * target with the failures the report names; a run that wrote no report
 * fails with the runner's own output.
 */
const JAVA_TEST_STEP: IBuildActionDefinition = { id: "java:test-run", version: 1, run: runTests };

function runTests(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const staged = fileSetInput(action, "staged");
  const argv = stringListConfig(action, "argv");
  const invocation = [...argv.slice(1), `--report=${TEST_REPORT_FILENAME}`];
  return ctx
    .admit(report, () => writeFileSet(ctx.workDir, staged))
    .then(() =>
      /* Tests run with no environment of their own: nothing ambient can change what they do. The
       * report carries the outcome, so the runner's output is kept for a failure, not streamed. */
      execute(ctx.processLimit, findExecutable(argv[0], ctx.workDir), invocation, ctx.workDir, {}, { ...report, output: undefined }).then(
        () => undefined,
        (err: Error) => err
      )
    )
    .then(error => {
      const run = judgeRun(ctx.workDir, [argv[0], ...invocation], error);
      const { failed, tests } = run.results.summary;
      if (failed > 0) {
        throw new TestsFailedError(formatTestFailures(run), failed, tests);
      }
      return getResultFileSet(ctx.workDir, [TEST_REPORT_FILENAME]);
    })
    .then(result => ({ result }));
}

/** @return the run's report, or throw where the run went wrong in a way its report does not explain. */
function judgeRun(workDir: string, invocation: string[], error: Error | undefined): ITestReport {
  let report: ITestReport;
  try {
    report = parseJson(fs.readFileSync(path.join(workDir, TEST_REPORT_FILENAME)), TEST_REPORT_FILENAME, toTestReport);
  } catch (readErr) {
    if (error !== undefined) {
      throw error;
    }
    throw new ExecutionError(`$ ${invocation.join(" ")}\nthe test runner exited successfully but its report is unusable: ${toError(readErr).message}`);
  }
  if (error !== undefined && report.results.summary.failed === 0) {
    throw error;
  }
  return report;
}

/** @return the action that runs `argv` (the runner's command line, less its report) in `staged`. */
export function createTestRunAction(staged: FileSet, argv: string[]): BuildAction {
  return new BuildAction(JAVA_TEST_STEP, { staged }, { argv });
}
