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
  BuildCache,
  BuildContext,
  BuildModel,
  Computable,
  declPosn,
  DependencyFailedError,
  Diagnostic,
  ExecutionContext,
  ExecutionError,
  FileConflictError,
  FileSet,
  formatTestSummary,
  getSourceFileSource,
  getTestReport,
  ISourcePosition,
  loadProject,
  Log,
  LogFormatter,
  LogLevel,
  MultiError,
  ProgressListener,
  renderProvenance,
  RunnableFileSet,
  SourceRef,
  TestsFailedError,
} from "@fabr/core";
import { runInteractive } from "./RunHandler";
/* The whole of @fabr/core doubles as the api object injected into plugins:
 * handing plugins the host's own module instance keeps every class and
 * registry shared (a plugin must never load a second copy of the core). */
import * as pluginApi from "@fabr/core";
import { Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, getHostProperties, PROJECT_FILENAME, SOURCE_CACHE_FILENAME } from "./Environment";

const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ count: number }>("Built {count} target(s)");
const DIAG_UP_TO_DATE = Diagnostic.Info<Record<string, never>>("Already up to date");
const DIAG_BUILD_FAILED = Diagnostic.Error<Record<string, never>>("Build failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TARGET_FAILED = Diagnostic.Error<{ name: string; message: string; loc: ISourcePosition }>(
  "Failed to build {name}: {message}"
);
/* An anonymous sub-target's failure, rendered against its declared target with
 * its action-verb label ("Compiling @fabr/core failed"); the detail (the
 * command and its output) follows the source excerpt, so it leads with a
 * newline. */
const DIAG_SUBTARGET_FAILED = Diagnostic.Error<{ verb: string; name: string; message: string; loc: ISourcePosition }>(
  "{verb} {name} failed:\n{message}"
);
const DIAG_DEPENDENCY_FAILED = Diagnostic.Error<{ name: string; dependency: string; loc: ISourcePosition }>(
  "Cannot build {name}: dependency '{dependency}' failed"
);
const DIAG_TESTS_FAILED = Diagnostic.Error<{ name: string; message: string; loc: ISourcePosition }>("{name}: {message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");
const DIAG_BUILDING = Diagnostic.Info<{ verb: string; name: string; chain: string }>("{verb} {name}{chain}");
const DIAG_RESOLVING = Diagnostic.Info<{ requirements: string; name: string }>("Resolving {requirements} from {name}");
const DIAG_FETCHING = Diagnostic.Info<{ resource: string; url: string }>("Fetching {resource}{url}");

/** Progress verbs for the well-known operations; anything else renders as
 * "Running <operation> on <target>" */
const OPERATION_VERBS: Record<string, string> = { build: "Building", test: "Testing", run: "Running" };

/**
 * Render a build failure tree: each failed target is reported once, against its
 * own declaration; targets that failed only because a dependency failed get a
 * terse one-liner rather than a repeat of the root cause.
 */
function reportFailure(log: Log, err: Error, reported: Set<Error>): void {
  if (reported.has(err)) {
    return;
  }
  reported.add(err);
  if (err instanceof MultiError) {
    err.errors.forEach(cause => reportFailure(log, cause, reported));
  } else if (err instanceof DependencyFailedError) {
    const causes = err.cause instanceof MultiError ? err.cause.errors : [err.cause];
    const execution: Error[] = [];
    for (const cause of causes) {
      if (cause instanceof DependencyFailedError) {
        /* An anonymous sub-target (label set) is an implementation detail of
         * its declared target: skip the "dependency failed" hop and let its
         * own report ("Compiling X failed") stand for it. */
        if (!cause.label) {
          log.log(DIAG_DEPENDENCY_FAILED, { name: err.target.name, dependency: cause.target.name, loc: declPosn(err.target) });
        }
        reportFailure(log, cause, reported);
      } else if (cause instanceof TestsFailedError) {
        /* Tests failed: the target built fine, so report the (pre-rendered)
         * test summary rather than a build failure */
        log.log(DIAG_TESTS_FAILED, { name: err.target.name, message: cause.message, loc: declPosn(err.target) });
      } else if (cause instanceof ExecutionError) {
        execution.push(cause);
      } else {
        /* Semantic diagnostics (conflicts, resolution failures, ...) each get
         * their own report, with any provenance detail attached */
        const message =
          cause instanceof FileConflictError ? `${cause.message}\n${renderConflictDetail(cause)}` : cause.message;
        log.log(DIAG_TARGET_FAILED, { name: err.target.name, message, loc: declPosn(err.target) });
      }
    }
    if (execution.length > 0) {
      /* Mechanical failures of the target's execution, reported once. An
       * anonymous sub-target (label set) reports against its declared target
       * with its verb ("Compiling X failed"); a declared target as "Failed to
       * build X". Either way `target` is the declared decl. */
      const message = describeCauses(execution);
      if (err.label) {
        log.log(DIAG_SUBTARGET_FAILED, { verb: err.label, name: err.target.name, message, loc: declPosn(err.target) });
      } else {
        log.log(DIAG_TARGET_FAILED, { name: err.target.name, message, loc: declPosn(err.target) });
      }
    }
  } else {
    log.log(DIAG_ERROR, { message: err.message });
  }
}

/**
 * Format the execution errors of a target as a single message: one error
 * inline, several as an indented list.
 */
function describeCauses(causes: Error[]): string {
  if (causes.length === 1) {
    return causes[0].message;
  }
  return `${causes.length} errors:\n` + causes.map(cause => "  " + cause.message.split("\n").join("\n  ")).join("\n");
}

/**
 * Expand both sides of a file conflict into an indented explanation, by
 * rendering each side's provenance chain (model references, target
 * evaluations, repository resolutions, ...).
 */
function renderConflictDetail(err: FileConflictError): string {
  const lines: string[] = [];
  for (const side of [err.left, err.right]) {
    const provenance = renderProvenance(side.provenance, { path: err.path });
    if (provenance.length > 0) {
      /* The chain's first line is its own position-prefixed header */
      lines.push("  " + provenance[0]);
      provenance.slice(1).forEach(line => lines.push("    " + line));
    } else {
      lines.push(`  from '${side.label}' (no origin information)`);
    }
    /* The concrete file, so identical-provenance conflicts stay diagnosable */
    lines.push(`    at ${side.file.getDisplayName()}`);
  }
  return lines.join("\n");
}

/** What to do with the loaded model — the per-command work, run inside the
 * harness's lifecycle. The run's surroundings (log, cache, progress) ride on
 * `execution`; the command (and so `options`) is closed over by the caller. */
export type Operation = (model: BuildModel, execution: ExecutionContext) => Computable<void>;

/**
 * The CLI entry: dispatch the command to a tiny operation (each closing over
 * `options`) and run it in the harness. The `BUILD_OPERATION` constraint is the
 * command itself (explicit `-DBUILD_OPERATION=...` takes precedence); `ls`/`cat`
 * are driver verbs, not operations — they build under `build` and resolve the
 * whole name (target + `:`/glob projection) through the model, while the build
 * verbs take a bare target name.
 */
export function runFabr(options: Options): Promise<void> {
  switch (options.command) {
    case "ls":
      return runWith((model, execution) =>
        Computable.forAll(resolveNames(model, options, execution), (...results) => listTargets(options, results))
      );
    case "cat":
      return runWith((model, execution) =>
        Computable.forAll(resolveNames(model, options, execution), (...results) => catTarget(options, results))
      );
    case "test":
      return runWith((model, execution) => {
        const targets = buildTargets(model, options, execution, "test");
        return Computable.forAll(targets, (...results) => reportTestResults(execution.log, options, results)).then(() =>
          buildStatus(execution, targets.length)
        );
      });
    case "run":
      return runWith((model, execution) => runProgram(model, options, execution));
    default: /* build */
      return runWith((model, execution) => {
        const targets = buildTargets(model, options, execution, "build");
        return Computable.forAll(targets, () => {}).then(() => buildStatus(execution, targets.length));
      });
  }
}

/**
 * `fabr run <target> [args…]`: build the target under `run` to get its runnable,
 * then hand it to `runInteractive` (staging + inherited-stdio launch). Exits with
 * the program's own exit code.
 */
function runProgram(model: BuildModel, options: Options, execution: ExecutionContext): Computable<void> {
  const config = model.getConfig({ ...getHostProperties(), [BUILD_OPERATION]: "run", ...options.properties }, execution);
  return config.resolveName(options.targets[0]).then(sources => {
    const runnable = sources.find((s): s is RunnableFileSet => s instanceof RunnableFileSet);
    if (!runnable) {
      /* No runnable: a projection that matched nothing (empty) is the shared
       * "matched no files" error — same as cat/ls; genuine content that just
       * isn't runnable is the distinct case. */
      const files = FileSet.unionAll(...sources.filter((s): s is FileSet => s instanceof FileSet));
      throw files.isEmpty()
        ? matchedNoFiles(options.targets[0])
        : new Error(`'${options.targets[0]}' is not runnable (it has no BUILD_OPERATION=run result)`);
    }
    return runInteractive(runnable, options.runArgs ?? []).then(code => process.exit(code));
  });
}

/**
 * The driver lifecycle harness: establish the run's surroundings (stderr log,
 * cache, source tree, progress-reporting ExecutionContext), load the project,
 * then hand the model to `operation` — exiting 0 on success and rendering the
 * failure tree (exit 1) on error. Reaching a drained event loop without an
 * explicit exit is a stall bug, reported loudly (exit 2).
 */
async function runWith(operation: Operation): Promise<void> {
  /* Diagnostics and progress go to stderr; command data (ls listings, cat
   * file contents) goes to stdout, so a build can be filtered from its output. */
  const log = new LogFormatter(LogLevel.Info, line => process.stderr.write(line + "\n"));

  process.on("beforeExit", () => {
    log.log(DIAG_ERROR, { message: "Internal error: the build stalled without completing" });
    process.exit(2);
  });

  const sourceRoot = await getSourceRoot();
  const buildCache = new BuildCache(getBuildCacheRoot());
  const sourceFileSource = await getSourceFileSource(sourceRoot, SOURCE_CACHE_FILENAME);
  const execution = new ExecutionContext(buildCache, log);
  execution.onProgress(progressListener(log));

  /* The system include path defaults to the directories the loaded rule
   * packages registered (core + js via their imports; plugins later) */
  return loadProject(sourceFileSource, PROJECT_FILENAME, log, pluginApi)
    .then(model => operation(model, execution))
    .then(() => process.exit(0))
    .catch(err => {
      reportFailure(log, err, new Set());
      log.log(DIAG_BUILD_FAILED, {});
      process.exit(1);
    });
}

function configFor(model: BuildModel, options: Options, execution: ExecutionContext, operation: string): BuildContext {
  return model.getConfig({ ...getHostProperties(), [BUILD_OPERATION]: operation, ...options.properties }, execution);
}

/** Build each named target under the given operation (bare target names). */
function buildTargets(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  operation: string
): Computable<SourceRef[]>[] {
  const config = configFor(model, options, execution, operation);
  return options.targets.map(name => config.getTarget(name));
}

/** Resolve each whole name (target + projection) under the build operation. */
function resolveNames(model: BuildModel, options: Options, execution: ExecutionContext): Computable<SourceRef[]>[] {
  const config = configFor(model, options, execution, "build");
  return options.targets.map(name => config.resolveName(name));
}

/** Print the terminal build-status line: nothing built, or a count. */
function buildStatus(execution: ExecutionContext, count: number): void {
  if (execution.buildCache.getBuildCount() === 0) {
    execution.log.log(DIAG_UP_TO_DATE, {});
  } else {
    execution.log.log(DIAG_BUILD_COMPLETE, { count });
  }
}

/**
 * Render ExecutionContext progress events as diagnostics: a target is announced
 * when (and only when) it actually starts building (its first build-cache
 * miss), attributed with the chain of targets that required it.
 */
function progressListener(log: Log): ProgressListener {
  return event => {
    switch (event.kind) {
      case "target-build": {
        const verb = OPERATION_VERBS[event.operation] ?? `Running ${event.operation} on`;
        const chain = event.requiredBy.length > 0 ? ` (required by ${event.requiredBy.map(decl => decl.name).join(" < ")})` : "";
        log.log(DIAG_BUILDING, { verb, name: event.target.name, chain });
        break;
      }
      case "sub-target-build":
        log.log(DIAG_BUILDING, { verb: event.label, name: event.declared.name, chain: "" });
        break;
      case "repository-resolve":
        log.log(DIAG_RESOLVING, { requirements: event.requirements.join(", "), name: event.repository.name });
        break;
      case "fetch":
        log.log(DIAG_FETCHING, { resource: event.resource ? `${event.resource} ` : "", url: event.url });
        break;
    }
  };
}

/**
 * For `fabr cat`, the outcome is the raw contents of each resolved name's files
 * on stdout — the name (`pkg:build/*.js`) has already been resolved through the
 * model, so its projection/glob is applied; a name that matches nothing is an
 * error. Content is data, so it goes straight to stdout.
 */
function catTarget(options: Options, results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map((sources, i) => {
      const files = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
      if (files.isEmpty()) {
        throw matchedNoFiles(options.targets[i]);
      }
      return dumpFiles(files);
    }),
    () => {}
  );
}

/**
 * The shared "you named something that resolves to nothing" error — a reference
 * whose projection/glob matched no files. Raised uniformly for `cat`, `ls`, and
 * a `fabr run` whose entry projection missed, so a missing file reports the same
 * way however it was named.
 */
function matchedNoFiles(name: string): Error {
  return new Error(`'${name}' matched no files`);
}

/** Write every file in the set (sorted by name) to stdout, contents only. */
function dumpFiles(files: FileSet): Computable<void> {
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  return Computable.forAll(
    entries.map(([, file]) => file.getBuffer()),
    (...buffers) => {
      buffers.forEach(buffer => process.stdout.write(Uint8Array.from(buffer)));
    }
  );
}

/**
 * For `fabr ls`, the listing is the outcome: print each built target's
 * contents (sorted by name), with a `target:` header when more than one
 * target was requested. A target is by definition a built thing, so its
 * results are FileSets already — union and enumerate them directly. Listing
 * output is the command's data, so it goes straight to stdout rather than
 * through the diagnostic log.
 */
function listTargets(options: Options, results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map(sources =>
      renderListing(
        FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet)),
        options.longListing
      )
    ),
    (...listings) => {
      listings.forEach((lines, i) => {
        if (listings.length > 1) {
          console.log(`${i > 0 ? "\n" : ""}${options.targets[i]}:`);
        }
        lines.forEach(line => console.log(line));
      });
    }
  );
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
  return Computable.forAll(
    entries.map(([, file]) => file.getBuffer()),
    (...buffers) => {
      const width = Math.max(1, ...buffers.map(buffer => String(buffer.byteLength).length));
      return entries.map(
        ([name, file], i) => `${file.hash.substring(0, 12)} ${String(buffers[i].byteLength).padStart(width)} ${name}`
      );
    }
  );
}

/**
 * For a test run, the interesting outcome is the tests, not the build: report
 * each target's result summary from its test report artifact (whether freshly
 * run or cached-green).
 */
function reportTestResults(log: Log, options: Options, results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map(sources => getTestReport(sources)),
    (...reports) => {
      reports.forEach((report, i) => {
        log.log(DIAG_TEST_RESULT, { name: options.targets[i], summary: report ? formatTestSummary(report) : "no tests" });
      });
    }
  );
}
