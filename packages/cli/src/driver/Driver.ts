/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import {
  BUILD_OPERATION,
  FabrError,
  globMatcher,
  isGlob,
  FILES_OPERATION,
  affectsAny,
  audit,
  auditSarif,
  BuildContext,
  INameValue,
  ISarifLocation,
  ISourceSpan,
  osvServer,
  parseJson,
  Property,
  targetsReadWithin,
  toVexStatements,
  VexStatement,
  requireWhole,
  ResolvedName,
  sarifLocation,
  sbom,
  BuildModel,
  buildOperation,
  describeOperation,
  Computable,
  mapComputable,
  ComputableHandle,
  declPosn,
  Diagnostic,
  ExecutionContext,
  Fabr,
  FileSet,
  hashString,
  formatTestFailures,
  formatTestSummary,
  IFile,
  getTestReport,
  ITestReport,
  mergeTestReports,
  TestsFailedError,
  toJUnitXml,
  Name,
  parseName,
  Log,
  LogFormatter,
  LogLevel,
  IPropertyDecl,
  isFileSource,
  isNameValue,
  isPropertyDecl,
  ITargetDecl,
  ITargetDefDecl,
  propertyTypeName,
  PublishableFileSet,
  Reference,
  isIncompleteRef,
  refuseNamespaces,
  reportFailure,
  SyncSource,
  testOperation,
  forceTargets,
  toRunnable,
  signalInteractiveChild,
  SourceRef,
  toError,
  writeFileSet,
  Constraints,
  IResolvedWriteBack,
  sourcePathOf,
  writeBackCandidates,
  COVERAGE_REPORT_FILENAME,
  coverageTotals,
  getCoverageReports,
  ICoverageTotal,
  lcovOf,
  MemoryFile,
  mergeCoverage,
  parseLcov,
  TEST_NAME_PATTERN,
} from "@fabr-build/core";
import { runInteractive, RunSupervisor } from "./RunHandler";
import { shellInto } from "./ShellHandler";
import { DependencyTree, renderAudit, renderDependencyTrees, sectionsOf } from "./DepsTree";
import { publishSync } from "./SyncHandler";
import { BspServer } from "./BspServer";
import { JsonRpcConnection } from "./JsonRpc";
import { LanguageServer } from "./LanguageServer";
import { completeCommandLine, Mode, Options, getVersion } from "./Command";
import { getSourceRoot, getBuildCacheRoot, getHostProperties } from "./Environment";
import { IInvocationSite } from "./CommandLineSource";
import { TerminalInteraction } from "./Interaction";
import { identityProviderOf } from "./Identity";
import { ProgressReporter } from "./Progress";
import { TraceWriter } from "./Trace";
import { setActiveTerminal, TerminalStream } from "./Terminal";
import * as fs from "node:fs";
import * as path from "node:path";

const DIAG_FAILED = Diagnostic.Error<{ work: string }>("{work} failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");
const DIAG_COVERAGE = Diagnostic.Info<{ lines: string; functions: string; branches: string }>(
  "Coverage: lines {lines}, functions {functions}, branches {branches}"
);
const DIAG_COVERAGE_WRITTEN = Diagnostic.Info<{ file: string }>("Coverage report written to {file}");
const DIAG_TRACE_UNWRITTEN = Diagnostic.Warn<{ file: string; message: string }>("Could not write the trace to {file}: {message}");
const DIAG_TEST_REPORT_WRITTEN = Diagnostic.Info<{ file: string }>("Test report written to {file}");
const DIAG_COVERAGE_NONE = Diagnostic.Warn<Record<string, never>>("No test target measured any coverage");
/* Measured sources the project's tree cannot locate (generated during the
 * build), which the report leaves out. */
const DIAG_COVERAGE_UNPLACEABLE = Diagnostic.Warn<{ count: number; examples: string }>(
  "Left {count} generated source(s) out of the coverage report, having no source path: {examples}"
);
/* A target declares it fixes an advisory that does not affect the package it
 * is made from (a stale or misspelt id). */
const DIAG_AUDIT_UNMATCHED_FIX = Diagnostic.Warn<{ target: string; id: string; pkg: string }>(
  "'{target}' declares it fixes {id}, which is not an advisory affecting {pkg}"
);
const DIAG_AUDIT_UNATTACHED_FIX = Diagnostic.Warn<{ target: string; id: string }>(
  "'{target}' declares it fixes {id}, but is made from no registry package for an advisory to affect"
);
const DIAG_WATCHING = Diagnostic.Info<Record<string, never>>("Watching for changes (Ctrl-C to stop)");
const DIAG_UNHANDLED = Diagnostic.Warn<{ message: string }>("Unhandled error: {message}");
const DIAG_COPIED = Diagnostic.Info<{ count: number; dest: string }>("Copied {count} file(s) to {dest}");
const DIAG_EXPECTATION_UPDATED = Diagnostic.Info<{ file: string }>("Updated {file}");
/* A refreshed record whose test has no place in the source tree, which is
 * not written. */
const DIAG_EXPECTATION_UNPLACEABLE = Diagnostic.Warn<{ test: string }>(
  "Refreshed the recorded expectation for {test}, but it is not a source-tree file — there is nowhere to write it back to"
);
/* Two test runs offered different refreshed content for one destination
 * (environment-dependent output, say); the first offer is written. */
const DIAG_EXPECTATION_CONFLICT = Diagnostic.Warn<{ file: string }>(
  "Conflicting updates for {file} from different test runs; keeping the first"
);

/** How long a signalled watch process's teardown may take before the process
 * is made to exit (status 1). */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Ignore EPIPE errors on fabr's own stdout and stderr, which a consumer closing
 * the pipe early causes (`fabr cat … | head`); rethrow any other stream error.
 * Do not exit here: the command still runs to its own {@link flushAndExit}, so
 * the exit status is its outcome (a failing build whose stderr pipe broke still
 * exits 1). Later writes to the closed stream fail the same way, and their
 * callbacks still fire.
 */
function ignorePipeErrors(): void {
  const onError = (err: NodeJS.ErrnoException): void => {
    if (err.code !== "EPIPE") {
      throw err;
    }
  };
  process.stdout.on("error", onError);
  process.stderr.on("error", onError);
}

/**
 * Exit with `code` once stdout and stderr have drained: `process.exit()` alone
 * discards what is still buffered for a pipe (truncating a piped `fabr cat`).
 * Exits from the callback of a zero-length write to each stream, which fires
 * once everything queued ahead of it has flushed.
 */
function flushAndExit(code: number): void {
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) {
      process.exit(code);
    }
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

/** A command's work on the loaded model, run by {@link runWith}. `execution`
 * holds the run's log, cache and progress; `site` is where the invocation was
 * run, which a name given on the command line is written in. Resolves a
 * {@link Takeover} where the command takes over the process afterwards. */
export type Operation = (model: BuildModel, execution: ExecutionContext, site: IInvocationSite) => Computable<void | Takeover>;

/** What a command does once its evaluation has settled and its cycle closed:
 *  launch `fabr run`'s program, query `fabr audit`'s advisory database.
 *  Resolves the run's exit status, which {@link runWith} exits with after the
 *  cache trim. */
export type Takeover = () => Computable<number>;

/**
 * Run the CLI: run `options.command`, as an {@link Operation} over the loaded
 * model, through {@link runWith}. `build`, `test` and `run` take target names,
 * built under `BUILD_OPERATION` set to the command (a `-DBUILD_OPERATION` takes
 * precedence); `ls`, `cat` and `cp` materialize each whole name (a target and
 * its projection, `pkg:build/*.js`) under the `files` operation
 * ({@link resolveNames}). A line with no command is finished once the model is
 * loaded ({@link runInferred}).
 */
export function runFabr(options: Options): Promise<void> {
  ignorePipeErrors();
  /* `-w` applies to build, test and run (relaunching the program on change);
   * every other command runs once. */
  const watch =
    options.mode === Mode.Watch && (options.command === "build" || options.command === "test" || options.command === "run");
  switch (options.command) {
    case "ls":
      return runWith(options, (model, execution, site) =>
        Computable.forAll(listedNames(model, options, execution, site), (...results) => listTargets(options, results))
      );
    case "cat":
      return runWith(options, (model, execution, site) =>
        Computable.forAll(resolveNames(model, options, execution, site), (...results) => catTarget(options, results))
      );
    case "cp":
      return runWith(options, (model, execution, site) =>
        Computable.forAll(resolveNames(model, options, execution, site), (...results) => copyTarget(options, execution, results))
      );
    case "deps":
      return runWith(options, (model, execution, site) => printDependencies(model, options, execution, site));
    case "audit":
      return runWith(options, (model, execution, site) => auditDependencies(model, options, execution, site));
    case "sbom":
      return runWith(options, (model, execution, site) => writeSbom(model, options, execution, site));
    case "test":
      return runWith(options, (model, execution, site) => runTest(model, options, execution, site, options.targets), watch);
    case "run": {
      const supervisors = new Supervisors();
      return runWith(options, (model, execution, site) => runProgram(model, options, execution, site, watch, supervisors), watch);
    }
    case "shell":
      return runWith(options, (model, execution, site) => shellTarget(model, options, execution, site));
    case "sync":
      return runWith(options, (model, execution, site) => syncTargets(model, options, execution, site));
    case "build-server": {
      /* One server for the run, across every model a reload makes. */
      return getSourceRoot().then(root => {
        /* End the run as a signal does, so the watchers shut down first. */
        const end = (): void => void process.kill(process.pid, "SIGTERM");
        const connection = new JsonRpcConnection(process.stdout);
        const server = new BspServer(root, connection, end);
        const language = new LanguageServer(root, connection, uri => server.isServed(uri));
        connection.listen(process.stdin, end);
        /* The driver's own log, which a describe failure is reported to, set
         * by the run's setup before the operation runs. The run's log, made
         * from it, also collects the diagnostics of loading the build files. */
        let reporting: Log | undefined;
        return runWith(
          options,
          (model, execution, site) => {
            language.useModel(model);
            const describing = describeOperation(
              model,
              operation => configFor(model, options, execution, operation),
              name => options.commandLine.refFor(name, site),
              execution
            );
            server.serve(describing, reporting!, {
              build: name => buildOperation(configFor(model, options, execution, "build"), [options.commandLine.refFor(name, site)]),
              test: name => testOperation(configFor(model, options, execution, "test"), [options.commandLine.refFor(name, site)]),
            });
            return describing.settled;
          },
          true,
          {
            log: log => {
              reporting = log;
              return language.observe(log);
            },
            execution: execution => {
              server.attach(execution);
              language.attach(execution);
            },
          }
        );
      });
    }
    case "list-targets":
      return runWith(options, (model, execution) => listDeclaredTargets(model, options, execution));
    case "list-targetdefs":
      return runWith(options, model => listTargetDefs(model, options));
    case "list-operations":
      return runWith(options, model => listOperations(model, options));
    case "list-properties":
      return runWith(options, model => listProperties(model, options));
    case "list-all":
      return runWith(options, model => listAll(model));
    default:
      /* build, or no command at all */
      if (options.deferred) {
        const supervisors = new Supervisors();
        return runWith(
          options,
          (model, execution, site) => runInferred(model, options, execution, site, options.mode === Mode.Watch, supervisors),
          watch
        );
      }
      return runWith(options, (model, execution, site) => runBuild(model, options, execution, site, options.targets), watch);
  }
}

/**
 * A watched run's supervisors, by target, kept for the whole run. Keep them
 * outside the operation: it is evaluated again on each model load (a build file
 * edited under watch), and must reach the supervisor of the program already
 * running, or a second copy would start beside it.
 */
class Supervisors {
  private readonly byTarget = new Map<string, RunSupervisor>();

  /** Get the supervisor of `target`, made on first ask. */
  public of(execution: ExecutionContext, key: string, target: string, args: string[]): RunSupervisor {
    let supervisor = this.byTarget.get(target);
    if (supervisor === undefined) {
      supervisor = new RunSupervisor(execution.buildCache, key, target, args, execution.log);
      this.byTarget.set(target, supervisor);
    }
    return supervisor;
  }
}

/** Build `names` under `operation` (`fabr build`, or an operation a rule
 *  declares: `fabr lint app`) through core's {@link buildOperation}. */
function runBuild(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite,
  names: string[],
  operation = "build"
): Computable<void> {
  markForced(model, options, execution, names);
  /* `build` of a target whose type only runs builds its program, not starting it. */
  const operationFor = (name: string): string => (operation === "build" && runsOnly(model, name) ? "run" : operation);
  const operations = [...new Set(names.map(operationFor))];
  return Computable.forAll(
    operations.map(each =>
      buildOperation(
        configFor(model, options, execution, each),
        names.filter(name => operationFor(name) === each).map(name => options.commandLine.refFor(name, site))
      )
    ),
    () => undefined
  );
}

/** @return true if `name` names a target whose type has a rule for `run` and none for `build`, otherwise false. */
function runsOnly(model: BuildModel, name: string): boolean {
  const target = model.getReferencedTarget(name);
  const operations = target === undefined ? [] : model.getOperations(target.type);
  return operations.includes("run") && !operations.some(operation => operation === "build" || operation === "*");
}

/** Run `fabr test <targets>` through core's {@link testOperation}, then, each
 * time a watch cycle changes the results: log each target's summary, write
 * `--report`'s file, write refreshed expectations back where no test failed,
 * and report coverage. Fails where any test failed, after the reports are
 * written, or where `-t` matched no test. */
function runTest(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite,
  names: string[]
): Computable<void> {
  markForced(model, options, execution, names);
  execution.retryFailed = options.retryFailed;
  const refs = names.map(name => options.commandLine.refFor(name, site));
  return testOperation(configFor(model, options, execution, "test"), refs).then(results =>
    Computable.forAll(
      results.map(sources => getTestReport(sources)),
      (...reports: (ITestReport | undefined)[]) => reports
    ).then(reports => {
      const failure = reportTestResults(execution.log, names, reports, options.properties.get(TEST_NAME_PATTERN) || undefined);
      return (
        options.reportFile === undefined
          ? Computable.resolve(undefined)
          : writeTestReport(execution, site, options.reportFile, options.format, reports)
      )
        .then(() => (failure === undefined ? applyExpectationUpdates(execution, site, results) : undefined))
        .then(() => (options.coverageDir === undefined ? undefined : reportCoverage(execution, site, options.coverageDir, results)))
        .then(() => {
          if (failure !== undefined) {
            throw failure;
          }
        });
    })
  );
}

/** Write the run's test results, every name's merged into one report, to `file`, as CTRF or (`junit`) JUnit XML. */
function writeTestReport(
  execution: ExecutionContext,
  site: IInvocationSite,
  file: string,
  format: Options["format"],
  reports: (ITestReport | undefined)[]
): Computable<void> {
  const present = reports.filter((report): report is ITestReport => report !== undefined);
  const report = present.length === 0 ? emptyTestReport() : present.length === 1 ? present[0] : mergeTestReports(present);
  const text = format === "junit" ? toJUnitXml(report) : `${JSON.stringify(report, null, 2)}\n`;
  return site.sourceFileSource
    .writeFile(path.resolve(file), MemoryFile.from(text))
    .then(() => execution.log.log(DIAG_TEST_REPORT_WRITTEN, { file }));
}

/** @return a report of a run that ran no tests. */
function emptyTestReport(): ITestReport {
  const now = Date.now();
  return {
    results: {
      tool: { name: "fabr" },
      summary: { tests: 0, passed: 0, failed: 0, pending: 0, skipped: 0, other: 0, start: now, stop: now },
      tests: [],
    },
  };
}

/** Format a coverage total as the summary shows it: the percentage, then the counts. */
function coverageText({ covered, total }: ICoverageTotal): string {
  return total === 0 ? "n/a" : `${((covered / total) * 100).toFixed(2)}% (${covered}/${total})`;
}

/**
 * Merge the coverage every test result carries, log its totals, and write it as
 * `<dir>/lcov.info`, naming each source by its path in the project. A record
 * whose source the project's tree cannot locate is left out, with a warning;
 * where no result carries coverage, a warning is logged and nothing written.
 *
 * Written through the source tree, as an expectation update is, so a watching
 * run recognises a write inside the tree as its own.
 */
function reportCoverage(execution: ExecutionContext, site: IInvocationSite, dir: string, results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map(sources => getCoverageReports(sources)),
    (...documents: string[][]): Computable<void> | void => {
      const measured = documents.flat();
      if (measured.length === 0) {
        execution.log.log(DIAG_COVERAGE_NONE, {});
        return;
      }
      const sources = site.sourceFileSource;
      const placed = [];
      const unplaced = [];
      for (const record of mergeCoverage(measured.map(parseLcov)).values()) {
        const located = sources.locate(record.source);
        if (located === undefined) {
          unplaced.push(record.source);
        } else {
          placed.push({ ...record, source: path.relative(sources.root, located).split(path.sep).join("/") });
        }
      }
      if (unplaced.length > 0) {
        execution.log.log(DIAG_COVERAGE_UNPLACEABLE, { count: unplaced.length, examples: unplaced.slice(0, 3).join(", ") });
      }
      const destination = path.resolve(dir, COVERAGE_REPORT_FILENAME);
      const totals = coverageTotals(placed);
      execution.log.log(DIAG_COVERAGE, {
        lines: coverageText(totals.lines),
        functions: coverageText(totals.functions),
        branches: coverageText(totals.branches),
      });
      return site.sourceFileSource
        .writeFile(destination, MemoryFile.from(lcovOf(placed)))
        .then(() => execution.log.log(DIAG_COVERAGE_WRITTEN, { file: path.join(dir, COVERAGE_REPORT_FILENAME) }));
    }
  );
}

/**
 * Write the refreshed test expectations (snapshots) the results offer back into
 * the source tree; call it only after a green run. Each offered file lands
 * beside the source of the input it belongs to, at its path relative to that
 * input. An offer whose input has no place in the source tree is skipped, with
 * a warning. Identical offers for one destination are written once; where two
 * differ, the first is written and the conflict warned about. Each file
 * written is logged.
 *
 * Only a run under `TEST_EXPECTATIONS=update`, however it was set, offers
 * anything, so no flag is checked here.
 */
function applyExpectationUpdates(execution: ExecutionContext, site: IInvocationSite, results: SourceRef[][]): Computable<void> {
  /* The writes, by destination. */
  const writes = new Map<string, IResolvedWriteBack>();
  for (const { files, belongsTo, origin } of results.flatMap(sources => writeBackCandidates(sources))) {
    /* `files` are named as the inputs are; `belongsTo` maps each name to the
     * input it belongs to. */
    const belongs = belongsTo.makeProjector();
    for (const [name, file] of files) {
      const input = belongs(name);
      if (input === undefined) {
        /* `belongsTo` names no input for this file: warn, naming the file. */
        execution.log.log(DIAG_EXPECTATION_UNPLACEABLE, { test: name });
        continue;
      }
      const sourcePath = sourcePathOf(origin, input);
      const source = sourcePath === undefined ? undefined : site.sourceFileSource.locate(sourcePath);
      if (source === undefined) {
        execution.log.log(DIAG_EXPECTATION_UNPLACEABLE, { test: input });
        continue;
      }
      /* The file goes at its path relative to the input's directory, beside the
       * input's source. Deduplicate by destination: two targets covering one
       * tree (a js_test beside a js_package) offer the same record, and two
       * writes to one path would collide on the temp sibling. */
      const destination = path.join(path.dirname(source), path.relative(path.dirname(input), name));
      const existing = writes.get(destination);
      if (existing === undefined) {
        writes.set(destination, { file, destination });
      } else if (existing.file.hash !== file.hash) {
        execution.log.log(DIAG_EXPECTATION_CONFLICT, { file: path.relative(site.sourceFileSource.root, destination) });
      }
    }
  }
  if (writes.size === 0) {
    return Computable.resolve(undefined);
  }
  /* Write through the source tree, not straight to the filesystem, so a
   * watching run recognises the resulting events as its own and does not
   * rebuild the target that produced them. */
  return site.sourceFileSource.applyWriteBack([...writes.values()]).then((written: string[]) => {
    for (const destination of written) {
      execution.log.log(DIAG_EXPECTATION_UPDATED, { file: path.relative(site.sourceFileSource.root, destination) });
    }
  });
}

/**
 * Run a command-less invocation (`fabr docs_serve`): finish the command line
 * now that the model is loaded ({@link completeCommandLine}), then build, test
 * and run each group of targets as the explicit command would. Under watch the
 * groups run side by side, each re-settling on its own; keep them so, not
 * chained one after another. A one-shot run's program comes after the rest, as
 * the run's {@link Takeover}.
 */
function runInferred(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite,
  watch: boolean,
  supervisors: Supervisors
): Computable<void | Takeover> {
  const plan = completeCommandLine(options, name => operationsOf(model, name), declaredOperations(model));
  const groups: Computable<void>[] = [];
  if (plan.operation !== undefined) {
    groups.push(runBuild(model, options, execution, site, plan.operation.targets, plan.operation.name));
  }
  if (plan.build.length > 0) {
    groups.push(runBuild(model, options, execution, site, plan.build));
  }
  if (plan.test.length > 0) {
    groups.push(runTest(model, options, execution, site, plan.test));
  }
  const run = plan.run;
  if (!run) {
    return Computable.forAll(groups, () => undefined);
  }
  const program = (): Computable<void | Takeover> =>
    runProgram(model, options, execution, site, watch, supervisors, run.target, run.args);
  if (watch) {
    return Computable.forAll([...groups, program()], () => undefined);
  }
  /* One-shot: build the groups, then the run target, in one evaluation; the
   * program's launch is its takeover, after the status marker. */
  return Computable.forAll(groups, () => undefined).then(program);
}

/**
 * @return the operations a rule declares that a command can name: each a rule's
 * guard names literally, other than those the commands already are (`build`,
 * `test`, `run`) and `files`, which `ls`, `cat` and `cp` read under.
 */
function declaredOperations(model: BuildModel): Set<string> {
  const builtIn = new Set(["build", "test", "run", FILES_OPERATION]);
  const declared = model.getTargetDefs().flatMap(def => model.getOperations(def.name));
  return new Set(declared.filter(operation => !builtIn.has(operation) && !/[*?[\]{}!]/.test(operation)));
}

/** @return the operations the named target's type supports, or none at all if
 * the name doesn't name a declared target (an unknown name, or a property):
 * the caller then asks for a build and gets the ordinary resolution failure. */
function operationsOf(model: BuildModel, name: string): string[] {
  const decl = model.getTargetDecl(name);
  return decl ? model.getOperations(decl.type) : [];
}

/**
 * Run `fabr run <target> [args…]`: build the target under `run`, for the host,
 * and launch the program. One-shot, resolve a {@link Takeover} that stages the
 * program and runs it interactively, its exit status the run's. Under watch,
 * hand each runnable the evaluation settles to to the target's
 * {@link RunSupervisor}, which relaunches the program, or updates the content
 * it serves, as the build changes. Rejects where the name matches no files or
 * is not runnable.
 */
function runProgram(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite,
  watch: boolean,
  supervisors: Supervisors,
  target: string = options.targets[0],
  args: string[] = options.runArgs ?? []
): Computable<void | Takeover> {
  /* The program runs on this machine, so it is resolved as a rule's tool is:
   * for HOST, whatever TARGET was given. */
  const config = configFor(model, options, execution, "run").getRunContext();
  markForced(model, options, execution, [target]);
  const key = programKey(site, options, target);
  const supervisor = watch ? supervisors.of(execution, key, target, args) : undefined;
  /* The name is the program (`fabr run @npm:http-server:14.1.1`), so under
   * `run` materialize resolves its closure permissively, as a rule's `tool` is. */
  return config.materialize(options.commandLine.refFor(target, site)).then<void | Takeover>(materialized => {
    const sources = refuseNamespaces(materialized);
    /* A projected runnable (`fabr run pkg:tsc`) arrives with its projection
     * pending: collapse it to its launcher. */
    const runnable = sources.map(toRunnable).find(Boolean);
    if (!runnable) {
      /* A projection that matched nothing is the "matched no files" error, as
       * for cat and ls; content that is not runnable is another. */
      const files = FileSet.unionAll(...sources.filter((s): s is FileSet => s instanceof FileSet));
      throw files.isEmpty()
        ? matchedNoFiles(target)
        : new FabrError(`'${target}' is not runnable (it has no BUILD_OPERATION=run result)`);
    }
    if (supervisor) {
      /* Return the supervisor's update within the evaluation, so the cycle's
       * end, and its marker, come after it. */
      return supervisor.update(runnable);
    }
    /* One-shot: launch once the evaluation has settled and its cycle closed,
     * as the run's takeover. */
    const takeover: Takeover = () => runInteractive(execution.buildCache, key, runnable, args);
    return takeover;
  });
}

/** Make the key the cache keeps the installs of a program `fabr run` launches
 * under: a hash of the project root, the name run and the properties set on the
 * command line. */
function programKey(site: IInvocationSite, options: Options, target: string): string {
  const properties = [...options.properties].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return hashString(JSON.stringify([fs.realpathSync(site.sourceFileSource.root), target, properties]));
}

/**
 * Run `fabr shell <target>`: get the target's build action under `build`,
 * without running it, and resolve a {@link Takeover} that stages its sandbox
 * and opens a shell in it ({@link shellInto}), the shell's exit status the
 * run's.
 */
function shellTarget(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite
): Computable<void | Takeover> {
  const config = configFor(model, options, execution, "build");
  return config.getAction(options.commandLine.refFor(options.targets[0], site)).then<void | Takeover>(action => {
    /* A takeover, like run's program: the shell starts once the evaluation
     * has settled. */
    const takeover: Takeover = () => shellInto(execution.buildCache, options.targets[0], action, execution.log);
    return takeover;
  });
}

/**
 * Run `fabr sync <name>…`: materialize each whole name under `build` and
 * publish its members, each through its destination's own publish
 * ({@link publishSync}). A name may be a release, all of whose members are
 * published in publish order, or a member within one
 * (`release/@npm/x/1.0.0`), published alone; a name that is neither is an
 * error.
 */
function syncTargets(model: BuildModel, options: Options, execution: ExecutionContext, site: IInvocationSite): Computable<void> {
  const config = configFor(model, options, execution, "build");
  const resolved = options.targets.map(name =>
    config.materialize(options.commandLine.refFor(name, site)).then(sources => refuseNamespaces(sources))
  );
  return Computable.forAll(resolved, (...results: SourceRef[][]) =>
    Computable.forAll(
      results.map((sources, i) => membersOf(sources, options.targets[i])),
      (...members: PublishableFileSet[][]) => publishSync(execution, members.flat())
    )
  );
}

/** @return the members to publish of one materialized name: those of each
 *  release among `sources`, dependencies first, then the members it names
 *  directly. Throws where it holds neither. */
function membersOf(sources: SourceRef[], name: string): Computable<PublishableFileSet[]> {
  const releases = sources.filter((source): source is SyncSource => source instanceof SyncSource);
  const carriers = sources.filter((source): source is PublishableFileSet => source instanceof PublishableFileSet);
  if (releases.length === 0 && carriers.length === 0) {
    throw new FabrError(`'${name}' is not a sync target`);
  }
  return Computable.forAll(
    releases.map(release => release.members()),
    (...packaged: PublishableFileSet[][]) => [...packaged.flat(), ...carriers]
  );
}

/** What a verb adds around its run: what it observes of the run's log, and of its execution once made. */
interface IRunSetup {
  /** The log the run reports to, made from the driver's own. */
  log?: (log: Log) => Log;
  /** Called with the run's execution, before anything is loaded. */
  execution?: (execution: ExecutionContext) => void;
}

/**
 * Run one command: set up the run (the stderr log and progress display, the
 * {@link Fabr} facade with its cache and source tree, the trace, the terminal
 * interaction and the CI identity), load the project and evaluate `operation`
 * on it. `setup` adds what the command observes of the run's log and
 * execution.
 *
 * One-shot, it exits 0 on success, or with the status of the operation's
 * {@link Takeover} once that has run, the cache trim done first. A failure,
 * including one setting up the run (no project found), renders the failure
 * tree and exits 1. A drained event loop with no exit is reported as an
 * internal error (exit 2). With `watch`, {@link runWatched} takes over and
 * never exits on its own.
 */
async function runWith(options: Options, operation: Operation, watch = false, setup: IRunSetup = {}): Promise<void> {
  /* Diagnostics and progress go to stderr, a command's data (ls listings, cat
   * contents) to stdout. Colour stderr on a tty unless NO_COLOR is set to
   * anything non-empty; when off, colour in captured tool output is stripped. */
  const color = process.stderr.isTTY === true && !process.env.NO_COLOR;
  /* Write everything fabr renders to stderr (diagnostics, and the build steps'
   * forwarded output) through one TerminalStream, so its live pane can erase
   * and repaint around each block. The pane shows on a tty, unless `-q` (which
   * also drops the streamed step output) or `--no-progress`. */
  const terminal = new TerminalStream(process.stderr, process.stderr.isTTY === true && !options.quiet && options.progress);
  const log = new LogFormatter(LogLevel.Info, line => terminal.write(line), color);
  /* For the code that hands the terminal over rather than writes to it (a
   * prompt, an interactive child): see withTerminalSuspended. */
  setActiveTerminal(terminal);

  Computable.onUnhandledError = err => log.log(DIAG_UNHANDLED, { message: err.message });

  /* Guard against a stall one-shot only: under watch a drained event loop is
   * the normal idle state. */
  if (!watch) {
    process.on("beforeExit", () => {
      log.log(DIAG_ERROR, { message: "Internal error: the build stalled without completing" });
      process.exit(2);
    });
  }

  try {
    const sourceRoot = await getSourceRoot();
    const fabr = new Fabr({
      sourceRoot,
      cacheRoot: getBuildCacheRoot(),
      log: setup.log?.(log) ?? log,
      watch,
      host: Constraints.of(getHostProperties()),
      includeOptionalLibs: options.includeOptional,
      refresh: options.refresh,
    });
    const execution = fabr.execution;
    setup.execution?.(execution);
    /* Where the user typed the command, in the source tree's own namespace: a
     * name given on the command line resolves its bare paths from here, as a
     * name written in a build file resolves them from that file's directory. */
    const site: IInvocationSite = {
      sourceFileSource: fabr.sourceFileSource,
      absFileSource: execution.absFileSource,
      invocationDir: path.relative(sourceRoot, process.cwd()).split(path.sep).join("/"),
    };
    /* Build events become the log's start/completion lines, the pane, and the
     * prefixed step-output lines. Under -q the subscription asks for no output
     * events, so steps show output only inside a failure. */
    const progress = new ProgressReporter(log, {
      terminal,
      color,
      quiet: options.quiet,
      markers: showsMarkers(options.command, watch),
    });
    execution.onBuildEvent(progress.buildListener, { output: !options.quiet });
    if (options.traceFile !== undefined) {
      /* Each cycle's events are added at its end; the trace is finished from
       * an exit hook, since process.exit runs no continuation. */
      const traceFile = path.resolve(process.cwd(), options.traceFile);
      const trace = new TraceWriter(traceFile, {
        onError: err => log.log(DIAG_TRACE_UNWRITTEN, { file: traceFile, message: err.message }),
      });
      execution.onBuildEvent(trace.buildListener);
      process.on("exit", () => trace.write());
    }
    /* A terminal to ask on (an npm publish's second factor), only where stdin
     * and stderr are both ttys. Without one, a caller that must ask fails with
     * an error. */
    if (process.stdin.isTTY === true && process.stderr.isTTY === true) {
      execution.interaction = new TerminalInteraction(log);
    }
    execution.identityProvider = identityProviderOf(process.env);

    if (fabr.controller) {
      return runWatched(operation, fabr, site, log);
    }

    /* One-shot, route termination signals through process.exit, with status
     * 128+signal: build steps run in their own process groups (Execute.ts) and
     * do not see the terminal's Ctrl-C, so the exit hooks (Execute's group
     * sweep, the run supervisor's cleanup) are what stop them, and a process
     * killed by a signal's default action runs none. (runWatched routes its
     * own.)
     *
     * While an interactive program (`fabr run`, `fabr shell`) runs, the signal
     * is offered to it first, and fabr waits for it to end the run. A second
     * signal is not offered, and exits. */
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      process.on(signal, () => {
        if (!signalInteractiveChild(signal)) {
          process.exit(code);
        }
      });
    }

    return fabr
      .evaluate(model => operation(model, execution, site))
      .then(takeover => {
        /* The evaluation has settled and its cycle closed: hand the process to
         * the takeover, if any, for its exit status. */
        return takeover ? takeover() : Computable.resolve(0);
      })
      .then(code =>
        /* Run the daily cache trim last, after a takeover's program has
         * exited; it skips itself when not due. */
        fabr.maybeCollectGarbage().then(() => flushAndExit(code))
      )
      .catch(err => {
        reportFailure(log, err);
        log.log(DIAG_FAILED, { work: failedWork(options.command) });
        flushAndExit(1);
      });
  } catch (err) {
    /* A failure setting up the run, before the evaluation (no project at or
     * above the cwd, an unusable cache directory): report it like any other. */
    reportFailure(log, toError(err));
    log.log(DIAG_FAILED, { work: failedWork(options.command) });
    flushAndExit(1);
  }
}

/** @return what a run of `command` that failed says failed: `Audit` for an audit, otherwise `Build`. */
function failedWork(command: string): string {
  return command === "audit" ? "Audit" : "Build";
}

/** @return true if runs of `command` render the per-cycle status marker
 * ("Built X" / "Already up to date"), otherwise false: build and test do, and
 * run only under watch. */
function showsMarkers(command: string, watch: boolean): boolean {
  if (command === "run") {
    return watch;
  }
  return command === "build" || command === "test";
}

/**
 * Run `operation` under watch: evaluate it, then report each time the
 * evaluation settles again after a change. A new failure is rendered and the
 * run keeps watching; "Watching for changes" is logged at the start, after each
 * new failure, and on recovering from one. SIGINT, SIGTERM and SIGHUP close the
 * watchers and exit (status 0, or 1 where teardown overruns
 * {@link SHUTDOWN_GRACE_MS}). The returned promise never resolves.
 */
function runWatched(operation: Operation, fabr: Fabr, site: IInvocationSite, log: Log): Promise<void> {
  const controller = fabr.controller!;
  const shutdown = (): void => {
    /* Exit 1 where teardown has not finished in time (a hung native
     * unsubscribe). Unref'd, so the deadline itself never holds the loop. */
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    /* Await teardown before exiting: unsubscribe stops a native watcher
     * thread, and exiting mid-flight crashes the kqueue backend (SIGABRT). The
     * explicit process.exit then runs the 'exit' hooks, a RunSupervisor's child
     * cleanup among them, which a signal's default action would skip. */
    void controller.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  /* Observe the evaluation's settling, not its value: a rebuild that comes to
   * the same value, or the same failure, notifies no `then`, but a handle's
   * onSettled fires once per applied batch. The execution observes it too (the
   * cycle-end and its marker); this handle renders the failure tree and the
   * watching announcements. */
  const outcome = fabr
    .evaluate(model => operation(model, fabr.execution, site))
    .then(
      () => undefined,
      (err: Error) => err
    );
  let lastFailure: Error | undefined;
  let announced = false;
  const observer = new ComputableHandle<Error | undefined>(source => {
    const result = source.value;
    const failed = result instanceof Error;
    if (failed) {
      /* Render only a NEW failure — never re-print an unchanged tree per cycle. */
      if (result !== lastFailure) {
        reportFailure(log, result);
        log.log(DIAG_FAILED, { work: "Build" });
        log.log(DIAG_WATCHING, {});
      }
    } else if (!announced || lastFailure !== undefined) {
      /* Announce once, and again on recovering from a failure. */
      log.log(DIAG_WATCHING, {});
    }
    announced = true;
    lastFailure = failed ? result : undefined;
  });
  observer.seat(outcome);
  return new Promise<void>(() => {});
}

/** Get the configuration for `operation`: the host's properties,
 *  `BUILD_OPERATION`, and the command line's properties, which take precedence. */
function configFor(model: BuildModel, options: Options, execution: ExecutionContext, operation: string): BuildContext {
  return model.getConfig(
    Constraints.of({ ...getHostProperties(), [BUILD_OPERATION]: operation, ...Object.fromEntries(options.properties) }),
    execution
  );
}

/** Apply `-f`'s force marks for `names` (see core's {@link forceTargets}). */
function markForced(model: BuildModel, options: Options, execution: ExecutionContext, names: string[]): void {
  if (options.force) {
    forceTargets(model, execution, names);
  }
}

/** Materialize each whole name given (a target and its projection) under the
 * `files` operation, each source opened out to its files ({@link openedOut}):
 * an `@npm:` reference gives the package's own files, without its
 * dependencies, and a declared target is built. Each is read as written on the
 * command line ({@link CommandLineSource}), so a bare path names files as it
 * would in a build file there. A namespace is refused. */
function resolveNames(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite
): Computable<SourceRef[]>[] {
  const config = configFor(model, options, execution, FILES_OPERATION);
  return options.targets.map(name =>
    config.materialize(options.commandLine.refFor(name, site)).then(sources => openedAll(refuseNamespaces(sources)))
  );
}

/** Open out each of `sources` (see {@link openedOut}). */
function openedAll(sources: SourceRef[]): Computable<SourceRef[]> {
  return Computable.forAll(sources.map(openedOut), (...opened: SourceRef[]) => opened);
}

/** Materialize what `ls` lists of each name, as {@link resolveNames} does: its
 * files, or the children of the one namespace it names (`@npm:glob`'s
 * versions). */
function listedNames(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite
): Computable<Map<string, Reference> | SourceRef[]>[] {
  const config = configFor(model, options, execution, FILES_OPERATION);
  return options.targets.map(name =>
    config.materialize(options.commandLine.refFor(name, site)).then((sources): Computable<Map<string, Reference> | SourceRef[]> => {
      const [only] = sources;
      return sources.length === 1 && isIncompleteRef(only) ? only.children() : openedAll(refuseNamespaces(sources));
    })
  );
}

/** The selector `**`, which {@link openedOut} asks a source for. */
const ALL_FILES = parseName("**");

/**
 * Open out one materialized source to its files, for the commands that want
 * files: a FileSet, or anything that is no FileSource, as it is; any other
 * FileSource (a `sync` release namespace, a `fetch` table) asked for all its
 * files, as `<name>/**` would. A FileSet is left as it is because a
 * RunnableFileSet reads a projection as selecting its entry.
 */
function openedOut(source: SourceRef): Computable<SourceRef> {
  if (source instanceof FileSet || !isFileSource(source)) {
    return Computable.resolve(source);
  }
  return source.find(ALL_FILES).then(files => files);
}

/**
 * Write the contents of each materialized name's files to stdout (`fabr cat`):
 * in argument order, then source order within a name, then file name order
 * within a source. A name matching no files is an error, raised before
 * anything is written.
 */
function catTarget(options: Options, results: SourceRef[][]): Computable<void> {
  /* Collect every name's files first, synchronously, so a name matching
   * nothing fails before anything is written. */
  const files: IFile[] = [];
  results.forEach((sources, i) => {
    const sets = sources.filter((source): source is FileSet => source instanceof FileSet);
    if (sets.every(set => set.isEmpty())) {
      throw matchedNoFiles(options.targets[i]);
    }
    for (const set of sets) {
      for (const [, file] of [...set].sort(([a], [b]) => a.localeCompare(b))) {
        files.push(file);
      }
    }
  });
  /* Write the files one at a time, reading the next only once the last is
   * flushed, so the set is never held in memory at once and a slow consumer
   * applies backpressure. */
  return mapComputable(files, file => file.getBuffer().then(buffer => writeStdout(Uint8Array.from(buffer))), 1).then(() => undefined);
}

/** Write `bytes` to stdout, resolving from the write callback so a slow (or
 * closing) consumer applies backpressure — the next read waits for this flush. */
function writeStdout(bytes: Uint8Array): Computable<void> {
  return Computable.from(resolve => {
    process.stdout.write(bytes, () => resolve(undefined));
  });
}

/**
 * Run `fabr cp <source…> <dest>`: copy the files of each source name,
 * materialized as `cat`'s are, into `dest`, a filesystem path resolved against
 * the cwd and created if absent. Each is named by `cp`'s rule for a file or a
 * directory ({@link remapCopyTargetName}): a name of a target, package or
 * directory copies into a subdirectory named after it (`fabr cp @scope/core
 * out` to `out/core/…`), a single file or a glob flat. Files already in `dest`
 * are left alone, and the copies are real copies, not links into the cache. A
 * source matching no files is an error, raised before anything is written.
 */
function copyTarget(options: Options, execution: ExecutionContext, results: SourceRef[][]): Computable<void> {
  const sets: FileSet[] = results.flatMap((sources, i) => {
    const name = options.targets[i];
    const fileSets = sources.filter((source): source is FileSet => source instanceof FileSet);
    if (fileSets.every(set => set.isEmpty())) {
      throw matchedNoFiles(name);
    }
    const rename = remapCopyTargetName(name, fileSets);
    return fileSets.map(set => set.rename(rename));
  });
  const merged = FileSet.unionAll(...sets);
  const dest = path.resolve(options.dest!);
  return writeFileSet(dest, merged, { copy: true }).then(() =>
    execution.log.log(DIAG_COPIED, { count: merged.size, dest: options.dest! })
  );
}

/**
 * Make the naming of one `cp` source's files under the destination, as
 * `cp -R` names what it copies: by the reference as written, never by the
 * package it resolves to (`@npm:esbuild:0.28.1` copies to `0.28.1/`).
 * - A name with a rename (`-> tmpl`) keeps the names the rename gave.
 * - A name ending in a glob (`pkg:build/*.js`) or a `/` copies flat: each file
 *   without the name's literal leading directories ({@link selectorBase}),
 *   keeping what the wildcards matched (`build/**` keeps the structure below
 *   `build/`).
 * - A name whose one file has the name's last component as its basename
 *   (`files:a.txt`) copies to that basename.
 * - Any other name copies under its last component (`cp -r dir out` to
 *   `out/dir/`), read without the `<k=v>` constraints
 *   (`mylib<BUILD_TYPE=release>` copies under `mylib`).
 *
 * Writing a path with `:` or `/` makes no difference to where its files land.
 */
function remapCopyTargetName(name: string, sets: FileSet[]): (fileName: string) => string {
  /* Drop the `<k=v>` constraints: only the name is inspected. */
  const parsed = parseName(name).withConstraints([]);
  /* A rename gave the files their names: keep them, without stripping the
   * selector's literal prefix. */
  if (parsed.getRenameTo() !== undefined) {
    return fileName => fileName;
  }
  const selector = parsed.toString();
  const leaf = selector.replace(/\/+$/, "").split(/[/:]/).filter(Boolean).pop() ?? "";
  const fileNames = sets.flatMap(set => [...set].map(([fileName]) => fileName));
  if (parsed.hasGlob() || selector.endsWith("/")) {
    const base = selectorBase(parsed, fileNames);
    return base === "" ? filename => filename : fileName => fileName.slice(base.length);
  }
  const isLoneFile = fileNames.length === 1 && fileNames[0].split("/").pop() === leaf;
  /* A named file lands under its basename, whether the directories it was
   * reached through were written with `:` or `/`. */
  return isLoneFile ? () => leaf : fileName => `${leaf}/${fileName}`;
}

/**
 * Get the directory prefix `cp` strips from a flat source's file names: the
 * longest trailing run of segments of the name's literal leading path
 * ({@link Name.getLiteralPathPrefix}, `:` and `/` alike) that every one of
 * `names` starts with, or `""` where there is none. So `pkg:build/*.js` (files
 * named `build/a.js`) and `pkg/build/*.js` (`pkg/build/a.js`) both strip to
 * `a.js`.
 */
function selectorBase(selector: Name, names: string[]): string {
  const dirs = selector.getLiteralPathPrefix().split(/[/:]/).filter(Boolean);
  /* Trailing runs, longest first — a repeated segment (`a/a/**`) must not match short. */
  const candidates = dirs.map((_, from) => `${dirs.slice(from).join("/")}/`);
  return candidates.find(base => names.every(name => name.startsWith(base))) ?? "";
}

/**
 * Make the error for a name whose projection matched no files, which `cat`,
 * `cp` and a `fabr run` whose entry missed all raise.
 */
function matchedNoFiles(name: string): Error {
  return new FabrError(`'${name}' matched no files`);
}

/**
 * Print the `fabr ls` listing to stdout: each name's files sorted by name, each
 * source apart, separated by a blank line, or the children of the namespace it
 * names; each under a `name:` header where more than one name was given.
 */
function listTargets(options: Options, results: Array<Map<string, Reference> | SourceRef[]>): Computable<void> {
  return Computable.forAll(
    results.map(sources =>
      sources instanceof Map
        ? Computable.resolve(renderChildren(sources))
        : Computable.forAll(
            sources
              .filter((source): source is FileSet => source instanceof FileSet)
              .map(set => renderListing(set, options.longListing)),
            (...perSource: string[][]) => perSource.flatMap((lines, i) => (i > 0 ? ["", ...lines] : lines))
          )
    ),
    (...listings: string[][]) => {
      listings.forEach((lines, i) => {
        if (listings.length > 1) {
          console.log(`${i > 0 ? "\n" : ""}${options.targets[i]}:`);
        }
        lines.forEach(line => console.log(line));
      });
    }
  );
}

/** Resolve `ref` under `config` to what it names, titled `title`, refusing a reference that selects files. */
function resolvedName(config: BuildContext, ref: INameValue, title: string): Computable<ResolvedName> {
  return config.resolve(ref).then(resolved => {
    requireWhole(ref, resolved.denoted);
    return { title, resolved };
  });
}

/**
 * Print the dependency tree of each name (`fabr deps`) to stdout: what a target
 * or a catalog requires, resolved and not built, or what any other name
 * resolves to. A target is resolved under the operation {@link resolvedNames}
 * chooses, unless the name requires another (`pkg<BUILD_OPERATION=test>`).
 */
function printDependencies(model: BuildModel, options: Options, execution: ExecutionContext, site: IInvocationSite): Computable<void> {
  return resolvedNames(model, options, execution, site)
    .then(names =>
      Computable.forAll(
        names.map(({ title, resolved }) => targetsReadWithin(resolved).then(read => sectionsOf(title, resolved, read))),
        (...blocks: DependencyTree[]) => blocks
      )
    )
    .then(blocks => {
      renderDependencyTrees(blocks, stdoutStyle()).forEach(line => console.log(line));
    });
}

/**
 * Resolve the names on the command line, as `fabr deps` and `fabr audit` read
 * them, each under the operation its name is asked under: a type with no build
 * rule and one operation of its own (a `js_script` runs, a `js_test` tests) is
 * asked under that one, anything else under `build`.
 */
function resolvedNames(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite
): Computable<ResolvedName[]> {
  const operationFor = (name: string): string => {
    const target = model.getReferencedTarget(name);
    const operations = target === undefined ? [] : model.getOperations(target.type);
    return operations.length === 1 && operations[0] !== "*" ? operations[0] : "build";
  };
  return Computable.forAll(
    options.targets.map(name =>
      resolvedName(configFor(model, options, execution, operationFor(name)), options.commandLine.refFor(name, site), name)
    ),
    (...names: ResolvedName[]) => names
  );
}

/** @return the painter for stdout: SGR codes on a terminal, like every other
 * colour decision here (NO_COLOR is any non-empty value), and none otherwise. */
function stdoutStyle(): ((code: string, text: string) => string) | undefined {
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  return color ? (code, text) => `\x1b[${code}m${text}\x1b[0m` : undefined;
}

/**
 * Write the bill of materials of the one name (`fabr sbom`) to stdout, as
 * CycloneDX (core's {@link sbom}): what `fabr deps` prints, resolved and not
 * built, with each registry package's licence and digests from its metadata.
 */
function writeSbom(model: BuildModel, options: Options, execution: ExecutionContext, site: IInvocationSite): Computable<void> {
  return resolvedNames(model, options, execution, site)
    .then(([name]) => sbom(name, { version: getVersion() }))
    .then(bom => {
      console.log(JSON.stringify(bom, undefined, 2));
    });
}

/** The property naming the OpenVEX documents whose statements suppress advisories in `fabr audit`. */
const ADVISORIES_SUPPRESSION_FILE = "ADVISORIES_SUPPRESSION_FILE";

/**
 * Read the statements of the OpenVEX documents `ADVISORIES_SUPPRESSION_FILE`
 * names, in the order it names them.
 */
function vexStatements(config: BuildContext, options: Options, site: IInvocationSite): Computable<VexStatement[]> {
  return config
    .materialize(options.commandLine.refFor(ADVISORIES_SUPPRESSION_FILE, site))
    .then(sources => openedAll(refuseNamespaces(sources)))
    .then(sources => {
      const files = sources.flatMap(source => (source instanceof FileSet ? [...source] : []));
      return Computable.forAll(
        files.map(([name, file]) => file.getBuffer().then(text => parseJson(text, name, toVexStatements(name)))),
        (...documents: VexStatement[][]) => documents.flat()
      );
    });
}

/**
 * Check the dependencies of each name (`fabr audit`) against the advisory
 * database `ADVISORIES_URL` names (core's {@link audit}): each registry package
 * `fabr deps` shows, resolved and not built, at its exact version. Resolves a
 * {@link Takeover}, run once the evaluation has settled, which queries the
 * database, writes the report to stdout (text, or SARIF with `--format
 * sarif`), warns of each declared fix that matches no advisory, and resolves
 * the exit status: 1 where any advisory affects a package, other than one a
 * patched target fixes or a statement of `ADVISORIES_SUPPRESSION_FILE`'s
 * documents suppresses, otherwise 0.
 */
function auditDependencies(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite
): Computable<Takeover> {
  const config = configFor(model, options, execution, "build");
  return Computable.forAll(
    [resolvedNames(model, options, execution, site), config.getProperty("ADVISORIES_URL"), vexStatements(config, options, site)],
    (names: ResolvedName[], advisories: Property, statements: VexStatement[]): Takeover =>
      () =>
        audit(names, osvServer(advisories.toString()), statements).then(report => {
          if (options.format === "sarif") {
            /* Locate a reference only where it was written in the project's
             * own tree, not in a plugin's file or on the command line. */
            const locate = (site: ISourceSpan): ISarifLocation | undefined =>
              site.fs === execution.sourceFileSource ? sarifLocation(site) : undefined;
            console.log(JSON.stringify(auditSarif(report, { version: getVersion() }, locate), undefined, 2));
          } else {
            renderAudit(report, stdoutStyle()).forEach(line => console.log(line));
          }
          report.unmatched.forEach(({ target, id, pkg }) =>
            pkg === undefined
              ? execution.log.log(DIAG_AUDIT_UNATTACHED_FIX, { target, id })
              : execution.log.log(DIAG_AUDIT_UNMATCHED_FIX, { target, id, pkg: `${pkg.packageName}@${pkg.version}` })
          );
          return affectsAny(report) ? 1 : 0;
        })
  );
}

/**
 * Print the declared targets (`fabr list-targets`) to stdout, by name, across
 * every namespace: each with its type and the operations its type has rules for
 * (so a rule guarded on a target's own properties counts for every target of
 * the type). Building nothing. Repositories are left out, and, without
 * `--all`, so are the targets core's and the plugins' files declare.
 *
 * A name given lists its target whatever `--all` says, and is an error where no
 * target has it (with a hint where it is private to a file); a glob lists the
 * targets it matches under the `--all` rule, and may match none.
 * `--operation` keeps the targets whose type has a rule for one of those
 * operations; `-l` adds where each is declared; `--json` writes `{ targets }`,
 * each with its `operations`, `origin` (`system` or `project`) and `location`.
 */
function listDeclaredTargets(model: BuildModel, options: Options, execution: ExecutionContext): Computable<void> {
  /* A system declaration is one read through absFileSource, from outside the
   * project tree: core's or a plugin's file. */
  const isSystem = (decl: ITargetDecl): boolean => decl.source.fs === execution.absFileSource;
  const named = new Set(options.targets.filter(name => !isGlob(name)));
  const patterns = options.targets.filter(isGlob).map(globMatcher);
  const listed = (name: string, decl: ITargetDecl): boolean =>
    named.has(name) || ((options.all || !isSystem(decl)) && (options.targets.length === 0 || patterns.some(matches => matches(name))));
  const wanted = options.operations;
  const targets = model
    .getTargets()
    .filter(({ name, decl }) => listed(name, decl))
    .map(({ name, decl }) => ({ name, decl, operations: model.getOperations(decl.type) }))
    .filter(({ operations }) => !wanted || operations.some(operation => wanted.includes(operation)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const missing = [...named].filter(name => !model.getTargets().some(target => target.name === name));
  if (missing.length > 0) {
    const hints = missing.flatMap(name => {
      const files = model.getPrivateFiles(name);
      return files.length === 0 ? [] : [`'${name}' is private to ${files.join(", ")}`];
    });
    const err = new FabrError(`No such target: ${missing.join(", ")}`);
    throw hints.length === 0 ? err : err.withHelp(hints);
  }
  if (options.json) {
    const json = targets.map(({ name, decl, operations }) => ({
      name,
      type: decl.type,
      operations,
      origin: isSystem(decl) ? "system" : "project",
      location: formatDeclLocation(decl),
    }));
    console.log(JSON.stringify({ targets: json }, undefined, 2));
    return Computable.resolve(undefined);
  }
  const nameWidth = Math.max(0, ...targets.map(target => target.name.length));
  const typeWidth = Math.max(0, ...targets.map(target => target.decl.type.length));
  /* In long mode a source location trails the operations, so pad that column
   * too for the locations to line up; without it the operations end the line. */
  const operationsOf = (operations: string[]): string => (operations.length > 0 ? `[${operations.join(", ")}]` : "");
  const operationsWidth = options.longListing ? Math.max(0, ...targets.map(target => operationsOf(target.operations).length)) : 0;
  for (const { name, decl, operations } of targets) {
    const location = options.longListing ? "  " + formatDeclLocation(decl) : "";
    const line = `${name.padEnd(nameWidth)}  ${decl.type.padEnd(typeWidth)}  ${operationsOf(operations).padEnd(
      operationsWidth
    )}${location}`;
    console.log(line.trimEnd());
  }
  return Computable.resolve(undefined);
}

/** @return a `file:line:column` reference to where a declaration was written. */
function formatDeclLocation(decl: ITargetDecl | ITargetDefDecl | IPropertyDecl): string {
  const span = declPosn(decl);
  const pos = span.reader.resolvePosition(span.offset);
  return pos ? `${span.file}:${pos.line}:${pos.column}` : span.file;
}

/**
 * Print the target types (`fabr list-targetdefs`) to stdout, in declaration
 * order: each with the operations its rules support and its properties (name,
 * type, whether REQUIRED, default). Building nothing. Names given select those
 * types, and one no type has is an error. `-l` adds where each type is
 * declared; `--json` writes the structured form, descriptions included
 * ({@link targetDefJson}).
 */
function listTargetDefs(model: BuildModel, options: Options): Computable<void> {
  const wanted = new Set(options.targets);
  /* Declaration order, as the lib files place them; list-all uses the same. */
  const defs = model.getTargetDefs().filter(def => wanted.size === 0 || wanted.has(def.name));
  /* A name no targetdef has is an error, naming each. */
  const missing = [...wanted].filter(name => !defs.some(def => def.name === name));
  if (missing.length > 0) {
    throw new FabrError(`No such target type: ${missing.join(", ")}`);
  }
  if (options.json) {
    console.log(JSON.stringify({ targetdefs: defs.map(def => targetDefJson(model, def)) }, undefined, 2));
    return Computable.resolve(undefined);
  }
  defs.forEach((def, i) => {
    if (i > 0) {
      console.log("");
    }
    const location = options.longListing ? "  " + formatDeclLocation(def) : "";
    console.log(renderTargetDefHeader(def, model.getOperations(def.name)) + location);
    const props = [...def.properties];
    const width = Math.max(0, ...props.map(([name]) => name.length));
    for (const [name, schema] of props) {
      const type = (schema.required ? "REQUIRED " : "") + propertyTypeName(schema);
      const fallback = schema.default ? ` default ${renderPropertyValue(schema.default)}` : "";
      console.log(`  ${name.padEnd(width)}  ${type}${fallback}`);
    }
  });
  return Computable.resolve(undefined);
}

/**
 * Print each operation a rule names (`fabr list-operations`) to stdout, in name
 * order, with the target types it has rules for. Building nothing. `--json`
 * writes `{ operations: [{ name, types }] }`.
 */
function listOperations(model: BuildModel, options: Options): Computable<void> {
  const types = new Map<string, string[]>();
  for (const def of model.getTargetDefs()) {
    for (const operation of model.getOperations(def.name).filter(operation => operation !== "*")) {
      types.set(operation, [...(types.get(operation) ?? []), def.name]);
    }
  }
  const operations = [...types.keys()].sort().map(name => ({ name, types: types.get(name)! }));
  if (options.json) {
    console.log(JSON.stringify({ operations }, undefined, 2));
    return Computable.resolve(undefined);
  }
  const width = Math.max(0, ...operations.map(({ name }) => name.length));
  for (const { name, types } of operations) {
    console.log(`${name.padEnd(width)}  ${types.join(", ")}`);
  }
  return Computable.resolve(undefined);
}

/**
 * Print the documented global properties (`fabr list-properties`: `BUILD_TYPE`,
 * `JS_TARGET`, …) with their values, then the `flag` targets (`ts/no_strict`,
 * …), to stdout. Building nothing. `-l` adds where each is declared; `--json`
 * writes `{ properties, flags }`, each with its location and description.
 */
function listProperties(model: BuildModel, options: Options): Computable<void> {
  const properties = configPropertiesJson(model);
  const flags = flagTargetsJson(model);
  if (options.json) {
    console.log(JSON.stringify({ properties, flags }, undefined, 2));
    return Computable.resolve(undefined);
  }
  const width = Math.max(0, ...properties.map(prop => prop.name.length));
  properties.forEach(prop => {
    const location = options.longListing ? "  " + prop.location : "";
    console.log(`${prop.name.padEnd(width)} = ${prop.value}${location}`);
  });
  if (flags.length > 0) {
    console.log("\nFlags:");
    flags.forEach(flag => console.log(`  ${flag.name}${options.longListing ? "  " + flag.location : ""}`));
  }
  return Computable.resolve(undefined);
}

/**
 * Write the whole vocabulary (`fabr list-all`) to stdout as one JSON document,
 * for tooling such as docs generation: `{ targetdefs, properties, flags,
 * targets }`, the last the documented declared targets
 * ({@link providedTargetsJson}).
 */
function listAll(model: BuildModel): Computable<void> {
  const defs = model.getTargetDefs(); /* declaration order — see listTargetDefs */
  console.log(
    JSON.stringify(
      {
        targetdefs: defs.map(def => targetDefJson(model, def)),
        properties: configPropertiesJson(model),
        flags: flagTargetsJson(model),
        targets: providedTargetsJson(model),
      },
      undefined,
      2
    )
  );
  return Computable.resolve(undefined);
}

/** @return the declared targets carrying a doc comment, other than flags (a
 * repository such as `@npm`, a driver tool), in declaration order, each with
 * its written properties, location and description. */
function providedTargetsJson(model: BuildModel): Record<string, unknown>[] {
  return model
    .getDeclaredTargets()
    .filter(({ decl }) => decl.type !== "flag" && decl.docComment !== undefined)
    .map(({ name, decl }) => ({
      name,
      type: decl.type,
      properties: decl.properties.map(item =>
        isPropertyDecl(item) ? { name: item.name.toBaseString(), value: renderPropertyValue(item) } : { splice: item.ref.toString() }
      ),
      location: formatDeclLocation(decl),
      ...contributionJson(model, decl),
      description: decl.docComment ?? null,
    }));
}

/** @return the full structured form of a targetdef for `--json` — its
 * operations, source location, description, and per-property schema with
 * descriptions (doc comments; null when a decl carries none). */
function targetDefJson(model: BuildModel, def: ITargetDefDecl): Record<string, unknown> {
  return {
    name: def.name,
    operations: model.getOperations(def.name),
    location: formatDeclLocation(def),
    ...contributionJson(model, def),
    description: def.docComment ?? null,
    properties: [...def.properties].map(([name, schema]) => ({
      name,
      type: propertyTypeName(schema),
      required: schema.required === true,
      default: schema.default ? renderPropertyValue(schema.default) : null,
      description: schema.docComment ?? null,
    })),
  };
}

/** One entry of the properties listing: a documented global property, or a
 * flag target. */
interface IConfigEntry extends IContribution {
  name: string;
  location: string;
  description: string | null;
}

/** Where a declaration comes from, in `--json`: the plugin whose files hold it
 * (absent for core's and the project's own), and for one of its optional libs,
 * the include that reads that lib. */
interface IContribution {
  plugin?: string;
  include?: string;
}

/** @return where `decl` comes from (see {@link IContribution}). */
function contributionJson(model: BuildModel, decl: ITargetDecl | ITargetDefDecl | IPropertyDecl): IContribution {
  const file = declPosn(decl).file;
  for (const plugin of model.getPlugins()) {
    if (plugin.files.includes(file)) {
      return { plugin: plugin.name };
    }
    const lib = plugin.optionalLibs.find(optional => optional.file === file);
    if (lib !== undefined) {
      return { plugin: plugin.name, include: `${plugin.name}:${lib.name}` };
    }
  }
  return {};
}

/** @return the documented global configuration properties (`BUILD_TYPE`,
 * `JS_TARGET`, `TYPESCRIPT`, …) — only those carrying a doc comment, each with its
 * default value, source location, and description — for docs generation. */
function configPropertiesJson(model: BuildModel): Array<IConfigEntry & { value: string }> {
  return model
    .getProperties()
    .filter(({ decl }) => decl.docComment !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, decl }) => ({
      name,
      value: renderPropertyValue(decl),
      location: formatDeclLocation(decl),
      ...contributionJson(model, decl),
      description: decl.docComment ?? null,
    }));
}

/** @return the `flag` targets (source-mode switches like `ts/no_strict`) with
 * their descriptions — the flags a user lists in a target's `deps`. */
function flagTargetsJson(model: BuildModel): IConfigEntry[] {
  return model
    .getTargets()
    .filter(({ decl }) => decl.type === "flag")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, decl }) => ({
      name,
      location: formatDeclLocation(decl),
      ...contributionJson(model, decl),
      description: decl.docComment ?? null,
    }));
}

/** @return a property's written value as a display string (its name-valued
 * words joined; non-scalar values omitted) — the default shown in the config
 * reference (`JS_TARGET` → `es6-esm`, `TARGET` → `${HOST}`). */
function renderPropertyValue(decl: IPropertyDecl): string {
  return decl.values
    .filter(isNameValue)
    .map(value => value.value.toString())
    .join(" ");
}

/** @return the header line for a targetdef: its name, and the operations it
 * supports in `[...]` (omitted when it has none — e.g. a repository type). */
function renderTargetDefHeader(def: ITargetDefDecl, operations: string[]): string {
  return operations.length > 0 ? `${def.name} [${operations.join(", ")}]` : def.name;
}

/**
 * @return the listing lines for a namespace's children: each name, in the order
 * listed, a child that is itself a namespace marked with a trailing `/`. `-l`
 * lists the same.
 */
function renderChildren(children: Map<string, Reference>): string[] {
  return [...children].map(([name, child]) => (isIncompleteRef(child) ? `${name}/` : name));
}

/**
 * @return the listing lines: names only, or `hash size name` for the long
 * form (hashes abbreviated, sizes right-aligned).
 */
function renderListing(files: FileSet, longListing: boolean): Computable<string[]> {
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  if (!longListing) {
    return Computable.resolve(entries.map(([name]) => name));
  }
  return mapComputable(entries, ([, file]) => file.getBuffer().then(buffer => buffer.byteLength)).then(sizes => {
    const width = sizes.reduce((widest, size) => Math.max(widest, String(size).length), 1);
    return entries.map(([name, file], i) => `${file.hash.substring(0, 12)} ${String(sizes[i]).padStart(width)} ${name}`);
  });
}

/**
 * Log the test summary of each name a run tested, from its report (whether
 * freshly run or cached), and return the failure of the names whose tests
 * failed, or undefined where none did: their summaries and failed tests, which
 * the failure is reported as. A run given `-t` marks each summary filtered, and
 * fails where its pattern ran no test in any of the targets.
 */
function reportTestResults(
  log: Log,
  names: string[],
  reports: (ITestReport | undefined)[],
  namePattern: string | undefined
): TestsFailedError | undefined {
  const filtered = namePattern === undefined ? "" : " (filtered)";
  const failures: string[] = [];
  let failed = 0;
  let tests = 0;
  reports.forEach((report, i) => {
    if (report !== undefined && report.results.summary.failed > 0) {
      /* The summary line, the failed tests, then the summary line again, so a long list ends with what it added up to. */
      const summary = `${names[i]}: ${formatTestSummary(report)}${filtered}`;
      failures.push(summary, ...formatTestFailures(report).split("\n").slice(1), summary);
      failed += report.results.summary.failed;
      tests += report.results.summary.tests;
    } else {
      log.log(DIAG_TEST_RESULT, { name: names[i], summary: (report ? formatTestSummary(report) : "no tests") + filtered });
    }
  });
  const ran = reports.reduce(
    (count, report) => count + (report ? report.results.summary.passed + report.results.summary.failed : 0),
    0
  );
  if (namePattern !== undefined && ran === 0) {
    throw new FabrError(`No test's name matches the pattern '${namePattern}'`);
  }
  return failures.length === 0 ? undefined : new TestsFailedError(failures.join("\n"), failed, tests);
}
