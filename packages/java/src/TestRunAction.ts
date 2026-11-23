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
  commandLineConfig,
  Computable,
  COVERAGE_REPORT_FILENAME,
  execute,
  ExecutionError,
  FileSet,
  fileSetInput,
  findCommand,
  getResultFileSet,
  IBuildActionDefinition,
  ITaskReport,
  ITestReport,
  ITestResult,
  lcovOf,
  mergeCoverage,
  parseJson,
  parseLcov,
  retriedReport,
  RunnableArgument,
  secure,
  SecureString,
  stringListConfig,
  TEST_REPORT_FILENAME,
  testFailureOf,
  toArgv,
  toError,
  toTestReport,
  variableEntry,
  writeFileSet,
} from "@fabr-build/core";

/**
 * The step that runs a Java test suite: stage the install, run the runner once
 * over every test class (or the classes of the selected source files), and
 * collect its CTRF report, with the coverage report of a measured run beside
 * it. Where tests failed and the action allows retries, the runner runs again
 * over the source files whose tests failed (or over the whole selection, where
 * a failure names no file or the run died), and each file's report is
 * combined with its earlier runs' ({@link retriedReport}); the coverage of
 * every run is merged. A run whose tests failed is still a result: its report
 * says what failed, and its task ends as failed. Where the last run wrote no
 * usable report, the step fails with the runner's own output.
 */
const JAVA_TEST_STEP: IBuildActionDefinition = { id: "java:test-run", version: 6, run: runTests };

/** One run of the runner: its report, or the failure no report explains, and
 * the source files it ran (undefined for every class). */
export type IRun = { files?: string[] } & ({ report: ITestReport } | { error: Error });

function runTests(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const staged = fileSetInput(action, "staged");
  const argv = toArgv(commandLineConfig(action, "argv"));
  const outputs = stringListConfig(action, "outputs");
  const measured = outputs.includes(COVERAGE_REPORT_FILENAME);
  const retries = typeof action.config.flake_retries === "string" ? Number(action.config.flake_retries) : 0;
  const env = Object.fromEntries((Array.isArray(action.config.env) ? action.config.env : []).map(variableEntry));
  /* The source files the run is limited to (TEST_FILE_PATTERN); undefined for every class. */
  const selected = Array.isArray(action.config.select_files) ? stringListConfig(action, "select_files") : undefined;
  /* Run `files` (every class where undefined) as run number `index`. Keep the
   * runner's output for a failure rather than streaming it: the report carries
   * the outcome. */
  const runOnce = (index: number, files: string[] | undefined): Computable<IRun> => {
    const invocation = [
      ...argv.slice(1),
      `--report=${reportOf(index)}`,
      ...(index > 0 && measured ? [`--coverage=${coverageOf(index)}`] : []),
      ...(files ?? []).map(file => `--select-file=${file}`),
    ];
    return execute(ctx.processLimit, findCommand(argv[0], ctx.workDir), invocation, ctx.workDir, env, {
      ...report,
      output: undefined,
    })
      .then(
        () => undefined,
        (err: Error) => err
      )
      .then(error => ({
        ...(files === undefined ? {} : { files }),
        ...judgeRun(ctx.workDir, reportOf(index), [argv[0], ...invocation], error),
      }));
  };
  const attempt = (runs: IRun[]): Computable<IRun[]> => {
    const last = runs[runs.length - 1];
    const failed = "error" in last || last.report.results.summary.failed > 0;
    if (!failed || runs.length > retries) {
      return Computable.resolve(runs);
    }
    return runOnce(runs.length, "error" in last ? selected : (failedFiles(last.report) ?? selected)).then(next =>
      attempt([...runs, next])
    );
  };
  return ctx
    .admit(report, () => writeFileSet(ctx.workDir, staged))
    .then(() => runOnce(0, selected))
    .then(first => attempt([first]))
    .then(runs => {
      const last = runs[runs.length - 1];
      if ("error" in last) {
        throw last.error;
      }
      const combined = runs.length === 1 ? last.report : combinedReport(runs);
      fs.writeFileSync(path.join(ctx.workDir, TEST_REPORT_FILENAME), JSON.stringify(combined, undefined, 2));
      if (measured && runs.length > 1) {
        mergeRunCoverage(ctx.workDir, runs.length);
      }
      const failure = testFailureOf(combined);
      if (failure !== undefined) {
        report.fail(failure);
      }
      return getResultFileSet(ctx.workDir, outputs);
    })
    .then(result => ({ result }));
}

/** @return the name of run `index`'s report, apart from the step's own, which combines them. */
function reportOf(index: number): string {
  return `${TEST_REPORT_FILENAME}.${index}`;
}

/** @return the name of run `index`'s coverage report; the first run's is the step's own. */
function coverageOf(index: number): string {
  return index === 0 ? COVERAGE_REPORT_FILENAME : `${COVERAGE_REPORT_FILENAME}.${index}`;
}

/** @return the source files whose tests failed in `report`, sorted; undefined where a failure names no file. */
export function failedFiles(report: ITestReport): string[] | undefined {
  const failed = report.results.tests.filter(test => test.status === "failed");
  if (failed.some(test => test.filePath === undefined)) {
    return undefined;
  }
  return [...new Set(failed.map(test => test.filePath!))].sort();
}

/**
 * Combine the runs of a suite into its report: each source file's tests as the
 * last run that ran it reported them, marked with what its earlier runs did
 * ({@link retriedReport}). A run that died counts, for every file it ran, as
 * every test failing; a file first reported after such a run of every class
 * counts it too. `runs` must end with a run that wrote a report.
 */
export function combinedReport(runs: IRun[]): ITestReport {
  const byFile = new Map<string, Array<ITestReport | undefined>>();
  let wholeDeaths = 0;
  for (const run of runs) {
    if ("error" in run) {
      for (const [file, history] of byFile) {
        if (run.files === undefined || run.files.includes(file)) {
          history.push(undefined);
        }
      }
      wholeDeaths += run.files === undefined ? 1 : 0;
      continue;
    }
    const reported = new Map<string, ITestResult[]>();
    for (const test of run.report.results.tests) {
      const file = test.filePath ?? "";
      reported.set(file, [...(reported.get(file) ?? []), test]);
    }
    const covered = run.files === undefined ? new Set([...byFile.keys(), ...reported.keys()]) : new Set(run.files);
    for (const file of covered) {
      const history = byFile.get(file) ?? Array.from({ length: wholeDeaths }, (): ITestReport | undefined => undefined);
      history.push(reportOfTests(run.report, reported.get(file) ?? []));
      byFile.set(file, history);
    }
  }
  const reports = runs.flatMap(run => ("error" in run ? [] : [run.report]));
  const tests = [...byFile.values()].flatMap(history => {
    const last = history[history.length - 1];
    return last === undefined ? [] : retriedReport(history.slice(0, -1), last).results.tests;
  });
  return {
    results: {
      tool: reports[0].results.tool,
      summary: {
        tests: tests.length,
        passed: tests.filter(test => test.status === "passed").length,
        failed: tests.filter(test => test.status === "failed").length,
        pending: tests.filter(test => test.status === "pending").length,
        skipped: tests.filter(test => test.status === "skipped").length,
        other: tests.filter(test => test.status === "other").length,
        start: Math.min(...reports.map(report => report.results.summary.start)),
        stop: Math.max(...reports.map(report => report.results.summary.stop)),
      },
      tests,
    },
  };
}

/** @return `report` holding only `tests` (its summary left as it is: only the tests are read). */
function reportOfTests(report: ITestReport, tests: ITestResult[]): ITestReport {
  return { results: { ...report.results, tests } };
}

/** Merge the coverage reports of a suite's `count` runs into the step's own. */
function mergeRunCoverage(workDir: string, count: number): void {
  const documents = Array.from({ length: count }, (_, index) => path.join(workDir, coverageOf(index)))
    .filter(file => fs.existsSync(file))
    .map(file => parseLcov(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(path.join(workDir, COVERAGE_REPORT_FILENAME), lcovOf(mergeCoverage(documents).values()));
}

/**
 * Judge the run whose report is `reportName`, given the run's own `error`.
 * @return the run's report; or the failure no report explains: `error` where
 *   the run failed and its report is unreadable or records no failed test, or
 *   an ExecutionError naming `invocation` where the run succeeded but its
 *   report is unreadable.
 */
function judgeRun(
  workDir: string,
  reportName: string,
  invocation: ReadonlyArray<string | SecureString>,
  error: Error | undefined
): { report: ITestReport } | { error: Error } {
  let report: ITestReport;
  try {
    report = parseJson(fs.readFileSync(path.join(workDir, reportName)), reportName, toTestReport);
  } catch (readErr) {
    if (error !== undefined) {
      return { error };
    }
    return {
      error: new ExecutionError(
        `$ ${invocation.map(arg => (typeof arg === "string" ? arg : arg.toDisplayString())).join(" ")}\nthe test runner exited successfully but its report is unusable: ${toError(readErr).message}`
      ),
    };
  }
  if (error !== undefined && report.results.summary.failed === 0) {
    return { error };
  }
  return { report };
}

/** How a suite's run treats failures and caching. */
export interface ITestRunStability {
  /** The further runs the tests that failed get. */
  retries: number;
  /** Whether the run's result is never cached. */
  uncached: boolean;
}

/** @return the action that runs `argv` (the runner's command line, less its report) in `staged`
 * with the environment `env` and no other, collecting the coverage report too where the run is `measured`.
 * It retries and caches as `stability` says, and runs only the tests of the source files `selected`
 * names, where it is given. */
export function createTestRunAction(
  staged: FileSet,
  argv: readonly RunnableArgument[],
  measured: boolean,
  env: ReadonlyMap<string, SecureString>,
  { retries, uncached }: ITestRunStability,
  selected?: readonly string[]
): BuildAction {
  return new BuildAction(
    JAVA_TEST_STEP,
    { staged },
    {
      argv,
      outputs: [TEST_REPORT_FILENAME, ...(measured ? [COVERAGE_REPORT_FILENAME] : [])],
      ...(env.size > 0 ? { env: [...env].map(([name, value]) => secure`${name}=${value}`) } : {}),
      ...(retries > 0 ? { flake_retries: String(retries) } : {}),
      ...(selected === undefined ? {} : { select_files: [...selected] }),
    },
    { uncached }
  );
}
