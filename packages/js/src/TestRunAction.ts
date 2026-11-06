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
 * The test-run action: one execution of a test runner over a staged
 * installation — the cache unit of a test run, built by the shared test
 * pipeline (which assembles `staged` and `argv`, and gives the run's output its
 * delivered shape). See TestPipeline for the run's construction.
 */

import * as fs from "fs";
import { join, posix } from "path";
import {
  ActionContext,
  BuildAction,
  BuildResult,
  Computable,
  COVERAGE_REPORT_FILENAME,
  execute,
  ExecutionError,
  FabrError,
  FileSet,
  fileSetInput,
  findExecutable,
  getResultFileSet,
  IBuildActionDefinition,
  IChangedFiles,
  IFile,
  IStagedStep,
  ITaskReport,
  ITestReport,
  lcovOf,
  mapComputable,
  MemoryFile,
  mergeCoverage,
  mergeTestReports,
  MultiError,
  PackageFileSet,
  parseJson,
  parseLcov,
  readJsonFile,
  stringListConfig,
  TaskProgress,
  TEST_REPORT_FILENAME,
  testFailureOf,
  toError,
  toJsonObject,
  toStringList,
  toTestReport,
  writeFileSet,
} from "@fabr-build/core";
import { type ICoverageOptions, MANIFEST_FLAG } from "@fabr-build/js-tools";
import { COMPILE_OUT_DIR } from "./rules/BuildJSCompile";

/**
 * The test-run build step: stage the complete installation (built in
 * resolution — deps as node_modules, the runner, the compiled tree, a minimal
 * package.json), execute the runner once per test file, and deliver the
 * collected outputs with the per-invocation reports merged into one. Per-file
 * invocation is a partition the runner contract permits, so each test process
 * is an ordinary unit of the machine-wide execution funnel. A run whose tests
 * failed is a result like a green one, and enters the cache: its merged report
 * says what failed, its task ends as failed, and the target fails where the
 * report is read (core's `checkTestReport`). A run that could not be performed —
 * an invocation that crashed, or wrote no report — throws, and enters nothing.
 */
const JS_TEST_STEP: IBuildActionDefinition = { id: "js:test-run", version: 8, run: runTests, stage: stageTests };

/** Read the `env` config member, the variables the test processes run with: each written `NAME=value`, a name holding no `=`. */
function declaredEnv(action: BuildAction): Record<string, string> {
  return Object.fromEntries(
    (Array.isArray(action.config.env) ? action.config.env : []).map((entry): [string, string] => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    })
  );
}

/** Stage the installation as {@link runTests} does, and describe its per-file invocations of the runner. */
function stageTests(action: BuildAction, dir: string, ensureTree: (files: FileSet) => Computable<string>): Computable<IStagedStep> {
  const staged = fileSetInput(action, "staged");
  const writable = fileSetInput(action, "writable");
  const argv = stringListConfig(action, "argv");
  return Computable.forAll([testFilesOf(action), writeFileSet(dir, staged.minus(writable)), mapComputable([...action.trees], ensureTree)], testFiles =>
    writeFileSet(dir, writable, { copy: true }).then(() => ({
      cwd: COMPILE_OUT_DIR,
      commands: testFiles.map((file, index) => [[findExecutable(argv[0], join(dir, COMPILE_OUT_DIR)), ...invocationOf(argv, file, index)]]),
      env: new Map(Object.entries(declaredEnv(action))),
    }))
  );
}

/** Where the test files' names are, among the action's inputs: an input
 * rather than configuration, so a test added or removed is a change the run
 * can see rather than a new target key. */
const TEST_FILES_INPUT = "tests";
const TEST_FILES_FILE = ".fabr-test-files.json";

/** @return the test files `action` runs, by their names in the compiled tree. */
function testFilesOf(action: BuildAction): Computable<string[]> {
  const file = fileSetInput(action, TEST_FILES_INPUT).getFile(TEST_FILES_FILE);
  if (file === undefined) {
    throw new FabrError(`internal: the test run names no test files`);
  }
  return readJsonFile(file, toStringList);
}


/** @return the runner's invocation for one test file: `argv` less its
 * interpreter, then the file's own report and reads documents, then the file. */
function invocationOf(argv: string[], file: string, index: number): string[] {
  return [...argv.slice(1), `--report=${invocationReport(index)}`, `--reads=${invocationReads(index)}`, file];
}

function runTests(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const workDir = ctx.workDir;
  const staged = fileSetInput(action, "staged");
  const writable = fileSetInput(action, "writable");
  const argv = stringListConfig(action, "argv");
  const outputs = stringListConfig(action, "outputs");
  const declared = declaredEnv(action);
  const coverageArgv = action.config.coverage_argv;
  const measured = Array.isArray(coverageArgv)
    ? measuredFilesOf(action).then(files => new TestCoverage(ctx, report, coverageArgv, declared, files))
    : Computable.resolve(undefined);
  /* Tests run with only the environment their target declares (no ambient vars
   * that could alter their output); a test that must spawn a tool references it
   * by an absolute path (e.g. process.execPath), which needs no PATH. The argv's leading command
   * (the runner's interpreter) is PATH-resolved here, at run time. */
  /* One admission for the whole installation — the two writes are halves of
   * staging it, not separate pieces of work — and given back before any test
   * process asks for a slot of its own. */
  return Computable.forAll([testFilesOf(action), ctx.changedFiles(), ctx.incrementalState().then(keptRunsOf), measured], (testFiles, changes, kept, coverage) => {
    const { rerun, reused } = filesToRun(testFiles, changes, kept, coverage !== undefined);
    return mapComputable([...action.trees], tree => ctx.ensureTree(tree))
      .then(() =>
        ctx.admit(report, () => writeFileSet(workDir, staged.minus(writable)).then(() => writeFileSet(workDir, writable, { copy: true })))
      )
      .then(() => {
        /* Each file's outcome is known the moment its invocation ends — the
         * report it wrote is read there — so the run can say how it is going
         * while it goes, rather than only in the summary at the end. */
        const tally = new RunTally(rerun.length, report.progress);
        return Computable.forAll(
          /* All issued at once: each execution queues on the funnel, which is
           * what schedules the files — against each other and against every
           * other execution in the build. A red file must not abort its
           * siblings (the report must be complete), so an invocation NEVER
           * rejects here; its outcome is judged as data below. */
          rerun.map(file => {
            const index = testFiles.indexOf(file);
            return runOneFile(ctx, report, argv, coverage?.environmentOf(index) ?? declared, file, index)
              .then(run =>
                coverage === undefined || "error" in run ? run : coverage.lcovOfFile(index).then(lcov => (lcov === undefined ? run : { ...run, coverage: lcov }))
              )
              .then(run => tally.add(run));
          }),
          (...runs) => concludeRun(workDir, testFiles, runs, reused, report)
        );
      })
      .then(latest => (coverage === undefined ? Computable.resolve(latest) : coverage.merge(latest).then(() => latest)))
      .then(latest => getResultFileSet(workDir, outputs).then(result => ({ result, incrementalState: keptStateOf(latest) })));
  });
}

/** Where a measured run's test processes write their V8 coverage, a directory per test file. */
const COVERAGE_RAW_DIR = ".fabr-coverage-raw";

/** Where the files a measured run measures are named, among the action's inputs. */
const COVERAGE_INPUT = "coverage";
const COVERAGE_MEASURED_FILE = ".fabr-coverage-measured.json";

/**
 * The coverage a measured run collects, per test file: each file's processes
 * write V8 coverage into a directory of its own, converted when the file ends
 * into the file's lcov — the measured files it loaded — which is kept with the
 * file's run, and merged with the others' (and with an entry for each measured
 * file nothing loaded) into the run's report.
 */
class TestCoverage {
  constructor(
    private readonly ctx: ActionContext,
    private readonly report: ITaskReport,
    private readonly argv: string[],
    private readonly env: Record<string, string>,
    private readonly measured: string[]
  ) {}

  /** @return the environment test file `index`'s processes run in. */
  public environmentOf(index: number): Record<string, string> {
    return { ...this.env, NODE_V8_COVERAGE: join(this.ctx.workDir, COVERAGE_RAW_DIR, String(index)) };
  }

  /** @return test file `index`'s lcov: the measured files its processes
   * loaded; undefined where they wrote no coverage, so none is kept. */
  public lcovOfFile(index: number): Computable<IFile | undefined> {
    const raw = posix.join(COVERAGE_RAW_DIR, String(index));
    return fs.existsSync(join(this.ctx.workDir, raw)) ? this.drive(`${index}`, { raw, loaded: true }) : Computable.resolve(undefined);
  }

  /** Write the run's lcov document: every test file's lcov, and an entry for
   * each measured file none of them loaded. */
  public merge(latest: ReadonlyArray<ILatestRun>): Computable<void> {
    return Computable.forAll(
      [
        this.drive("unloaded", { raw: posix.join(COVERAGE_RAW_DIR, "none") }).then(lcov => lcov.readString()),
        ...latest.map(run => (run.coverage === undefined ? Computable.resolve("") : run.coverage.readString())),
      ],
      (...documents) => {
        fs.writeFileSync(join(this.ctx.workDir, COVERAGE_REPORT_FILENAME), lcovOf(mergeCoverage(documents.map(parseLcov)).values()));
      }
    );
  }

  /** Run the coverage driver with `options` over the measured files, answering the lcov it wrote. */
  private drive(name: string, options: { raw: string; loaded?: boolean }): Computable<IFile> {
    const document = `.fabr-coverage.${name}.json`;
    const output = `.fabr-coverage.${name}.info`;
    const written: ICoverageOptions = { ...options, measured: this.measured, output };
    fs.writeFileSync(join(this.ctx.workDir, document), JSON.stringify(written));
    return execute(
      this.ctx.processLimit,
      findExecutable(this.argv[0], this.ctx.workDir),
      [...this.argv.slice(1), `${MANIFEST_FLAG}${document}`],
      this.ctx.workDir,
      this.env,
      { ...this.report, output: undefined }
    ).then(() => MemoryFile.from(fs.readFileSync(join(this.ctx.workDir, output), "utf8")));
  }
}

/** @return the files a measured run measures, by their install names. */
function measuredFilesOf(action: BuildAction): Computable<string[]> {
  const file = fileSetInput(action, COVERAGE_INPUT).getFile(COVERAGE_MEASURED_FILE);
  if (file === undefined) {
    throw new FabrError(`internal: the measured run names no measured files`);
  }
  return readJsonFile(file, toStringList);
}

/** What a test file's last run came to, as the step keeps it. */
export interface IKeptRun {
  report: ITestReport;
  /** What the run read, by install name; absent where its runner did not say. */
  reads?: ReadonlySet<string>;
  /** The run's lcov, in a measured run. */
  coverage?: IFile;
}

/** A test file's latest run: this run's, or the one kept. */
type ILatestRun = IKeptRun & { file: string };

/** Where a test file's lcov is kept, in the incremental state. */
function keptCoverageName(file: string): string {
  return `coverage/${file}.info`;
}

/** Where the step keeps each test file's last run, in its incremental state. */
const KEPT_RUNS_FILE = "runs.json";

/**
 * The kept-runs document: every name any file read, once, and per test file
 * its report and the indices of the names it read.
 */
interface IKeptRunsDocument {
  names: string[];
  runs: Array<{ file: string; report: ITestReport; reads?: number[] }>;
}

/** Convert a kept-runs document. */
function toKeptRunsDocument(json: unknown): IKeptRunsDocument {
  const document = toJsonObject(json);
  const names = toStringList(document.names);
  if (!Array.isArray(document.runs)) {
    throw new Error("expected a list of runs");
  }
  return {
    names,
    runs: document.runs.map(entry => {
      const run = toJsonObject(entry);
      if (typeof run.file !== "string") {
        throw new Error("expected a run's test file");
      }
      const reads = run.reads;
      if (reads !== undefined && (!Array.isArray(reads) || reads.some(index => typeof index !== "number" || names[index] === undefined))) {
        throw new Error(`expected the indices of what ${run.file} read`);
      }
      return { file: run.file, report: toTestReport(run.report), ...(reads === undefined ? {} : { reads: reads as number[] }) };
    }),
  };
}

/** @return the runs kept in `state`, by test file; undefined for no state, or
 * any it cannot read, which costs a full run. */
function keptRunsOf(state: FileSet | undefined): Computable<Map<string, IKeptRun> | undefined> {
  const file = state?.getFile(KEPT_RUNS_FILE);
  if (state === undefined || file === undefined) {
    return Computable.resolve(undefined);
  }
  return readJsonFile(file, toKeptRunsDocument).then(
    document =>
      new Map(
        document.runs.map((run): [string, IKeptRun] => {
          const coverage = state.getFile(keptCoverageName(run.file));
          return [
            run.file,
            {
              report: run.report,
              ...(run.reads === undefined ? {} : { reads: new Set(run.reads.map(index => document.names[index])) }),
              ...(coverage === undefined ? {} : { coverage }),
            },
          ];
        })
      ),
    () => undefined
  );
}

/** The test files a run runs, and the kept runs it takes for the others. */
export interface IFilesToRun {
  rerun: string[];
  reused: ReadonlyMap<string, IKeptRun>;
}

/**
 * @return the test files to run: every one, where nothing is kept to compare
 * with or a file was added or deleted — whether a file exists is not among what
 * a run reports reading, so no record can say whom that reaches — and
 * otherwise each with no kept run, a kept run that failed, a runner that did
 * not say what it read, a read among what changed, or — in a measured run — no
 * kept coverage; and the kept run of every other file.
 */
export function filesToRun(
  testFiles: string[],
  changes: IChangedFiles | undefined,
  kept: ReadonlyMap<string, IKeptRun> | undefined,
  measured: boolean
): IFilesToRun {
  if (kept === undefined || changes === undefined || changes.added.length > 0 || changes.deleted.length > 0) {
    return { rerun: testFiles, reused: new Map() };
  }
  const changed = new Set(changes.changed);
  const reused = new Map<string, IKeptRun>();
  for (const file of testFiles) {
    const run = kept.get(file);
    if (
      run !== undefined &&
      run.reads !== undefined &&
      !(measured && run.coverage === undefined) &&
      run.report.results.summary.failed === 0 &&
      ![...run.reads].some(read => changed.has(read))
    ) {
      reused.set(file, run);
    }
  }
  return { rerun: testFiles.filter(file => !reused.has(file)), reused };
}

/**
 * The run's outcomes so far, reported as each file lands.
 *
 * Per *file*, not per test: a file's report exists only once its process has
 * written it, so this is as live as the runner contract allows — the runner is
 * invoked, writes a report and exits, and says nothing in between. A file
 * whose invocation failed outright counts as
 * finished with nothing to add; the summary at the end is what judges it.
 */
class RunTally {
  private files = 0;
  private passed = 0;
  private failed = 0;

  constructor(private readonly totalFiles: number, private readonly report?: (progress: TaskProgress) => void) {}

  /** Record one finished invocation, and pass the run through unchanged. */
  public add(run: IFileRun): IFileRun {
    this.files++;
    const summary = "error" in run ? undefined : run.report.results.summary;
    this.passed += summary?.passed ?? 0;
    this.failed += summary?.failed ?? 0;
    this.report?.({
      measure: "tests",
      files: this.files,
      totalFiles: this.totalFiles,
      passed: this.passed,
      failed: this.failed,
    });
    return run;
  }
}

/** One invocation's outcome: its report, or the failure no report explains. */
type IFileRun = ({ file: string } & IKeptRun) | { file: string; error: Error };

/** Name the per-invocation reads document, distinct per file as its report is. */
function invocationReads(index: number): string {
  return `.fabr-reads.${index}.json`;
}

/** @return what a `--reads` document says was read, by install name (the
 * runner names them relative to its working directory, the compiled tree), or
 * undefined where the runner wrote none. */
function readsOf(document: string): ReadonlySet<string> | undefined {
  let names: string[];
  try {
    names = parseJson(fs.readFileSync(document), document, toStringList);
  } catch {
    return undefined;
  }
  return new Set(names.map(name => posix.normalize(posix.join(COMPILE_OUT_DIR, name))));
}

/** Name the per-invocation report: distinct per file so parallel invocations
 * never collide, and unselected by the `outputs` projection (only the merged
 * {@link TEST_REPORT_FILENAME} is), so collection discards them. */
function invocationReport(index: number): string {
  return `${TEST_REPORT_FILENAME}.${index}`;
}

function runOneFile(
  ctx: ActionContext,
  taskReport: ITaskReport,
  argv: string[],
  env: Record<string, string>,
  file: string,
  index: number
): Computable<IFileRun> {
  const reportName = invocationReport(index);
  const invocation = invocationOf(argv, file, index);
  /* Always captured (never streamed): the report carries the outcomes, the capture backs the no-report failure
   * path, and a per-file fan-out must not chatter a summary per process. The
   * activity half of the report is still passed through — these invocations
   * take slots of the machine's funnel like any others, and a run waiting for
   * one must not look like a run in progress. */
  const report = { ...taskReport, output: undefined };
  return execute(ctx.processLimit, findExecutable(argv[0], join(ctx.workDir, COMPILE_OUT_DIR)), invocation, join(ctx.workDir, COMPILE_OUT_DIR), env, report)
    .then(
      () => undefined,
      (err: Error) => err
    )
    .then(error => judgeRun(join(ctx.workDir, COMPILE_OUT_DIR), [argv[0], ...invocation], reportName, file, error))
    .then((run): IFileRun => {
      const reads = "error" in run ? undefined : readsOf(join(ctx.workDir, COMPILE_OUT_DIR, invocationReads(index)));
      return reads === undefined ? run : { ...run, reads };
    });
}

/**
 * Judge one invocation from its report, which is the run's result whatever
 * the process did after writing it (a runner may end by signal once it has
 * reported). With no usable report, a failed invocation is the mechanical
 * failure it was, and a successful one is a broken contract — left unchecked
 * it would cache as a passing file that ran no tests, and stay cached.
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
  return { file, report };
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Conclude the whole run from the per-file outcomes, answering every test
 * file's latest run: this run's where it ran, else the one `reused`.
 * Mechanical failures outrank test outcomes: an invocation that crashed means
 * the run did not happen as specified, so nothing merges and nothing caches.
 * Otherwise the reports merge into one, written as {@link TEST_REPORT_FILENAME}
 * red or green; where tests failed, the task is told so.
 */
function concludeRun(workDir: string, testFiles: string[], runs: IFileRun[], reused: ReadonlyMap<string, IKeptRun>, report: ITaskReport): ILatestRun[] {
  const errors = runs.flatMap(run => ("error" in run ? [run.error] : []));
  if (errors.length > 0) {
    throw MultiError.of(errors);
  }
  const ran = new Map(runs.flatMap(run => ("error" in run ? [] : [[run.file, run]])));
  const latest = testFiles.flatMap((file): ILatestRun[] => {
    const run = ran.get(file) ?? reused.get(file);
    return run === undefined ? [] : [{ ...run, file }];
  });
  const merged = mergeTestReports(latest.map(run => run.report));
  fs.writeFileSync(join(workDir, TEST_REPORT_FILENAME), JSON.stringify(merged, undefined, 2));
  const failure = testFailureOf(merged);
  if (failure !== undefined) {
    report.fail(failure);
  }
  return latest;
}

/** @return the incremental state keeping `latest`: the kept-runs document,
 * and each run's lcov. */
function keptStateOf(latest: ReadonlyArray<ILatestRun>): FileSet {
  const files = new Map<string, IFile>([[KEPT_RUNS_FILE, MemoryFile.from(keptRunsDocument(latest))]]);
  for (const run of latest) {
    if (run.coverage !== undefined) {
      files.set(keptCoverageName(run.file), run.coverage);
    }
  }
  return new FileSet(files);
}

/** Write `runs` as the kept-runs document. */
function keptRunsDocument(runs: ReadonlyArray<ILatestRun>): string {
  const names = [...new Set(runs.flatMap(run => [...(run.reads ?? [])]))].sort();
  const index = new Map(names.map((name, at) => [name, at]));
  const document: IKeptRunsDocument = {
    names,
    runs: runs.map(run => ({ file: run.file, report: run.report, ...(run.reads === undefined ? {} : { reads: [...run.reads].map(name => index.get(name)!).sort((a, b) => a - b) }) })),
  };
  return JSON.stringify(document);
}

/** What one test run is made from. */
export interface ITestRunInputs {
  /** The packages whose trees the run's PnP table names, which must be in
   * the cache's pool when it runs; none for an install with a `node_modules`
   * tree. */
  trees?: ReadonlyArray<PackageFileSet>;
  /** The complete installation. */
  staged: FileSet;
  /** The subset of `staged` the runner may rewrite (the recorded expectations,
   * under TEST_EXPECTATIONS=update): staged as writable copies rather than
   * links into the content store. */
  writable: FileSet;
  /** The runner invocation, without report or files: the step invokes it once
   * per `testFiles` entry, appending a per-invocation report name and the file. */
  argv: string[];
  testFiles: string[];
  /** The selectors for what the run leaves behind: the report, plus any
   * refreshed expectation files. */
  outputs: string[];
  /** The environment variables each invocation runs with: its whole environment. */
  env: ReadonlyMap<string, string>;
  /** Where the run is measured for coverage: the coverage driver's command
   * line, run from the install root, and the files it measures, by their
   * install names. */
  coverage?: { argv: string[]; measured: string[] };
}

/**
 * @return the action that runs the tests. A generic exec cannot serve: a red
 * run must fail the target while keeping the report.
 */
export function createTestRunAction({ trees, staged, writable, argv, testFiles, outputs, env, coverage }: ITestRunInputs): BuildAction {
  return new BuildAction(
    JS_TEST_STEP,
    {
      staged,
      writable,
      [TEST_FILES_INPUT]: FileSet.layout({ [TEST_FILES_FILE]: MemoryFile.from(JSON.stringify(testFiles)) }),
      ...(coverage ? { [COVERAGE_INPUT]: FileSet.layout({ [COVERAGE_MEASURED_FILE]: MemoryFile.from(JSON.stringify(coverage.measured)) }) } : {}),
    },
    {
      argv,
      outputs,
      ...(env.size > 0 ? { env: [...env].map(([name, value]) => `${name}=${value}`) } : {}),
      ...(coverage ? { coverage_argv: coverage.argv } : {}),
    },
    /* Each test file's last run is kept, and what changed since decides which
     * files run again. */
    { trackChangedFiles: true, trees }
  );
}
