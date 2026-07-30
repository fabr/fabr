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
  declPosn,
  Diagnostic,
  ExecutionContext,
  FileSet,
  formatTestSummary,
  IFile,
  BuildCycle,
  getSourceFileSource,
  getTestReport,
  loadProject,
  Name,
  parseName,
  Log,
  LogFormatter,
  LogLevel,
  IPropertyDecl,
  IPropertySchema,
  isNameValue,
  ITargetDecl,
  ITargetDefDecl,
  ProgressListener,
  PropertyType,
  PublishableFileSet,
  RunnableFileSet,
  signalInteractiveChild,
  SourceRef,
  toError,
  WatchController,
  FSFileSource,
  writeFileSet,
  Constraints,
} from "@fabr-build/core";
import { DiagnosticErrorFormatter, ErrorFormatter } from "./ErrorFormatter";
import { runInteractive, RunSupervisor } from "./RunHandler";
import { shellInto } from "./ShellHandler";
import { publishSync } from "./SyncHandler";
import { Mode, Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, getHostProperties, PROJECT_FILENAME } from "./Environment";
import * as path from "node:path";

const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ targets: string }>("Built {targets}");
const DIAG_UP_TO_DATE = Diagnostic.Info<Record<string, never>>("Already up to date");
const DIAG_BUILD_FAILED = Diagnostic.Error<Record<string, never>>("Build failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");
const DIAG_BUILDING = Diagnostic.Info<{ verb: string; name: string; chain: string }>("{verb} {name}{chain}");
const DIAG_WATCHING = Diagnostic.Info<Record<string, never>>("Watching for changes (Ctrl-C to stop)");
const DIAG_WATCH_WARNING = Diagnostic.Warn<{ message: string }>("{message}");
const DIAG_UNHANDLED = Diagnostic.Warn<{ message: string }>("Unhandled error: {message}");
const DIAG_RESOLVING = Diagnostic.Info<{ requirements: string; name: string }>("Resolving {requirements} from {name}");
const DIAG_FETCHING = Diagnostic.Info<{ resource: string; url: string }>("Fetching {resource}{url}");
const DIAG_COPIED = Diagnostic.Info<{ count: number; dest: string }>("Copied {count} file(s) to {dest}");

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
function renderConstraints(constraints: Constraints): string {
  const shown = [...constraints].filter(([key]) => !AMBIENT_CONSTRAINT_KEYS.has(key));
  return shown.length > 0 ? ` [${shown.map(([key, value]) => key + "=" + value).join(", ")}]` : "";
}

/** Quiet-window (ms) a burst of filesystem events is collapsed behind before a
 * rebuild — long enough to coalesce an editor's save, short enough to feel live. */
const WATCH_QUIET_MS = 100;

/** How long a signalled watch process's teardown may take before the shutdown
 * deadline force-exits — generous for a native watcher unsubscribe, short
 * enough that a stuck teardown can't hang a test runner or CI. */
const SHUTDOWN_GRACE_MS = 5000;

/** The presentation of build failures — swappable; see ErrorFormatter. */
const errorFormatter: ErrorFormatter = new DiagnosticErrorFormatter(AMBIENT_CONSTRAINT_KEYS);

function reportFailure(log: Log, err: Error): void {
  errorFormatter.report(log, err);
}

/**
 * A consumer closing the pipe early (`fabr cat … | head`, `… | jq -e`) makes the
 * next write to our stdout/stderr emit an `EPIPE` `'error'`; with no listener
 * Node turns that into a raw uncaught-exception stack — exactly the crash
 * presentation the driver otherwise never shows. Core swallows EPIPE for the
 * *child* pipes it spawns, but nothing covers fabr's own streams.
 *
 * We *swallow* it but deliberately do NOT exit from here: the command's own
 * control flow still runs to its `flushAndExit(code)`, so the exit status stays
 * the real outcome. Exiting 0 on any EPIPE would be wrong — a *failing* build
 * whose diagnostics pipe broke (`fabr build 2>&1 | head`) hits EPIPE on stderr
 * mid-report, and a blanket exit-0 would report that failure as success. Once a
 * consumer is gone, further writes to that stream keep erroring harmlessly (all
 * swallowed) and the trailing zero-length writes' callbacks still fire, so the
 * flush-and-exit path neither crashes nor hangs. Any non-EPIPE stream error is
 * genuinely unexpected and rethrown.
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
  ignorePipeErrors();
  /* Watch is meaningful for the build-graph verbs and for `run` (relaunch the
   * program on change — a dev server over built artifacts); ls/cat are one-shot
   * queries and sync is a one-shot publish. */
  const watch =
    options.mode === Mode.Watch &&
    (options.command === "build" || options.command === "test" || options.command === "run");
  switch (options.command) {
    case "ls":
      return runWith(
        (model, execution) =>
          Computable.forAll(resolveNames(model, options, execution), (...results) => listTargets(options, results)),
        false,
        options.quiet
      );
    case "cat":
      return runWith(
        (model, execution) =>
          Computable.forAll(resolveNames(model, options, execution), (...results) => catTarget(options, results)),
        false,
        options.quiet
      );
    case "cp":
      return runWith(
        (model, execution) =>
          Computable.forAll(resolveNames(model, options, execution), (...results) => copyTarget(options, execution, results)),
        false,
        options.quiet
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
      }, watch, options.quiet);
    case "run":
      return runWith((model, execution) => runProgram(model, options, execution, watch), watch, options.quiet);
    case "shell":
      return runWith((model, execution) => shellTarget(model, options, execution), false, options.quiet);
    case "sync":
      return runWith((model, execution) => syncTargets(model, options, execution), false, options.quiet);
    case "list-targets":
      return runWith((model, execution) => listDeclaredTargets(model, options, execution));
    case "list-targetdefs":
      return runWith(model => listTargetDefs(model, options));
    case "list-properties":
      return runWith(model => listProperties(model, options));
    case "list-all":
      return runWith(model => listAll(model));
    default: /* build */
      return runWith((model, execution) => {
        const targets = buildTargets(model, options, execution, "build");
        /* Report inside the callback (see the test case) so a watch rebuild
         * re-prints its status rather than being cut off at the void result. */
        return Computable.forAll(targets, () => buildStatus(execution));
      }, watch, options.quiet);
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
  const config = model.getConfig(Constraints.of({ ...getHostProperties(), [BUILD_OPERATION]: "run", ...Object.fromEntries(options.properties) }), execution);
  const supervisor = watch ? new RunSupervisor(execution.buildCache, options.targets[0], options.runArgs ?? [], execution.log) : undefined;
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
      /* The per-cycle completion marker ("Built X" / "Already up to date"), as
       * the build/test watch verbs print — but deferred until the supervisor's
       * reaction (stage+swap or in-place sync) has landed, so the marker is the
       * cycle's terminal line, after "Restarting"/"Updating content". The
       * cycle's build delta is captured NOW, at settle: an overlapping next
       * cycle must not have its builds scooped into this cycle's late marker.
       * One-shot run stays unmarked (status noise ahead of the program's own
       * output). */
      const built = execution.takeBuiltTargets();
      return supervisor.update(runnable).then(() => reportBuildStatus(execution.log, built));
    }
    return runInteractive(execution.buildCache, runnable, options.runArgs ?? []).then(code => flushAndExit(code));
  });
}

/**
 * `fabr shell <target>`: resolve the target's build action WITHOUT running it,
 * then stage its sandbox and open a shell in it (see {@link shellInto}). Builds
 * under `build` like the real step, so the inputs that fill the sandbox are the
 * real ones. Exits with the shell's own code.
 */
function shellTarget(model: BuildModel, options: Options, execution: ExecutionContext): Computable<void> {
  const config = model.getConfig(Constraints.of({ ...getHostProperties(), [BUILD_OPERATION]: "build", ...Object.fromEntries(options.properties) }), execution);
  return config
    .resolveActionForShell(options.targets[0])
    .then(action => shellInto(execution.buildCache, options.targets[0], action, execution.log))
    .then(code => flushAndExit(code));
}

/**
 * `fabr sync <target>…`: build each sync target under `build` to get its wire
 * artifacts (one PublishableFileSet  per member — a sync target's sources
 * ARE its members), then upload them. Building is the pure/cacheable half (the
 * same as a dry-run); the upload is the driver-level side effect, with the
 * credential read here (never a build input). Not watchable — publishing is a
 * one-shot.
 */
function syncTargets(model: BuildModel, options: Options, execution: ExecutionContext): Computable<void> {
  const targets = buildTargets(model, options, execution, "build");
  return Computable.forAll(targets, (...results: SourceRef[][]) => {
    const publishable = results.flatMap((sources, i) => {
      const members = sources.filter((source): source is PublishableFileSet => source instanceof PublishableFileSet);
      if (members.length === 0) {
        throw new Error(`'${options.targets[i]}' is not a sync target`);
      }
      return members;
    });
    return publishSync(execution, publishable);
  });
}

/**
 * The driver lifecycle harness: establish the run's surroundings (stderr log,
 * cache, source tree, progress-reporting ExecutionContext), load the project,
 * then hand the model to `operation` — exiting 0 on success and rendering the
 * failure tree (exit 1) on error. Reaching a drained event loop without an
 * explicit exit is a stall bug, reported loudly (exit 2).
 */
async function runWith(operation: Operation, watch = false, quiet = false): Promise<void> {
  /* Diagnostics and progress go to stderr; command data (ls listings, cat
   * file contents) goes to stdout, so a build can be filtered from its output.
   * Color is a render-time decision only (NO_COLOR is any non-empty value):
   * captured tool output arrives colored regardless and is stripped when off. */
  const color = process.stderr.isTTY === true && !process.env.NO_COLOR;
  const log = new LogFormatter(LogLevel.Info, line => process.stderr.write(line + "\n"), color);

  Computable.onUnhandledError = err => log.log(DIAG_UNHANDLED, { message: err.message });

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
    const buildCache = new BuildCache(getBuildCacheRoot(), log);

    /* The build cycle is shared: the watch controller advances it before each
     * re-settle, and the execution reads it. Built first (it depends on nothing),
     * so the controller — whose `onBeforeApply` advances it — and the execution —
     * which is built with the source file source that is built with the controller
     * — can both be wired to it without a construction cycle. */
    const cycle = new BuildCycle();
    const controller = watch
      ? new WatchController(
          WATCH_QUIET_MS,
          undefined,
          err => reportFailure(log, err),
          () => cycle.advance(),
          message => log.log(DIAG_WATCH_WARNING, { message })
        )
      : undefined;
    const sourceFileSource = getSourceFileSource(sourceRoot, buildCache, controller);
    const absFileSource = new FSFileSource("/");
    const execution = new ExecutionContext(buildCache, log, sourceFileSource, absFileSource, cycle);
    execution.onProgress(progressListener(log));
    /* Under -q a subcommand's output is captured and shown only on failure;
     * otherwise the step inherits fabr's stderr and streams live as it runs. */
    execution.quiet = quiet;

    if (controller) {
      return runWatched(operation, execution, log, controller);
    }

    /* One-shot runs must route termination signals through process.exit rather
     * than the default disposition: build steps run detached in their own
     * process groups (see Execute.ts), so the terminal's Ctrl-C no longer
     * reaches them — the exit hooks (Execute's group sweep, the run
     * supervisor's cleanup) are what stop in-flight work, and a default-killed
     * process runs no hooks. Codes follow the 128+signal convention. (The watch
     * path already routes its signals through process.exit in runWatched.)
     *
     * An interactive program (`fabr run`, `fabr shell`) is the exception: while
     * one is running it, not fabr, owns the terminal, so the signal is offered
     * to it first and fabr waits for it to end the run in its own time —
     * exiting here would kill it mid-shutdown, or (a signal directed at fabr
     * alone, as a supervisor or CI job sends) leave it orphaned with its staged
     * install. A second signal is not offered, so it falls through and exits. */
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

    return loadProject(execution, PROJECT_FILENAME)
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
  execution: ExecutionContext,
  log: Log,
  controller: WatchController
): Promise<void> {
  const shutdown = (): void => {
    /* Hard deadline first: teardown must never be able to pin a signalled watch
     * process alive (a hung native unsubscribe, a stuck closer) — exit 1 marks
     * the unclean teardown. Unref'd so the deadline itself never holds the loop. */
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    /* Await teardown before exiting: unsubscribe stops a native watcher thread,
     * and exiting mid-flight crashes the kqueue backend (SIGABRT). The explicit
     * process.exit then fires the 'exit' hooks — including a RunSupervisor's
     * synchronous child cleanup — which a *default* signal disposition would
     * skip entirely, orphaning the launched program and leaking its staged dir. */
    void controller.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  /* This observer re-fires every time the operation's Computable re-settles (the
   * revalidation cascade after a change), so status/failure render per cycle. */
  loadProject(execution, PROJECT_FILENAME)
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
  return model.getConfig(Constraints.of({ ...getHostProperties(), [BUILD_OPERATION]: operation, ...Object.fromEntries(options.properties) }), execution);
}

/** Build each named target under the given operation (bare target names). */
function buildTargets(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  operation: string
): Computable<SourceRef[]>[] {
  const config = configFor(model, options, execution, operation);
  return options.targets.map(name => config.getTargetRef(name));
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
  reportBuildStatus(execution.log, execution.takeBuiltTargets());
}

/** The marker's rendering half, over an already-captured delta — for a caller
 * that must take the delta at one time and print at another (run -w defers the
 * marker past the supervisor's reaction). */
function reportBuildStatus(log: Log, built: string[]): void {
  if (built.length === 0) {
    log.log(DIAG_UP_TO_DATE, {});
  } else {
    log.log(DIAG_BUILD_COMPLETE, { targets: built.join(", ") });
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
   * is fixed here: argument order across names, then source order within a name
   * (a multi-source target — a sync's members — cats each source in turn, as if
   * each were named), sorted by filename within each source. */
  const files: IFile[] = [];
  results.forEach((sources, i) => {
    const sets = sources.filter((source): source is FileSet => source instanceof FileSet);
    if (sets.every(set => set.isEmpty())) {
      throw matchedNoFiles(options.targets[i]);
    }
    for (const set of sets) {
      files.push(...[...set].sort(([a], [b]) => a.localeCompare(b)).map(([, file]) => file));
    }
  });
  /* Stream each file's contents to stdout in that order, one at a time — reading
   * the next only after the previous is *flushed*, so the whole set is never held
   * in memory at once (`cat` may dump large artifacts). The write callback fires
   * once the chunk has been handled by the stream, so resolving from it honors a
   * slow consumer's backpressure rather than queueing everything ahead. */
  return files.reduce<Computable<void>>(
    (prev, file) => prev.then(() => file.getBuffer()).then(buffer => writeStdout(Uint8Array.from(buffer))),
    Computable.resolve(undefined)
  );
}

/** Write `bytes` to stdout, resolving from the write callback so a slow (or
 * closing) consumer applies backpressure — the next read waits for this flush. */
function writeStdout(bytes: Uint8Array): Computable<void> {
  return Computable.from(resolve => {
    process.stdout.write(bytes, () => resolve(undefined));
  });
}

/**
 * `fabr cp <source…> <dest>`: resolve each source name to its files (exactly as
 * `cat` does — projections/globs already applied), then copy them into the
 * destination directory following **`cp`'s own file-vs-directory rule**
 * ({@link copyPrefix}): a source that names a directory/container (a target,
 * package, or namespace) becomes a subdirectory named after that reference
 * (`fabr cp @scope/core out` → `out/core/…`, `cp -r core out/` → `out/core/`),
 * while a source that names a single file or a glob copies flat. `dest` is a
 * plain filesystem path resolved against the invocation cwd (not a model name),
 * created if absent. The copy is **additive** (files already in `dest` are left
 * untouched) and breaks the cache hardlink (`copy: true`), so the copies are
 * independent of fabr's cache. A source matching no files is an error, raised
 * before a byte is written. (The declarative dual — laying built content into a
 * directory as part of a `sync` release — is parked.)
 */
function copyTarget(options: Options, execution: ExecutionContext, results: SourceRef[][]): Computable<void> {
  const sets: FileSet[] = results.flatMap( (sources,i) => {
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
 * `cp`'s file-vs-directory rule applied to one source: how each of its resolved files is
 * named under `dest`, or `undefined` to keep the resolved name as-is. `cp` is a pure file
 * operation — exactly `cp -R`, never package-aware — so this follows the source
 * **reference as written**, never the resolved package's own identity
 * (`cp -R node_modules/@scope/package out` yields `out/package`, and by the same
 * rule `@npm:esbuild:0.28.1` yields `out/0.28.1` — the reference's final component
 * whatever it happens to be):
 * - a **trailing `/`** or a **final glob** (`pkg:build/*.js`) → flat: the contents / the
 *   matched files land directly under dest (`cp dir/ out`, `cp build/*.js out`). The
 *   selector's own literal directories are the path cp copies *from*, so they come off the
 *   names — the shell would have expanded the glob and handed cp each file individually,
 *   and cp names a file source by its basename. What the wildcards matched is kept, so a
 *   recursive glob preserves structure below the base (`cp -R build/. out`).
 *
 * Whether the path was written with a `:` or a `/` makes no difference to any of this: the
 * separator decides what the resolved files are *named* (`:` strips what precedes it), but
 * cp copies from the path as written either way, so both land the same files in the same
 * places.
 * - a source that **directly names a single file** → flat (the file keeps its
 *   name — `cp file out` → `out/file`);
 * - otherwise it **names a directory/container** → nested under its final path
 *   component (`cp -r dir out` → `out/dir/`).
 * The final component is taken from the *parsed* name so its `<k=v>` / `-> tmpl`
 * facets are stripped first (`mylib<BUILD_TYPE=release>` nests under `mylib`, not
 * the literal facet text — a delta constrains the build, it is not part of the
 * name). "Directly names a file" wraps unless the source is a **lone delivered
 * file whose basename is that leaf** (`files:a.txt` → `a.txt`, flat).
 */
function remapCopyTargetName(name: string, sets: FileSet[]): ((fileName: string) => string) {
  /* Parse then drop the constraint facet, so what we inspect is the resolvable name alone. */
  const parsed = parseName(name).withConstraints([]);
  /* An explicit `-> tmpl` IS the naming: the resolved files already carry the names it
   * produced, so cp adds no default of its own. Without this a rename that keeps — or
   * reintroduces — the selector's literal prefix would have it stripped straight back off
   * below, quietly overriding what was asked for. */
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
  /* A named file lands under its basename, as cp names any file source — so the directories
   * it was reached through come off whether they were written with `:` or `/`. */
  return isLoneFile ? () => leaf : fileName => `${leaf}/${fileName}`;
}

/**
 * The directory prefix a flat source's resolved files carry from the selector, and which
 * `cp` therefore strips — the name's own literal leading path
 * ({@link Name.getLiteralPathPrefix}, which ends at the last separator before the first
 * wildcard and treats `:` and `/` alike).
 *
 * How much of that prefix the *names* carry depends on how the reference was spelled —
 * `pkg:build/*.js` resolves to `build/a.js`, `pkg/build/*.js` to `pkg/build/a.js` — so
 * take the longest trailing run of its segments the names really start with. Both then
 * strip to `a.js`, which is what makes the two spellings copy identically. A wildcard
 * with nothing literal before it leaves no prefix, so such a source keeps its whole
 * matched structure.
 */
function selectorBase(selector: Name, names: string[]): string {
  const dirs = selector.getLiteralPathPrefix().split(/[/:]/).filter(Boolean);
  /* Trailing runs, longest first — a repeated segment (`a/a/**`) must not match short. */
  const candidates = dirs.map((_, from) => `${dirs.slice(from).join("/")}/`);
  return candidates.find(base => names.every(name => name.startsWith(base))) ?? "";
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
 * results are FileSets already — enumerated per source, blank-line separated
 * (a multi-source target lists each source as if each were named, never
 * unioned into one flat set). Listing output is the command's data, so it
 * goes straight to stdout rather than through the diagnostic log.
 */
function listTargets(options: Options, results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map(sources =>
      Computable.forAll(
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

/**
 * `fabr list-targets`: print the targets declared in the project (name + type),
 * recursively across namespaces. A model query — it builds nothing. Repository
 * instances are excluded (they are not buildable targets), and by default so
 * are system-contributed targets (declared in core's or a plugin's lib files —
 * e.g. fabr's own driver tools): the listing is *your* targets. `--all` lifts
 * that, and an explicitly-named target always shows (naming it is explicit
 * interest). `-l` adds each target's source location; `--json` emits the
 * structured form, each target carrying its `origin` (`system` or `project`).
 * Output is the command's data, so it goes to stdout.
 */
function listDeclaredTargets(model: BuildModel, options: Options, execution: ExecutionContext): Computable<void> {
  /* A system decl is one whose build file was loaded from outside the project
   * tree — core's or a plugin's contributed lib file, which the loader reads
   * through the absFileSource (project files read through the source tree), so
   * the identity of the decl's fs is the whole test. */
  const isSystem = (decl: ITargetDecl): boolean => decl.source.fs === execution.absFileSource;
  const wanted = new Set(options.targets);
  const targets = model
    .getTargets()
    .filter(target => (wanted.size > 0 ? wanted.has(target.name) : options.all || !isSystem(target.decl)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const missing = [...wanted].filter(name => !targets.some(target => target.name === name));
  if (missing.length > 0) {
    throw new Error(`No such target: ${missing.join(", ")}`);
  }
  if (options.json) {
    const json = targets.map(({ name, decl }) => ({
      name,
      type: decl.type,
      origin: isSystem(decl) ? "system" : "project",
      location: formatDeclLocation(decl),
    }));
    console.log(JSON.stringify({ targets: json }, undefined, 2));
    return Computable.resolve(undefined);
  }
  const nameWidth = Math.max(0, ...targets.map(target => target.name.length));
  /* In long mode a source location trails the type, so pad the type column too
   * for the locations to line up; without it (plain listing) the type ends the
   * line and needs no padding. */
  const typeWidth = options.longListing ? Math.max(0, ...targets.map(target => target.decl.type.length)) : 0;
  for (const { name, decl } of targets) {
    const location = options.longListing ? "  " + formatDeclLocation(decl) : "";
    console.log(`${name.padEnd(nameWidth)}  ${decl.type.padEnd(typeWidth)}${location}`);
  }
  return Computable.resolve(undefined);
}

/** @return a `file:line:column` reference to where a declaration was written. */
function formatDeclLocation(decl: ITargetDecl | ITargetDefDecl | IPropertyDecl): string {
  const span = declPosn(decl);
  const pos = span.reader.resolvePosition(span.offset);
  return pos ? `${span.file}:${pos.line}:${pos.column}` : span.file;
}

/** @return the source-level keyword for a property's type, as written in a
 * targetdef (`FILES`, `STRING`, `MAP`, `COMMAND`, `REWRITE`). */
function propertyTypeName(schema: IPropertySchema): string {
  switch (schema.type) {
    case PropertyType.FileSet:
      return "FILES";
    case PropertyType.String:
      return "STRING";
    case PropertyType.Map:
      return "MAP";
    case PropertyType.Command:
      return "COMMAND";
    case PropertyType.Rewrite:
      return "REWRITE";
    default:
      return PropertyType[schema.type];
  }
}

/**
 * `fabr list-targetdefs`: print the available target types — the build
 * vocabulary contributed by core and the project's active plugins — each with
 * the operations it supports (`build`/`test`/`run`, from its registered rules)
 * and its declared properties (name, type, whether REQUIRED). A model query:
 * it builds nothing. An optional list of names filters to just those types;
 * `-l` appends each type's source location — its contributing lib file (core's
 * STD.fabr or a plugin's), which is where the type is defined and documented.
 * `--json` emits the full structured form — operations, source location, and
 * the doc-comment descriptions — for docs generation. Output is the command's
 * data, so it goes to stdout.
 */
function listTargetDefs(model: BuildModel, options: Options): Computable<void> {
  const wanted = new Set(options.targets);
  /* Declaration order (as written in the lib files), not alphabetical: the
   * author curates the reading order by placement — e.g. the compile primitives
   * are declared last so they document last. Same order feeds `list-all`/docs. */
  const defs = model.getTargetDefs().filter(def => wanted.size === 0 || wanted.has(def.name));
  /* A named-but-unknown type is a user error (a typo), not an empty success —
   * report every name that matched no targetdef. */
  const missing = [...wanted].filter(name => !defs.some(def => def.name === name));
  if (missing.length > 0) {
    throw new Error(`No such target type: ${missing.join(", ")}`);
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
      console.log(`  ${name.padEnd(width)}  ${type}`);
    }
  });
  return Computable.resolve(undefined);
}

/**
 * `fabr list-properties`: print the global configuration surface — the documented
 * config properties (`BUILD_TYPE`, `JS_TARGET`, …) with their defaults, and the
 * `flag` switches (`ts/nostrict`, …). These are what you *configure*, as opposed
 * to the target *types* (`list-targetdefs`) and target *instances* (`list-targets`);
 * flags happen to be `flag` targets, but they read as configuration, so they are
 * listed here. A model query — it builds nothing. `--json` emits the structured
 * form (value, source location, doc comment) for docs generation.
 */
function listProperties(model: BuildModel, options: Options): Computable<void> {
  const properties = configPropertiesJson(model);
  const flags = flagTargetsJson(model);
  if (options.json) {
    console.log(JSON.stringify({ properties, flags }, undefined, 2));
    return Computable.resolve(undefined);
  }
  const width = Math.max(0, ...properties.map(prop => (prop.name as string).length));
  properties.forEach(prop => {
    const location = options.longListing ? "  " + prop.location : "";
    console.log(`${(prop.name as string).padEnd(width)} = ${prop.value}${location}`);
  });
  if (flags.length > 0) {
    console.log("\nFlags:");
    flags.forEach(flag => console.log(`  ${flag.name}${options.longListing ? "  " + flag.location : ""}`));
  }
  return Computable.resolve(undefined);
}

/**
 * `fabr list-all`: the whole build vocabulary in one machine-readable document —
 * target types, config properties, and flags together (`{ targetdefs, properties,
 * flags }`). The union of `list-targetdefs` and `list-properties`, so a single
 * consumer (docs generation) reads everything from one invocation rather than
 * stitching several. Always JSON — it exists for tooling, not human listing.
 */
function listAll(model: BuildModel): Computable<void> {
  const defs = model.getTargetDefs(); /* declaration order — see listTargetDefs */
  console.log(
    JSON.stringify(
      {
        targetdefs: defs.map(def => targetDefJson(model, def)),
        properties: configPropertiesJson(model),
        flags: flagTargetsJson(model),
      },
      undefined,
      2
    )
  );
  return Computable.resolve(undefined);
}

/** @return the full structured form of a targetdef for `--json` — its
 * operations, source location, description, and per-property schema with
 * descriptions (doc comments; null when a decl carries none). */
function targetDefJson(model: BuildModel, def: ITargetDefDecl): Record<string, unknown> {
  return {
    name: def.name,
    operations: model.getOperations(def.name),
    location: formatDeclLocation(def),
    description: def.docComment ?? null,
    properties: [...def.properties].map(([name, schema]) => ({
      name,
      type: propertyTypeName(schema),
      required: schema.required === true,
      description: schema.docComment ?? null,
    })),
  };
}

/** @return the documented global configuration properties (`BUILD_TYPE`,
 * `JS_TARGET`, `TSC`, …) — only those carrying a doc comment, each with its
 * default value, source location, and description — for docs generation. */
function configPropertiesJson(model: BuildModel): Record<string, unknown>[] {
  return model
    .getProperties()
    .filter(({ decl }) => decl.docComment !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, decl }) => ({
      name,
      value: renderPropertyValue(decl),
      location: formatDeclLocation(decl),
      description: decl.docComment ?? null,
    }));
}

/** @return the `flag` targets (source-mode switches like `ts/nostrict`) with
 * their descriptions — the flags a user lists in a target's `deps`. */
function flagTargetsJson(model: BuildModel): Record<string, unknown>[] {
  return model
    .getTargets()
    .filter(({ decl }) => decl.type === "flag")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, decl }) => ({ name, location: formatDeclLocation(decl), description: decl.docComment ?? null }));
}

/** @return a property's written value as a display string (its name-valued
 * words joined; non-scalar values omitted) — the default shown in the config
 * reference (`JS_TARGET` → `es2021-commonjs`, `TARGET` → `${HOST}`). */
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
