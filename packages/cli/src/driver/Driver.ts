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
  BuildContext,
  BuildModel,
  buildOperation,
  Computable,
  ComputableHandle,
  declPosn,
  Diagnostic,
  ExecutionContext,
  Fabr,
  FileSet,
  formatTestSummary,
  IFile,
  getTestReport,
  Name,
  parseName,
  Log,
  LogFormatter,
  LogLevel,
  IPropertyDecl,
  IPropertySchema,
  isFileSource,
  isNameValue,
  ITargetDecl,
  ITargetDefDecl,
  PropertyType,
  PublishableFileSet,
  reportFailure,
  SyncSource,
  testOperation,
  forceTargets,
  PERMISSIVE_RESOLUTION,
  toRunnable,
  signalInteractiveChild,
  SourceRef,
  toError,
  writeFileSet,
  Constraints,
  IResolvedWriteBack,
  locateSource,
  writeBackCandidates,
} from "@fabr-build/core";
import { runInteractive, RunSupervisor } from "./RunHandler";
import { shellInto } from "./ShellHandler";
import { publishSync } from "./SyncHandler";
import { completeCommandLine, Mode, Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, getHostProperties } from "./Environment";
import { IInvocationSite } from "./CommandLineSource";
import { TerminalInteraction } from "./Interaction";
import { ProgressReporter } from "./Progress";
import { setActiveTerminal, TerminalStream } from "./Terminal";
import * as path from "node:path";

const DIAG_BUILD_FAILED = Diagnostic.Error<Record<string, never>>("Build failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");
const DIAG_WATCHING = Diagnostic.Info<Record<string, never>>("Watching for changes (Ctrl-C to stop)");
const DIAG_UNHANDLED = Diagnostic.Warn<{ message: string }>("Unhandled error: {message}");
const DIAG_COPIED = Diagnostic.Info<{ count: number; dest: string }>("Copied {count} file(s) to {dest}");
const DIAG_EXPECTATION_UPDATED = Diagnostic.Info<{ file: string }>("Updated {file}");
/* A refreshed record with nowhere to go. Warned rather than passed over: the run
 * is green and reports no update, so without this the next `check` run fails on
 * the same stale record with nothing to say why `-u` did not help. */
const DIAG_EXPECTATION_UNPLACEABLE = Diagnostic.Warn<{ test: string }>(
  "Refreshed the recorded expectation for {test}, but it is not a source-tree file — there is nowhere to write it back to"
);
/* Two targets offered DIFFERENT refreshed content for one destination (their
 * runs genuinely disagree — e.g. environment-dependent output). First offer
 * wins; warned because silently picking one would make the loser's next check
 * run fail with nothing to say why updating didn't help. */
const DIAG_EXPECTATION_CONFLICT = Diagnostic.Warn<{ file: string }>(
  "Conflicting updates for {file} from different test runs; keeping the first"
);

/** How long a signalled watch process's teardown may take before the shutdown
 * deadline force-exits — generous for a native watcher unsubscribe, short
 * enough that a stuck teardown can't hang a test runner or CI. */
const SHUTDOWN_GRACE_MS = 5000;

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
 * `execution`; the command (and so `options`) is closed over by the caller. The
 * `site` is where the invocation was run — known only once the project has been
 * located, so the harness supplies it rather than the parse: it is what a name
 * given on the command line is written in (see {@link CommandLineSource}). */
export type Operation = (model: BuildModel, execution: ExecutionContext, site: IInvocationSite) => Computable<void | Takeover>;

/** What a process-takeover verb's evaluation resolves to: the launch to
 *  perform once the evaluation has settled and its cycle closed (`fabr run`'s
 *  interactive program). The takeover owns the process from its invocation —
 *  its chain ends in the exit. */
export type Takeover = () => Computable<void>;

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
      return runWith(options, (model, execution, site) =>
        Computable.forAll(resolveNames(model, options, execution, site), (...results) => listTargets(options, results))
      );
    case "cat":
      return runWith(options, (model, execution, site) =>
        Computable.forAll(resolveNames(model, options, execution, site), (...results) => catTarget(options, results))
      );
    case "cp":
      return runWith(options, (model, execution, site) =>
        Computable.forAll(resolveNames(model, options, execution, site), (...results) => copyTarget(options, execution, results))
      );
    case "test":
      return runWith(options, (model, execution, site) => runTest(model, options, execution, site, options.targets), watch);
    case "run":
      return runWith(options, (model, execution, site) => runProgram(model, options, execution, site, watch), watch);
    case "shell":
      return runWith(options, (model, execution) => shellTarget(model, options, execution));
    case "sync":
      return runWith(options, (model, execution, site) => syncTargets(model, options, execution, site));
    case "list-targets":
      return runWith(options, (model, execution) => listDeclaredTargets(model, options, execution));
    case "list-targetdefs":
      return runWith(options, model => listTargetDefs(model, options));
    case "list-properties":
      return runWith(options, model => listProperties(model, options));
    case "list-all":
      return runWith(options, model => listAll(model));
    default: /* build, or no command at all */
      return options.deferred
        ? runWith(options, (model, execution, site) => runInferred(model, options, execution, site, options.mode === Mode.Watch), watch)
        : runWith(options, (model, execution) => runBuild(model, options, execution, options.targets), watch);
  }
}

/** `fabr build <targets>`: the core operation; the marker rides cycle-end. */
function runBuild(model: BuildModel, options: Options, execution: ExecutionContext, names: string[]): Computable<void> {
  markForced(model, options, execution, names);
  return buildOperation(configFor(model, options, execution, "build"), names).then(() => undefined);
}

/** `fabr test <targets>`: the core operation, with the summaries and
 * expectation write-backs composed onto its results — a `then` on the results
 * re-runs exactly when a watch cycle changed them, so per-change reporting is
 * ordinary composition. */
function runTest(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite,
  names: string[]
): Computable<void> {
  markForced(model, options, execution, names);
  return testOperation(configFor(model, options, execution, "test"), names).then(results =>
    reportTestResults(execution.log, names, results).then(() => applyExpectationUpdates(execution, site, results))
  );
}

/**
 * Write refreshed test expectations (snapshots) back into the source tree.
 *
 * The gate is the CANDIDATES' existence, not a re-read of any flag: a check
 * run offers none by construction (its outputs never collect the records), so
 * candidates exist exactly when the effective `TEST_EXPECTATIONS` was
 * `update` — however it was spelled (`-u`, `-D`, or a declared global in the
 * build file; the pipeline reads the model's value, so re-checking only the
 * CLI's spelling here would silently discard a declared update's offers). The
 * write still happens here, in the driver, after the build has settled green
 * — nothing inside the build graph may touch the user's tree.
 */
function applyExpectationUpdates(execution: ExecutionContext, site: IInvocationSite, results: SourceRef[][]): Computable<void> {
  /* Resolving each candidate's input to a place on disk is the driver's half of
   * the arrangement: the rule offered content named relative to an input it
   * belongs beside, which is all a rule can honestly know. An input with no
   * source-tree location (a generated test) is where the offer runs out — said
   * out loud, because the run is green and reports no update, so silence would
   * leave the next `check` run failing on the same stale record with nothing to
   * explain why `-u` did not help. */
  const writes = new Map<string, IResolvedWriteBack>();
  for (const { files, belongsTo, origin } of results.flatMap(sources => writeBackCandidates(sources))) {
    /* The offer names its content in the inputs' own namespace and says, as one
     * rename projection, how such a name names the input it belongs to. Applying
     * it and locating that input is all the driver does — it needs no notion of
     * what the content IS. */
    const belongs = belongsTo.makeProjector();
    for (const [name, file] of files) {
      const input = belongs(name);
      if (input === undefined) {
        /* The offer's own rewrite does not name this file's input — a rule
         * contradicting itself, so say which file rather than swallow it. */
        execution.log.log(DIAG_EXPECTATION_UNPLACEABLE, { test: name });
        continue;
      }
      const source = locateSource(origin, input);
      if (source === undefined) {
        execution.log.log(DIAG_EXPECTATION_UNPLACEABLE, { test: input });
        continue;
      }
      /* The file's own name relative to the input's directory is where it goes,
       * so a record lands beside the test exactly as it sits beside it here.
       * Deduplicated by destination: two targets covering the same tree (a
       * js_test beside a js_package) each offer the same record, and parallel
       * writes to one path would collide on the temp sibling. Identical
       * content collapses silently; divergent content is a real conflict. */
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
  /* Written through the SOURCE, not straight to the filesystem: it owns the
   * tree, so it is the only thing that can recognize the resulting watch event
   * as its own and keep the write from rebuilding the very target that produced
   * it. The decision is still made here — only after a green build. */
  return site.sourceFileSource.applyWriteBack([...writes.values()]).then((written: string[]) => {
    for (const destination of written) {
      execution.log.log(DIAG_EXPECTATION_UPDATED, { file: path.relative(site.sourceFileSource.root, destination) });
    }
  });
}

/**
 * A command-less invocation (`fabr docs_serve`): each named target takes the
 * operation its type supports, which needs the loaded model — so the command
 * line is finished here ({@link completeCommandLine}) rather than at parse
 * time. Each group then does exactly what the explicit verb would, and they
 * are *siblings*, not a chain: under watch they must stay independently
 * reactive (a rebuild re-settles its own group; hanging the run downstream of
 * a build would re-enter its factory, and so its supervisor, per cycle). Only
 * a one-shot run sequences after the rest, because it takes over the process
 * and exits with the program's status — nothing after it would run.
 */
function runInferred(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite,
  watch: boolean
): Computable<void | Takeover> {
  const plan = completeCommandLine(options, name => operationsOf(model, name));
  const groups: Computable<void>[] = [];
  if (plan.build.length > 0) {
    groups.push(runBuild(model, options, execution, plan.build));
  }
  if (plan.test.length > 0) {
    groups.push(runTest(model, options, execution, site, plan.test));
  }
  const run = plan.run;
  if (!run) {
    return Computable.forAll(groups, () => undefined);
  }
  const program = (): Computable<void | Takeover> => runProgram(model, options, execution, site, watch, run.target, run.args);
  if (watch) {
    return Computable.forAll([...groups, program()], () => undefined);
  }
  /* One-shot: the groups build first, then the run target — all one
   * evaluation; the program launch rides out as its takeover. (The marker
   * prints before the launch — the command-less form is build-flavoured, and
   * a one-line summary ahead of the program is its status report.) */
  return Computable.forAll(groups, () => undefined).then(program);
}

/** @return the operations the named target's type supports, or none at all if
 * the name doesn't name a declared target (an unknown name, or a property):
 * the caller then asks for a build and gets the ordinary resolution failure. */
function operationsOf(model: BuildModel, name: string): string[] {
  const decl = model.getTargetDecl(name);
  return decl ? model.getOperations(decl.type) : [];
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
  site: IInvocationSite,
  watch: boolean,
  target: string = options.targets[0],
  args: string[] = options.runArgs ?? []
): Computable<void | Takeover> {
  const config = configFor(model, options, execution, "run");
  markForced(model, options, execution, [target]);
  const supervisor = watch ? new RunSupervisor(execution.buildCache, target, args, execution.log) : undefined;
  /* The name IS the program (`fabr run @npm:http-server:14.1.1`), so its closure
   * is a sealed install — the same judgment a rule's `tool` property makes. */
  return config.resolveName(options.commandLine.refFor(target, site), undefined, PERMISSIVE_RESOLUTION).then<void | Takeover>(sources => {
    /* A projected runnable (`fabr run pkg:tsc`) arrives pending — this is the
     * point a launcher is demanded, so it collapses here. */
    const runnable = sources.map(toRunnable).find(Boolean);
    if (!runnable) {
      /* No runnable: a projection that matched nothing (empty) is the shared
       * "matched no files" error — same as cat/ls; genuine content that just
       * isn't runnable is the distinct case. */
      const files = FileSet.unionAll(...sources.filter((s): s is FileSet => s instanceof FileSet));
      throw files.isEmpty()
        ? matchedNoFiles(target)
        : new Error(`'${target}' is not runnable (it has no BUILD_OPERATION=run result)`);
    }
    if (supervisor) {
      /* The supervisor's reaction is inside the observed chain, so the watch
       * observer — where the cycle ends and the marker renders — fires only
       * after it lands: the marker stays the cycle's terminal line. */
      return supervisor.update(runnable);
    }
    /* One-shot: the launch is not evaluation — it is what happens after the
     * evaluation settles (and its cycle closes), so it is handed back as the
     * run's takeover rather than performed in-chain. */
    const takeover: Takeover = () => runInteractive(execution.buildCache, runnable, args).then(code => flushAndExit(code));
    return takeover;
  });
}

/**
 * `fabr shell <target>`: resolve the target's build action WITHOUT running it,
 * then stage its sandbox and open a shell in it (see {@link shellInto}). Builds
 * under `build` like the real step, so the inputs that fill the sandbox are the
 * real ones. Exits with the shell's own code.
 */
function shellTarget(model: BuildModel, options: Options, execution: ExecutionContext): Computable<void | Takeover> {
  const config = configFor(model, options, execution, "build");
  return config
    .resolveActionForShell(options.targets[0])
    .then<void | Takeover>(action => {
      /* The shell owns the process once launched — a takeover, like run's
       * program, so the evaluation settles (and its cycle closes) first. */
      const takeover: Takeover = () =>
        shellInto(execution.buildCache, options.targets[0], action, execution.log).then(code => flushAndExit(code));
      return takeover;
    });
}

/**
 * `fabr sync <name>…`: package the named wire artifacts under `build`, then
 * upload them. Each name is resolved WHOLE (as ls/cat resolve theirs), so it may
 * name a release — every member of it, packaged in publish order — or reach into
 * one for a single member (`release/@npm/x/1.0.0`), which packages that member
 * alone; a release is a namespace, so both are ordinary references into it.
 * Packaging is the pure/cacheable half (the same as a dry-run); the upload is
 * the driver-level side effect, with the credential read here (never a build
 * input). Not watchable — publishing is a one-shot.
 */
function syncTargets(model: BuildModel, options: Options, execution: ExecutionContext, site: IInvocationSite): Computable<void> {
  const config = configFor(model, options, execution, "build");
  const resolved = options.targets.map(name => config.resolveName(options.commandLine.refFor(name, site)));
  return Computable.forAll(resolved, (...results: SourceRef[][]) =>
    Computable.forAll(
      results.map((sources, i) => membersOf(sources, options.targets[i])),
      (...members: PublishableFileSet[][]) => publishSync(execution, members.flat())
    )
  );
}

/** The publishable members one resolved name yields: a whole release (its
 *  namespace, packaged deps-first) or the individual carriers named. */
function membersOf(sources: SourceRef[], name: string): Computable<PublishableFileSet[]> {
  const releases = sources.filter((source): source is SyncSource => source instanceof SyncSource);
  const carriers = sources.filter((source): source is PublishableFileSet => source instanceof PublishableFileSet);
  if (releases.length === 0 && carriers.length === 0) {
    throw new Error(`'${name}' is not a sync target`);
  }
  return Computable.forAll(
    releases.map(release => release.members()),
    (...packaged: PublishableFileSet[][]) => [...packaged.flat(), ...carriers]
  );
}

/**
 * The driver lifecycle harness: establish the run's surroundings (stderr log,
 * cache, source tree, progress-reporting ExecutionContext), load the project,
 * then hand the model to `operation` — exiting 0 on success and rendering the
 * failure tree (exit 1) on error. Reaching a drained event loop without an
 * explicit exit is a stall bug, reported loudly (exit 2).
 */
async function runWith(options: Options, operation: Operation, watch = false): Promise<void> {
  /* Diagnostics and progress go to stderr; command data (ls listings, cat
   * file contents) goes to stdout, so a build can be filtered from its output.
   * Color is a render-time decision only (NO_COLOR is any non-empty value):
   * captured tool output arrives colored regardless and is stripped when off. */
  const color = process.stderr.isTTY === true && !process.env.NO_COLOR;
  /* One component owns stderr: everything fabr renders — diagnostics, and the
   * build steps' output the pump forwards — is written through it, so the live
   * pane can erase and repaint around each block. Without a tty there is no
   * pane and it is a direct write (the pane is a derived view of what the log
   * already records, so its absence loses nothing). */
  /* `-q` asks for less happening on the terminal, and the live pane is the
   * most of it: a display that repaints ten times a second is not what someone
   * who just silenced the build's own tools wants left running. So quiet drops
   * the pane as well as the streamed output — and (see ProgressReporter) does
   * NOT get the start lines back in its place, which is the one thing that
   * would make asking for quiet produce more output than not asking. */
  const terminal = new TerminalStream(process.stderr, process.stderr.isTTY === true && !options.quiet);
  const log = new LogFormatter(LogLevel.Info, line => terminal.write(line), color);
  /* Published for the code that hands the terminal over rather than writes to
   * it (a prompt, an interactive child) — see withTerminalSuspended. */
  setActiveTerminal(terminal);

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
    /* The run itself lives in core; the driver hands it the paths its
     * environment policy chose. */
    const fabr = new Fabr({ sourceRoot, cacheRoot: getBuildCacheRoot(), log, watch });
    const execution = fabr.execution;
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
     * events, so steps capture and show output only on failure. */
    const progress = new ProgressReporter(log, {
      terminal,
      color,
      quiet: options.quiet,
      markers: showsMarkers(options.command, watch),
    });
    execution.onBuildEvent(progress.buildListener, { output: !options.quiet });
    /* A terminal to ask on (an npm publish's second-factor ceremony) — only
     * when both the answer channel (stdin) and the question channel (stderr,
     * the diagnostic stream) are ttys; its absence is the "non-interactive
     * run" signal callers turn into a typed error. */
    if (process.stdin.isTTY === true && process.stderr.isTTY === true) {
      execution.interaction = new TerminalInteraction(log);
    }

    if (fabr.controller) {
      return runWatched(operation, fabr, site, log);
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

    return fabr
      .evaluate(model => operation(model, execution, site))
      .then(takeover => {
        /* The evaluation has settled and its cycle closed; a takeover verb now
         * gets the process (its chain owns the exit), anything else is done. */
        if (takeover) {
          return takeover();
        }
        flushAndExit(0);
      })
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

/** Whether this verb's runs render the per-cycle status marker ("Built X" /
 * "Already up to date"): the build/test verbs do, `run` only under watch (a
 * one-shot run's marker is status noise ahead of the program's own output);
 * the query and side-effect verbs never — their outcome is their own output. */
function showsMarkers(command: string, watch: boolean): boolean {
  if (command === "run") {
    return watch;
  }
  return command === "build" || command === "test";
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
function runWatched(operation: Operation, fabr: Fabr, site: IInvocationSite, log: Log): Promise<void> {
  const controller = fabr.controller!;
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

  /* The run's evaluation, observed for *settlement* rather than for a value
   * change — a rebuild that converges to identical values (or the same
   * failure) settles without notifying any `then`, but a handle's onSettled
   * still fires, once per applied batch. The execution observes it first (the
   * cycle-end and its marker); this second handle renders what the stream
   * deliberately doesn't carry: the failure tree, and the watching
   * announcements. */
  const outcome = fabr.evaluate(model => operation(model, fabr.execution, site)).then(
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
        log.log(DIAG_BUILD_FAILED, {});
        log.log(DIAG_WATCHING, {});
      }
    } else if (!announced || lastFailure !== undefined) {
      /* Announced once, and again on a red-to-green transition. */
      log.log(DIAG_WATCHING, {});
    }
    announced = true;
    lastFailure = failed ? result : undefined;
  });
  observer.seat(outcome);
  return new Promise<void>(() => {});
}

function configFor(model: BuildModel, options: Options, execution: ExecutionContext, operation: string): BuildContext {
  return model.getConfig(Constraints.of({ ...getHostProperties(), [BUILD_OPERATION]: operation, ...Object.fromEntries(options.properties) }), execution);
}

/** Apply `-f`'s force marks for `names` (see core's {@link forceTargets}). */
function markForced(model: BuildModel, options: Options, execution: ExecutionContext, names: string[]): void {
  if (options.force) {
    forceTargets(model, execution, names);
  }
}

/** Resolve each whole name (target + projection) under the `files` operation:
 * ls/cat only ever want the resolved files, so this lets the leaves do less —
 * an `@npm:` reference delivers a package's own files with no dependency
 * closure — while a declared target still builds (files falls back to build).
 * Each name resolves as the reference it is, written on the command line
 * ({@link CommandLineSource}) — so a bare path names files just as it would in
 * a build file. */
function resolveNames(
  model: BuildModel,
  options: Options,
  execution: ExecutionContext,
  site: IInvocationSite
): Computable<SourceRef[]>[] {
  const config = configFor(model, options, execution, FILES_OPERATION);
  return options.targets.map(name =>
    config
      .resolveName(options.commandLine.refFor(name, site))
      .then(sources => Computable.forAll(sources.map(openedOut), (...opened: SourceRef[]) => opened))
  );
}

/** Everything, as a selector — what a name that stops at a source rather than
 *  projecting into it asks for (see {@link openedOut}). */
const ALL_FILES = parseName("**");

/**
 * The files behind one resolved source, for the verbs that only ever want files.
 * A FileSet already IS its files; a source that instead serves them on its own
 * terms — a `sync` release namespace, a `fetch` table — is asked for all of
 * them, which is the same thing `<name>/**` asks for explicitly. Without this a
 * name stopping at such a source resolves to something none of ls/cat/cp can
 * read, and silently lists nothing.
 *
 * Deliberately not applied to every source: a RunnableFileSet reads a projection
 * as *entry selection*, so asking it for `**` would narrow the program rather
 * than list the install.
 */
function openedOut(source: SourceRef): Computable<SourceRef> {
  if (source instanceof FileSet || !isFileSource(source)) {
    return Computable.resolve(source);
  }
  return source.find(ALL_FILES).then(files => files);
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
 * the literal facet text — a requirement constrains the build, it is not part of the
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
      const fallback = schema.default ? ` default ${renderPropertyValue(schema.default)}` : "";
      console.log(`  ${name.padEnd(width)}  ${type}${fallback}`);
    }
  });
  return Computable.resolve(undefined);
}

/**
 * `fabr list-properties`: print the global configuration surface — the documented
 * config properties (`BUILD_TYPE`, `JS_TARGET`, …) with their defaults, and the
 * `flag` switches (`ts/no_strict`, …). These are what you *configure*, as opposed
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
        targets: providedTargetsJson(model),
      },
      undefined,
      2
    )
  );
  return Computable.resolve(undefined);
}

/** @return the ready-made *declared* targets the loaded libraries provide — a
 * repository (`@npm`), a driver tool — with each decl's written properties, so
 * docs can reconstruct the declaration verbatim. Declaration order (like
 * targetdefs — the file's own narrative order is the documentation order).
 * Only documented ones (a doc comment is what makes a lib target part of the
 * public vocabulary rather than plumbing); `flag` targets have their own
 * section. */
function providedTargetsJson(model: BuildModel): Record<string, unknown>[] {
  return model
    .getDeclaredTargets()
    .filter(({ decl }) => decl.type !== "flag" && decl.docComment !== undefined)
    .map(({ name, decl }) => ({
      name,
      type: decl.type,
      properties: decl.properties.map(prop => ({ name: prop.name.toBaseString(), value: renderPropertyValue(prop) })),
      location: formatDeclLocation(decl),
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

/** One entry of the config listing (a documented global property, or a flag
 * target — which has no value of its own). Typed rather than a bare JSON
 * record because the same entries are also printed as text: an untyped field
 * interpolates whatever it happens to hold. */
interface IConfigEntry {
  name: string;
  location: string;
  description: string | null;
}

/** @return the documented global configuration properties (`BUILD_TYPE`,
 * `JS_TARGET`, `TSC`, …) — only those carrying a doc comment, each with its
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
function reportTestResults(log: Log, names: string[], results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map(sources => getTestReport(sources)),
    (...reports) => {
      reports.forEach((report, i) => {
        log.log(DIAG_TEST_RESULT, { name: names[i], summary: report ? formatTestSummary(report) : "no tests" });
      });
    }
  );
}
