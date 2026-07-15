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
  FILES_OPERATION,
  BuildCache,
  BuildContext,
  BuildModel,
  Computable,
  Diagnostic,
  ExecutionContext,
  FileSet,
  formatTestSummary,
  IFile,
  getSourceFileSource,
  getTestReport,
  loadProject,
  Log,
  LogFormatter,
  LogLevel,
  ProgressListener,
  RunnableFileSet,
  SourceRef,
  toError,
  WatchController,
} from "@fabr-build/core";
import { DiagnosticErrorFormatter, ErrorFormatter } from "./ErrorFormatter";
import { runInteractive, RunSupervisor } from "./RunHandler";
/* The whole of @fabr-build/core doubles as the api object injected into plugins:
 * handing plugins the host's own module instance keeps every class and
 * registry shared (a plugin must never load a second copy of the core). */
import * as pluginApi from "@fabr-build/core";
import { Mode, Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, getHostProperties, PROJECT_FILENAME } from "./Environment";

const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ targets: string }>("Built {targets}");
const DIAG_UP_TO_DATE = Diagnostic.Info<Record<string, never>>("Already up to date");
const DIAG_BUILD_FAILED = Diagnostic.Error<Record<string, never>>("Build failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");
const DIAG_BUILDING = Diagnostic.Info<{ verb: string; name: string; chain: string }>("{verb} {name}{chain}");
const DIAG_WATCHING = Diagnostic.Info<Record<string, never>>("Watching for changes (Ctrl-C to stop)");
const DIAG_WATCH_WARNING = Diagnostic.Warn<{ message: string }>("{message}");
const DIAG_RESOLVING = Diagnostic.Info<{ requirements: string; name: string }>("Resolving {requirements} from {name}");
const DIAG_FETCHING = Diagnostic.Info<{ resource: string; url: string }>("Fetching {resource}{url}");

/** Progress verbs for the well-known operations; anything else renders as
 * "Running <operation> on <target>" */
const OPERATION_VERBS: Record<string, string> = { build: "Building", test: "Testing", run: "Running" };

/** Constraint keys the driver injects as ambient context, elided from progress
 * output: the host facts, and BUILD_OPERATION (already shown as the verb). */
const AMBIENT_CONSTRAINT_KEYS = new Set([BUILD_OPERATION, ...Object.keys(getHostProperties())]);

/**
 * @return a ` [k=v, ...]` annotation of the explicit constraints a target is
 * building under (the ambient keys elided), or "" when there are none — so a
 * default build reads exactly as before.
 */
function renderConstraints(constraints: Record<string, string>): string {
  const shown = Object.entries(constraints).filter(([key]) => !AMBIENT_CONSTRAINT_KEYS.has(key));
  return shown.length > 0 ? ` [${shown.map(([key, value]) => key + "=" + value).join(", ")}]` : "";
}

/** Quiet-window (ms) a burst of filesystem events is collapsed behind before a
 * rebuild — long enough to coalesce an editor's save, short enough to feel live. */
const WATCH_QUIET_MS = 100;

/** The presentation of build failures — swappable; see ErrorFormatter. */
const errorFormatter: ErrorFormatter = new DiagnosticErrorFormatter(AMBIENT_CONSTRAINT_KEYS);

function reportFailure(log: Log, err: Error): void {
  errorFormatter.report(log, err);
}

/**
 * Exit with `code`, but only after stdout/stderr have drained. `process.exit()`
 * on its own discards whatever is still buffered in those streams when they are
 * pipes rather than TTYs — truncating a piped `fabr cat`. A trailing zero-length
 * write's callback fires once everything queued ahead of it has flushed, so we
 * exit from there.
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
  /* Watch is meaningful for the build-graph verbs and for `run` (relaunch the
   * program on change — a dev server over built artifacts); ls/cat are one-shot
   * queries. */
  const watch =
    options.mode === Mode.Watch &&
    (options.command === "build" || options.command === "test" || options.command === "run");
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
        /* Reporting lives in the forAll callback (not a trailing .then) so it
         * re-runs on every watch cycle: the callback is re-invoked whenever a
         * target re-settles to a new value, whereas a `.then` on the void result
         * would be short-circuited by the value-equality cutoff. */
        return Computable.forAll(targets, (...results) =>
          reportTestResults(execution.log, options, results).then(() => buildStatus(execution))
        );
      }, watch);
    case "run":
      return runWith((model, execution) => runProgram(model, options, execution, watch), watch);
    default: /* build */
      return runWith((model, execution) => {
        const targets = buildTargets(model, options, execution, "build");
        /* Report inside the callback (see the test case) so a watch rebuild
         * re-prints its status rather than being cut off at the void result. */
        return Computable.forAll(targets, () => buildStatus(execution));
      }, watch);
  }
}

/**
 * `fabr run <target> [args…]`: build the target under `run` to get its runnable,
 * then launch it. One-shot mode stages + runs interactively and exits with the
 * program's own code. Watch mode instead hands each (re)settled runnable to a
 * persistent {@link RunSupervisor} that relaunches the program when the built
 * install changes; the re-settle happens inside this `.then`, which the value
 * cutoff re-fires per change (whereas the surrounding void result does not).
 */
function runProgram(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  watch: boolean
): Computable<void> {
  const config = model.getConfig({ ...getHostProperties(), [BUILD_OPERATION]: "run", ...options.properties }, execution);
  const supervisor = watch ? new RunSupervisor(options.targets[0], options.runArgs ?? [], execution.log) : undefined;
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
    if (supervisor) {
      supervisor.update(runnable);
      return;
    }
    return runInteractive(runnable, options.runArgs ?? []).then(code => flushAndExit(code));
  });
}

/**
 * The driver lifecycle harness: establish the run's surroundings (stderr log,
 * cache, source tree, progress-reporting ExecutionContext), load the project,
 * then hand the model to `operation` — exiting 0 on success and rendering the
 * failure tree (exit 1) on error. Reaching a drained event loop without an
 * explicit exit is a stall bug, reported loudly (exit 2).
 */
async function runWith(operation: Operation, watch = false): Promise<void> {
  /* Diagnostics and progress go to stderr; command data (ls listings, cat
   * file contents) goes to stdout, so a build can be filtered from its output.
   * Color is a render-time decision only (NO_COLOR is any non-empty value):
   * captured tool output arrives colored regardless and is stripped when off. */
  const color = process.stderr.isTTY === true && !process.env.NO_COLOR;
  const log = new LogFormatter(LogLevel.Info, line => process.stderr.write(line + "\n"), color);

  /* In watch mode a drained event loop is the normal idle state (the watchers
   * keep the process alive), so the stall guard would misfire. */
  if (!watch) {
    process.on("beforeExit", () => {
      log.log(DIAG_ERROR, { message: "Internal error: the build stalled without completing" });
      process.exit(2);
    });
  }

  try {
    const sourceRoot = await getSourceRoot();
    const buildCache = new BuildCache(getBuildCacheRoot());
    const execution = new ExecutionContext(buildCache, log);
    execution.onProgress(progressListener(log));

    /* Watching is fixed at the source's construction (not toggled later), so build
     * the controller first. The build cache doubles as the content-addressed blob
     * store the source snapshots into, so it too precedes the source file source. */
    const controller = watch
      ? new WatchController(
          WATCH_QUIET_MS,
          undefined,
          err => reportFailure(log, err),
          () => execution.beginBuildCycle(),
          message => log.log(DIAG_WATCH_WARNING, { message })
        )
      : undefined;
    const sourceFileSource = getSourceFileSource(sourceRoot, buildCache, controller);

    if (controller) {
      return runWatched(operation, sourceFileSource, execution, log, controller);
    }

    /* The system include path defaults to the directories the loaded rule
     * packages registered (core + js via their imports; plugins later) */
    return loadProject(sourceFileSource, PROJECT_FILENAME, log, pluginApi)
      .then(model => operation(model, execution))
      .then(() => flushAndExit(0))
      .catch(err => {
        reportFailure(log, err);
        log.log(DIAG_BUILD_FAILED, {});
        flushAndExit(1);
      });
  } catch (err) {
    /* A failure while *setting up* the run — before the build graph exists (no
     * project at/above cwd, an unusable cache dir) — is outside the loadProject
     * chain's own `.catch`, so it would otherwise escape as a raw unhandled
     * rejection. Report it like any other failure and exit. */
    reportFailure(log, toError(err));
    log.log(DIAG_BUILD_FAILED, {});
    flushAndExit(1);
  }
}

/**
 * The watch lifecycle: put the source tree into watch mode, run the operation
 * once to establish the live graph, then keep re-reporting as the operation's
 * Computable re-settles on each (debounced) change. Unlike the one-shot path it
 * never exits on completion — a failed build reports and keeps watching, a
 * subsequent fix re-settles the graph to green — and it tears the watchers down
 * on SIGINT. The returned promise deliberately never resolves; the process is
 * kept alive by the persistent watchers and ends only via the signal handler.
 */
function runWatched(
  operation: Operation,
  sourceFileSource: ReturnType<typeof getSourceFileSource>,
  execution: ExecutionContext,
  log: Log,
  controller: WatchController
): Promise<void> {
  const shutdown = (): void => {
    /* Await teardown before exiting: unsubscribe stops a native watcher thread,
     * and exiting mid-flight crashes the kqueue backend (SIGABRT). The explicit
     * process.exit then fires the 'exit' hooks — including a RunSupervisor's
     * synchronous child cleanup — which a *default* SIGTERM disposition would
     * skip entirely, orphaning the launched program and leaking its staged dir. */
    void controller.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  /* This observer re-fires every time the operation's Computable re-settles (the
   * revalidation cascade after a change), so status/failure render per cycle. */
  loadProject(sourceFileSource, PROJECT_FILENAME, log, pluginApi)
    .then(model => operation(model, execution))
    .then(
      () => log.log(DIAG_WATCHING, {}),
      err => {
        reportFailure(log, err);
        log.log(DIAG_BUILD_FAILED, {});
        log.log(DIAG_WATCHING, {});
      }
    );
  return new Promise<void>(() => {});
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

/** Resolve each whole name (target + projection) under the `files` operation:
 * ls/cat only ever want the resolved files, so this lets the leaves do less —
 * an `@npm:` reference delivers a package's own files with no dependency
 * closure — while a declared target still builds (files falls back to build). */
function resolveNames(model: BuildModel, options: Options, execution: ExecutionContext): Computable<SourceRef[]>[] {
  const config = configFor(model, options, execution, FILES_OPERATION);
  return options.targets.map(name => config.resolveName(name));
}

/** Print the terminal build-status line: nothing built (this cycle), or a count.
 * Uses the per-cycle delta so a watch rebuild reports only what it rebuilt. */
function buildStatus(execution: ExecutionContext): void {
  /* Report which declared targets actually rebuilt this cycle (the per-target
   * "Building X" lines already scrolled past during the build; this is the
   * completion marker — useful especially in watch mode). Nothing built ⇒ the
   * run was a no-op. */
  const built = execution.takeBuiltTargets();
  if (built.length === 0) {
    execution.log.log(DIAG_UP_TO_DATE, {});
  } else {
    execution.log.log(DIAG_BUILD_COMPLETE, { targets: built.join(", ") });
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
        /* A sub-target carries its action verb as `label` ("Compiling"); a
         * declared target derives its verb from the operation ("Building"). */
        const verb = event.label ?? OPERATION_VERBS[event.operation] ?? `Running ${event.operation} on`;
        const requiredBy =
          event.requiredBy.length > 0 ? ` (required by ${event.requiredBy.map(decl => decl.name).join(" < ")})` : "";
        /* Surface the explicit constraints (a reference `<BUILD_TYPE=release>`
         * delta or a -D override), eliding the ambient keys the driver injected
         * (host facts, and BUILD_OPERATION — already the verb). */
        log.log(DIAG_BUILDING, { verb, name: event.target.name, chain: renderConstraints(event.constraints) + requiredBy });
        break;
      }
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
  /* Resolve every name to its files up front — synchronously, so a name matching
   * nothing fails before a single byte is written (no partial output). The order
   * is fixed here: argument order across names, sorted by filename within each. */
  const files: IFile[] = [];
  results.forEach((sources, i) => {
    const set = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
    if (set.isEmpty()) {
      throw matchedNoFiles(options.targets[i]);
    }
    files.push(...[...set].sort(([a], [b]) => a.localeCompare(b)).map(([, file]) => file));
  });
  /* Stream each file's contents to stdout in that order, one at a time — reading
   * the next only after the previous is written, so the whole set is never held
   * in memory at once (`cat` may dump large artifacts). */
  return files.reduce<Computable<void>>(
    (prev, file) => prev.then(() => file.getBuffer()).then(buffer => void process.stdout.write(Uint8Array.from(buffer))),
    Computable.resolve(undefined)
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
