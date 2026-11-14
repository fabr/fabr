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

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable, Writable } from "stream";
import { StringDecoder } from "string_decoder";
import { getSystemErrorMap } from "util";
import { Computable } from "../core/Computable";
import { CommandFailedError, ExecutionError, FabrError, ICommandOutputLine } from "../core/Errors";
import { FileSet, IFile } from "../core/FileSet";
import { Semaphore } from "./Semaphore";
import type { TaskProgress, TaskState } from "./Tasks";

/**
 * The stream of a child's that a line arrived on. It is not a severity: tools
 * disagree about which stream a diagnostic belongs on (tsc writes its errors
 * to stdout), so don't treat either one as the error stream.
 */
export type OutputStream = "out" | "err";

/** A line-based output sink for process output. */
export interface IOutputSink {
  /** One complete line of the child's output, newline already stripped. */
  line(text: string, stream: OutputStream): void;
}

/**
 * A stream that writes its bytes into the content store, hashing them as they
 * are written.
 */
export interface IOutputHandle {
  /** Pipe into this with `{ end: false }`: the handle is ended by
   * {@link finalize} or {@link discard}, not by the source. */
  readonly stream: Writable;
  /** End and flush the stream, store the bytes under their hash, and return a
   * cache-backed file named `name`. `mode` is the file's permission bits
   * (default non-executable). */
  finalize(name: string, mode?: number): Computable<IFile>;
  /** Abandon the stream and delete its temp file, so nothing enters the store.
   * Settles once nothing of the output is left; on a synchronous error path
   * the caller may leave it to finish in the background. */
  discard(): Computable<void>;
}

/**
 * The state of one process execution in the execution funnel: `queued` waiting
 * for a slot, `started` holding one, `finished` having given it back. Reported
 * per execution; a step may run several at once.
 */
export type ExecutionPhase = "queued" | "started" | "finished";

/**
 * Make a listener for a task's execution phases that derives the task's
 * {@link TaskState} and calls `onState` each time it changes. The task is
 * `waiting` while it has executions queued and none started, otherwise
 * `running` (its starting state, which is not reported). It counts executions,
 * so the first of several to finish does not end a state the others still hold.
 */
export function activityCounter(onState: (state: TaskState) => void): (phase: ExecutionPhase) => void {
  let queued = 0;
  let running = 0;
  let reported: TaskState = "running";
  return phase => {
    if (phase === "queued") {
      queued++;
    } else if (phase === "started") {
      queued--;
      running++;
    } else {
      running--;
    }
    /* Waiting only while everything it has asked for is queued. */
    const state: TaskState = running === 0 && queued > 0 ? "waiting" : "running";
    if (state !== reported) {
      reported = state;
      onState(state);
    }
  };
}

/**
 * The channels a task reports itself through to the build-event stream,
 * handed to the code performing it by ExecutionContext.runTask. Nothing here
 * reaches the cache key, the command, or the outcome.
 */
export interface ITaskReport {
  /** The sink for the task's output; absent, output is shown only inside a
   *  failure. */
  output?: IOutputSink;
  /** The listener for each execution's funnel phases. */
  activity: (phase: ExecutionPhase) => void;
  /** The listener for how far along the work is. Call it as often as you
   *  like: a listener keeps the latest and displays it on its own schedule. */
  progress: (progress: TaskProgress) => void;
  /** Record that the work's result is a failure though the step itself
   *  succeeded and its result stands (a red test run): the task then ends as
   *  failed, with `error` saying why. */
  fail: (error: Error) => void;
}

/** A report that discards everything, for work nobody observes (unit tests). */
export const SILENT_REPORT: ITaskReport = { activity: () => undefined, progress: () => undefined, fail: () => undefined };

/** A function that runs a unit of work as a reported task: a partially
 *  applied ExecutionContext.runTask, for a layer that knows when the work
 *  starts (the cache, around an actual transfer). */
export type TaskTracker<T> = (run: (report: ITaskReport) => Computable<T>) => Computable<T>;

/**
 * Make a line splitter for one byte stream. Each complete line is passed to
 * `emit` without its terminator; `\n`, `\r\n` and a bare `\r` (a tool
 * repainting a line) each end a line. A partial line is held until its
 * terminator arrives, a chunk-final `\r` is held in case it is half of a
 * `\r\n`, and `flush` emits whatever is left at stream end.
 *
 * Use one per stream: stdout and stderr are independent byte streams, and a
 * shared splitter would join an unfinished line on one to the next line of the
 * other.
 */
export function lineSplitter(emit: (line: string) => void): { push(chunk: Uint8Array): void; flush(): void } {
  let held = "";
  /* Keep the decoder stateful: a multi-byte UTF-8 sequence split across two
   * reads must not decode as U+FFFD. */
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk: Uint8Array): void {
      held += decoder.write(Buffer.from(chunk));
      /* Hold a trailing \r back from the split; it rejoins the remainder so
       * the next chunk (or flush) sees it in context. */
      const splittable = held.endsWith("\r") ? held.slice(0, -1) : held;
      const carried = held.slice(splittable.length);
      const lines = splittable.split(/\r\n|\n|\r/);
      /* The last element is the unterminated remainder (empty if the chunk
       * ended exactly on a newline) — hold it for the next chunk. */
      held = (lines.pop() ?? "") + carried;
      lines.forEach(emit);
    },
    flush(): void {
      held += decoder.end();
      if (held.length > 0) {
        /* A held trailing \r ends the last line. */
        emit(held.endsWith("\r") ? held.slice(0, -1) : held);
        held = "";
      }
    },
  };
}

/**
 * @return the system's description of an OS-level error, without the errno
 * code or syscall ("no such file or directory" rather than
 * "spawn ... ENOENT"), from util.getSystemErrorMap; for an error it does not
 * recognize, the error's own message.
 */
export function systemErrorText(err: unknown): string {
  const sys = err as Partial<NodeJS.ErrnoException>;
  if (typeof sys.errno === "number") {
    const entry = getSystemErrorMap().get(sys.errno);
    if (entry) {
      return entry[1];
    }
  }
  /* HACK: the map is keyed by libuv's negative errnos, but Node's fs.rm
   * (v23+) throws with the positive POSIX errno, so the lookup above misses.
   * Its `code` is still correct, so match on that. */
  if (typeof sys.code === "string") {
    for (const [name, text] of getSystemErrorMap().values()) {
      if (name === sys.code) {
        return text;
      }
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Describe an OS-level error as systemErrorText does, naming the file the
 * operation failed on where known.
 */
export function describeSystemError(err: unknown): string {
  const text = systemErrorText(err);
  const sys = err as Partial<NodeJS.ErrnoException> & { dest?: string };
  const target = typeof sys.errno === "number" ? (sys.dest ?? sys.path) : undefined;
  return target ? `${text}: ${target}` : text;
}

/** The suffix Windows looks for on a command named without one. */
const WINDOWS_EXECUTABLE_SUFFIX = ".exe";

/** @return the names `name` may be found under on `platform`: on Windows, a name with no extension also with `.exe`. */
function executableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" && path.extname(name) === "" ? [name, name + WINDOWS_EXECUTABLE_SUFFIX] : [name];
}

/** @return `candidate` if it is an executable file, otherwise undefined. */
function executableFile(candidate: string): string | undefined {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate an executable, as a shell does. A name with a path separator is used
 * directly, relative to `cwd` (the directory the command will run in), with no
 * PATH search. A bare name is searched for on the PATH environment variable;
 * what it finds (the `sh` a `script` runs on) is an input fabr does not track.
 * On Windows a name with no extension is also looked for with `.exe`.
 * @return the executable's path, absolute where `name` has a path separator.
 * @throws ExecutionError if the executable cannot be found.
 */
export function findExecutable(name: string, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): string {
  const names = executableNames(name, platform);
  if (path.basename(name) !== name) {
    for (const candidate of names) {
      const found = executableFile(path.resolve(cwd, candidate));
      if (found !== undefined) {
        return found;
      }
    }
    throw new ExecutionError(`'${name}' is not an executable file`);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const candidate of names) {
      const found = executableFile(path.join(dir, candidate));
      if (found !== undefined) {
        return found;
      }
    }
  }
  throw new ExecutionError(`Unable to find '${name}' in PATH`);
}

/**
 * True where build steps run in process groups of their own (POSIX; Windows
 * keeps the plain spawn). Each step's process is spawned detached, leading its
 * own group, and when it exits the group is swept: SIGTERM at once, SIGKILL
 * after a grace, so nothing a step leaves running outlives it (a child that
 * starts its own session escapes the sweep). A detached step is not in the
 * terminal's foreground group, so Ctrl-C does not reach it: the driver routes
 * its termination signals through `process.exit`, whose exit hook here runs
 * {@link killLiveChildren}.
 *
 * The sweep signals the group by the exited leader's pid, which POSIX keeps
 * reserved while any member survives; an empty group gives ESRCH.
 */
const GROUPS_SUPPORTED = process.platform !== "win32";

/** The grace between the sweep's SIGTERM and its SIGKILL. */
const SWEEP_KILL_GRACE_MS = 5000;

/** The interval at which a sweep checks whether the group has emptied. */
const SWEEP_POLL_MS = 25;

/** The group leaders of running steps and of sweeps still in their grace, for
 * the exit hook to kill. */
const liveGroups = new Set<number>();
let exitSweepInstalled = false;

/** Register a just-spawned step's group for the exit sweep. */
function trackGroup(pid: number | undefined): void {
  if (!GROUPS_SUPPORTED || pid === undefined) {
    return;
  }
  if (!exitSweepInstalled) {
    exitSweepInstalled = true;
    /* Fabr is exiting: no grace. */
    process.on("exit", killLiveChildren);
  }
  liveGroups.add(pid);
}

/**
 * Synchronously SIGKILL everything fabr spawned that is still alive: the step
 * groups and the interactive child. For exit hooks only: the hook installed
 * here, and Staging's temp-tree hook, which must call it before removing the
 * trees those processes run in. Idempotent; never throws.
 */
export function killLiveChildren(): void {
  for (const gid of liveGroups) {
    try {
      process.kill(-gid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  const child = interactiveChild;
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** @return true if any member of `pid`'s group is still alive, otherwise false. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweep an exited step's process group: SIGTERM whatever is left in it, then
 * SIGKILL it if it is not empty after {@link SWEEP_KILL_GRACE_MS}. Resolves
 * once the group is gone; never rejects. An empty group resolves at once,
 * already settled.
 *
 * Settle the step only after this resolves, so that a process left behind
 * cannot still be writing into the work dir when it is reclaimed.
 */
function sweepGroup(pid: number | undefined): Computable<void> {
  if (!GROUPS_SUPPORTED || pid === undefined) {
    return Computable.resolve<void>(undefined);
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* ESRCH: the group ended with its leader. */
    liveGroups.delete(pid);
    return Computable.resolve<void>(undefined);
  }
  /* Poll until the group is empty, KILLing it at the grace. Don't unref the
   * timers: the step's outcome waits on this. The group stays registered
   * meanwhile, so the exit hook still kills it if fabr exits. */
  return Computable.from<void>(resolve => {
    const deadline = Date.now() + SWEEP_KILL_GRACE_MS;
    const done = (): void => {
      liveGroups.delete(pid);
      resolve(undefined);
    };
    const poll = (): void => {
      if (!groupAlive(pid)) {
        done();
      } else if (Date.now() >= deadline) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* gone during the grace */
        }
        done();
      } else {
        setTimeout(poll, SWEEP_POLL_MS);
      }
    };
    setTimeout(poll, SWEEP_POLL_MS);
  });
}

/** The spawn options putting a step in its own group where supported. */
const DETACHED = GROUPS_SUPPORTED ? { detached: true } : {};

/**
 * The variables asking tools to keep their colour, set for every build step
 * whatever the driver's terminal (the driver strips the codes when its output
 * is not a TTY). Don't make them depend on the terminal: a step's environment
 * must not. A caller's own entries win.
 */
const FORCE_COLOR_ENV = { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" };

/** Render the `$ cmd args…` line shown at the head of an execution error, each
 * argument quoted where a shell would not read it back as written. */
function commandLine(cmd: string, args: string[]): string {
  return "$ " + [cmd, ...args].map(quoteArg).join(" ");
}

/**
 * Run one build-step command, holding a slot of the execution funnel `limit`
 * (a step passes `ActionContext.processLimit`) for the process's lifetime.
 *
 * The process runs in `cwd` with `env` plus {@link FORCE_COLOR_ENV}, stdin at
 * EOF, in a process group of its own that is swept when it exits. Its output
 * lines go to `report.output` as they arrive, where there is one.
 *
 * Resolves when the process exits with status 0 and its group is gone.
 * Rejects with a CommandFailedError (the command line, every output line in
 * arrival order, and how it ended) on a non-zero exit or a signal, and with an
 * ExecutionError where it cannot be spawned.
 */
export function execute(
  limit: Semaphore,
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  report: ITaskReport
): Computable<void> {
  return admitted(limit, report, () => executeUnbounded(cmd, args, cwd, env, report.output));
}

/**
 * Take a slot of the funnel for `work`, reporting `queued` before asking for
 * the slot and `started`/`finished` around holding it.
 */
export function admitted<T>(limit: Semaphore, report: ITaskReport, work: () => Computable<T>): Computable<T> {
  report.activity("queued");
  return limit.run(() => {
    report.activity("started");
    /* Report `finished` on a synchronous throw too, or the task looks running
     * forever (the Semaphore turns the throw into a rejection). */
    try {
      return work().finally(() => report.activity("finished"));
    } catch (err) {
      report.activity("finished");
      throw err;
    }
  });
}

function executeUnbounded(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  sink?: IOutputSink
): Computable<void> {
  /* A failed spawn emits 'error' then 'close' (code -2): Computable.from keeps
   * the first, the ENOENT rejection. */
  return Computable.from((resolve, reject) => {
    const line = commandLine(cmd, args);
    /* stdin is /dev/null, so a tool that reads it gets EOF rather than
     * blocking. Both output streams are piped and kept, merged in arrival
     * order, for a failure to report; with a `sink` they are also forwarded
     * line by line. Never inherit them, and keep the environment the same
     * whether or not there is a sink. */
    const output: ICommandOutputLine[] = [];
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
    const proc = spawn(cmd, args, { cwd, env: { ...FORCE_COLOR_ENV, ...env }, stdio, windowsHide: true, ...DETACHED });
    trackGroup(proc.pid);
    /* Sweep on 'exit', not 'close': a leftover process holding the output
     * pipes open keeps 'close' from firing until the sweep kills it. 'close'
     * waits for the sweep; `swept` starts settled for a process that never
     * reaches 'exit'. */
    let swept: Computable<void> = Computable.resolve<void>(undefined);
    proc.on("exit", () => {
      swept = sweepGroup(proc.pid);
    });
    /* A splitter per stream; the kept lines share one list, in arrival order. */
    const streams = showLines(output, sink);
    proc.stdout?.on("data", (data: Uint8Array) => streams.out.push(data));
    proc.stderr?.on("data", (data: Uint8Array) => streams.err.push(data));
    /* A failure to spawn (a missing executable) arrives as 'error'; without a
     * handler it would crash the process. */
    proc.on("error", err => {
      reject(new ExecutionError(`${line}\nunable to execute: ${systemErrorText(err)}`));
    });
    proc.on("close", (code, signal) => {
      /* Emit an unterminated last line too. */
      streams.out.flush();
      streams.err.flush();
      const how = signal ? `terminated by signal ${signal}` : code !== 0 ? `exited with error code ${code}` : undefined;
      const deliver = (): void => {
        if (how === undefined) {
          resolve();
        } else {
          reject(new CommandFailedError(line, output, how));
        }
      };
      /* Settle only once the group is gone (see sweepGroup), with the process's
       * own outcome whatever the sweep's. */
      swept.once(deliver, deliver);
    });
  });
}

/** The teardowns to run when fabr exits. */
const exitTeardowns = new Set<() => void>();
let teardownHookInstalled = false;

/**
 * Register `teardown` to run when fabr exits, for something it started that
 * the process-group sweep cannot reach (a container an engine runs).
 * `teardown` must be synchronous, since it runs from an exit hook; a throw from
 * it is ignored.
 * @return the function that unregisters it, to call once the thing is gone.
 */
export function registerExitTeardown(teardown: () => void): () => void {
  if (!teardownHookInstalled) {
    teardownHookInstalled = true;
    process.on("exit", () => {
      for (const each of exitTeardowns) {
        try {
          each();
        } catch {
          /* ignored */
        }
      }
      exitTeardowns.clear();
    });
  }
  exitTeardowns.add(teardown);
  return () => exitTeardowns.delete(teardown);
}

/** The output and exit status of a program run by {@link executeInternalCapture}. */
export interface CapturedOutput {
  /** Its exit code; null where it was ended by a signal. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a short host program whose answer fabr itself reads (a credential
 * helper), holding a slot of `limit`, with `input` on its stdin and `env` as
 * its whole environment. Its output is neither cached nor shown, and may
 * differ from one call to the next.
 *
 * Resolves with its stdout, stderr and exit status, whatever the status;
 * rejects with an ExecutionError only where it cannot be spawned.
 */
export function executeInternalCapture(
  limit: Semaphore,
  cmd: string,
  args: string[],
  input: string,
  env: Record<string, string>
): Computable<CapturedOutput> {
  return limit.run(() =>
    Computable.from<CapturedOutput>((resolve, reject) => {
      const proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      proc.stdout?.on("data", (data: Buffer) => stdout.push(data));
      proc.stderr?.on("data", (data: Buffer) => stderr.push(data));
      proc.on("error", err => reject(new ExecutionError(`${commandLine(cmd, args)}\nunable to execute: ${systemErrorText(err)}`)));
      proc.on("close", code =>
        resolve({ status: code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
      );
      /* Ignore EPIPE from a program that exits without reading its input. */
      proc.stdin?.on("error", () => undefined);
      proc.stdin?.end(input);
    })
  );
}

/**
 * The redirections of a pipeline stage's output streams. `stdout` or `stderr`
 * names the file that stream is captured as; absent, stdout goes to the next
 * stage (or, on the last stage, the pipeline's own output) and stderr is
 * shown. Only the last stage may capture stdout.
 *
 * `mergedTo` is a dup (`2>&1` is `"out"`, `1>&2` is `"err"`): both streams go
 * where the named one goes, interleaved in arrival order, captured or not
 * (`&> n` is `> n 2>&1`). The other stream then names no file of its own
 * (`mergedTo: "out"` leaves `stderr` unset, and vice versa).
 */
export interface StageStreams {
  stdout?: string;
  stderr?: string;
  mergedTo?: "out" | "err";
}

/** What the first stage of an {@link executePipeline} reads: bytes, or the stream a function makes. */
export type PipelineInput = Uint8Array | (() => Readable);

/** One stage of an {@link executePipeline}: the argv to run and its
 * redirections. */
export interface StageSpec extends StageStreams {
  argv: string[];
  /** The variables its runnable is launched with, each `NAME=value`, under the pipeline's own. */
  env?: string[];
  /** A file, relative to the pipeline's directory, the last stage's stdout is
   *  written to as it is, neither captured nor shown; with no `stdout` or
   *  `mergedTo` of its own. */
  stdoutFile?: string;
}

/** Split a `NAME=value` variable at its first `=`; an entry with none is an error. */
export function variableEntry(entry: string): [string, string] {
  const at = entry.indexOf("=");
  if (at === -1) {
    throw new FabrError(`environment entry '${entry}' is not of the form NAME=value`);
  }
  return [entry.slice(0, at), entry.slice(at + 1)];
}

function stageCommandLine(spec: StageSpec): string {
  return commandLine(spec.argv[0], spec.argv.slice(1));
}

/** A capture in progress: the file `name` and the `handle` its stream or
 * streams are piped into. */
interface Capture {
  name: string;
  handle: IOutputHandle;
}

/**
 * Run a pipeline of stages as concurrent processes in `cwd`, holding one slot
 * of `limit` for the whole pipeline. Each stage's stdout feeds the next
 * stage's stdin; the first stage reads `stdin`, or EOF where there is none:
 * bytes, or a stream made once the slot is held, which is destroyed where the
 * pipeline fails and whose own failure fails it.
 * Each capture is streamed into the content store through a handle from
 * `createOutput`. A stage's environment is its own `env` entries overlaid with
 * the pipeline's `env`, and nothing else (no {@link FORCE_COLOR_ENV}). Each
 * stage runs in a process group of its own, as `execute`'s does. Output a
 * stage does not redirect is shown through `report.output` and kept for its
 * failure report.
 *
 * Resolves, once every stage has ended, with a FileSet of the captures, each
 * file named by its redirection. Rejects (pipefail) with a CommandFailedError
 * for the first stage, in pipeline order, that exited non-zero or by signal,
 * carrying that stage's shown output; and with an ExecutionError where a
 * stage's executable cannot be found (before anything is spawned) or a stage
 * cannot be spawned. On a failure every stage's group is sent SIGTERM and
 * every capture is discarded.
 */
/* Take ONE slot for all the stages: they are pipe-wired and must run
 * together, and admitted separately a stage could wait behind its own
 * reader. */
export function executePipeline(
  limit: Semaphore,
  specs: StageSpec[],
  cwd: string,
  createOutput: () => IOutputHandle,
  stdin: PipelineInput | undefined,
  report: ITaskReport,
  env: ReadonlyMap<string, string> = new Map()
): Computable<FileSet> {
  return admitted(limit, report, () => pipelineUnbounded(specs, cwd, createOutput, stdin, report.output, env));
}

function pipelineUnbounded(
  specs: StageSpec[],
  cwd: string,
  createOutput: () => IOutputHandle,
  stdin: PipelineInput | undefined,
  sink: IOutputSink | undefined,
  env: ReadonlyMap<string, string>
): Computable<FileSet> {
  const captures: Capture[] = [];
  return Computable.from<void>((resolve, reject) => {
    /* Find every stage's executable first, so a missing one rejects before
     * any process is spawned. */
    const argvs: string[][] = [];
    for (const spec of specs) {
      try {
        argvs.push([findExecutable(spec.argv[0], cwd), ...spec.argv.slice(1)]);
      } catch (e) {
        return reject(new ExecutionError(`${stageCommandLine(spec)}\nunable to execute: ${systemErrorText(e)}`));
      }
    }
    const procs: ChildProcess[] = [];
    /* The lines each stage showed (its streams neither captured nor feeding
     * the next stage), merged in arrival order, for its failure report. */
    const shown: ICommandOutputLine[][] = specs.map(() => []);
    /* A line splitter per stage and per stream, all feeding the one sink. */
    const stageLines = shown.map(lines => showLines(lines, sink));
    const exit: Array<number | string | undefined> = specs.map(() => undefined);
    let settled = false;
    let remaining = specs.length;
    /* The first stage's input, where it is a stream. */
    let input: Readable | undefined;

    /* On failure, TERM every stage's whole group, an exited stage's included
     * (its sweep may still be in its grace). */
    const killAll = (): void => procs.forEach(p => killProcessGroup(p, "SIGTERM"));
    /* The sweeps of the stages that have exited. The outcome waits for these
     * only: a stage still running is left to killAll and the exit hook, since
     * it may never exit. */
    const sweeps: Computable<void>[] = [];
    const afterSweeps = (deliver: () => void): void => {
      Computable.forAll(sweeps.slice(), () => undefined).once(deliver, deliver);
    };
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        killAll();
        input?.destroy();
        captures.forEach(c => c.handle.discard());
        afterSweeps(() => reject(err));
      }
    };
    /* Open a capture handle for `name` and register it for finalize/discard. */
    const capture = (name: string): Writable => {
      const handle = createOutput();
      captures.push({ name, handle });
      return handle.stream;
    };

    /* Build and wire the pipeline; a synchronous failure (a bad spawn, a
     * disk error opening a capture) fails the whole run, discarding the
     * captures already opened. */
    try {
      specs.forEach((spec, i) => {
        const isLast = i === specs.length - 1;
        /* True where stdout is captured: to its own file, or by a `1>&2` into
         * stderr's. */
        const capStdout = spec.stdout !== undefined || (spec.mergedTo === "err" && spec.stderr !== undefined);
        /* The first stage reads the given bytes (else EOF); a later stage reads
         * the previous stage's output (wired below). Keep the environment to
         * the given variables, so that captured content is the tool's own
         * bytes whatever fabr was run under. */
        const stdinCfg = i === 0 ? (stdin ? "pipe" : "ignore") : "pipe";
        if (spec.stdoutFile !== undefined && (!isLast || spec.stdout !== undefined || spec.mergedTo !== undefined)) {
          throw new FabrError(`Internal error: only the last stage's own stdout can be written to a file (${stageCommandLine(spec)})`);
        }
        const stdoutCfg = spec.stdoutFile === undefined ? "pipe" : fs.openSync(path.resolve(cwd, spec.stdoutFile), "w");
        let proc: ChildProcess;
        try {
          proc = spawn(argvs[i][0], argvs[i].slice(1), {
            cwd,
            env: { ...Object.fromEntries((specs[i].env ?? []).map(variableEntry)), ...Object.fromEntries(env) },
            stdio: [stdinCfg, stdoutCfg, "pipe"],
            windowsHide: true,
            ...DETACHED,
          });
        } finally {
          /* The child holds its own copy of the descriptor. */
          if (typeof stdoutCfg === "number") {
            fs.closeSync(stdoutCfg);
          }
        }
        trackGroup(proc.pid);
        proc.on("exit", () => sweeps.push(sweepGroup(proc.pid)));
        procs.push(proc);
        /* Ignore stream errors on the stdio: when a stage exits before reading
         * all its input (`… | head`), writing to its stdin emits EPIPE, which
         * Node raises as an uncaught exception if unhandled. The stages' exit
         * statuses decide the outcome (in finish). */
        proc.stdin?.on("error", () => undefined);
        proc.stdout?.on("error", () => undefined);
        proc.stderr?.on("error", () => undefined);
        /* Pipe captures into their handles with `{ end: false }` (finalize ends
         * the handle). A dup gives both streams one handle. */
        const captureName = spec.mergedTo === "err" ? spec.stderr : spec.stdout;
        const shared = captureName !== undefined ? capture(captureName) : undefined;
        const show =
          (stream: OutputStream) =>
          (data: Uint8Array): void =>
            stageLines[i][stream].push(data);
        if (spec.mergedTo !== undefined) {
          /* Both streams go where the named one goes. For a `2>&1` that is
           * stdout's: before the last stage, the next stage (wired below, so
           * nothing attaches here); on the last stage, its capture, else shown
           * as stdout. For a `1>&2` it is stderr's: its capture, else shown;
           * the next stage, if any, reads EOF. */
          const label = spec.mergedTo;
          const merge = (stream: NodeJS.ReadableStream | null): void => {
            if (shared) {
              stream?.pipe(shared, { end: false });
            } else {
              stream?.on("data", show(label));
            }
          };
          if (spec.mergedTo !== "out" || isLast) {
            merge(proc.stdout);
            merge(proc.stderr);
          }
        } else {
          if (shared) {
            proc.stdout?.pipe(shared, { end: false });
          }
          if (spec.stderr !== undefined) {
            proc.stderr?.pipe(capture(spec.stderr), { end: false });
          } else {
            proc.stderr?.on("data", show("err"));
          }
        }
        /* The last stage's unredirected stdout is shown. Don't attach a second
         * reader where a dup already routed it above. */
        if (isLast && !capStdout && spec.mergedTo === undefined) {
          proc.stdout?.on("data", show("out"));
        }
        proc.on("error", e => fail(new ExecutionError(`${stageCommandLine(spec)}\nunable to execute: ${systemErrorText(e)}`)));
        proc.on("close", (code, signal) => {
          exit[i] = signal ?? code ?? 0;
          stageLines[i].out.flush();
          stageLines[i].err.flush();
          /* Close fabr's read end of whatever fed this stage (the previous
           * stage's stdout, and under `2>&1` its stderr), so the previous
           * stage's next write fails rather than blocking on a pipe nobody
           * reads. Under `1>&2` nothing fed it, so leave those streams open. */
          if (i > 0 && specs[i - 1].mergedTo !== "err") {
            procs[i - 1].stdout?.destroy();
            if (specs[i - 1].mergedTo === "out") {
              procs[i - 1].stderr?.destroy();
            }
          }
          if (--remaining === 0 && !settled) {
            finish();
          }
        });
      });

      /* Wire the pipes and feed the first stage's stdin. A stage reads the
       * previous stage's stdout; under that stage's `2>&1` both its streams
       * (its stdin ended once both have); under `1>&2` nothing, so EOF. */
      for (let i = 1; i < procs.length; i++) {
        const prev = procs[i - 1];
        const feeds = (
          specs[i - 1].mergedTo === "err" ? [] : specs[i - 1].mergedTo === "out" ? [prev.stdout, prev.stderr] : [prev.stdout]
        ).filter((stream): stream is NonNullable<typeof stream> => stream !== null && stream !== undefined);
        const dest = procs[i].stdin!;
        if (feeds.length === 1) {
          feeds[0].pipe(dest);
        } else if (feeds.length === 0) {
          dest.end();
        } else {
          let open = feeds.length;
          for (const stream of feeds) {
            stream.pipe(dest, { end: false });
            stream.on("end", () => --open === 0 && dest.end());
          }
        }
      }
      if (stdin && procs[0].stdin) {
        if (typeof stdin === "function") {
          input = stdin();
          input.on("error", err => fail(err));
          input.pipe(procs[0].stdin);
        } else {
          procs[0].stdin.write(stdin);
          procs[0].stdin.end();
        }
      }
    } catch (e) {
      fail(e instanceof Error ? e : new ExecutionError(String(e)));
      return;
    }

    const finish = (): void => {
      /* pipefail: fail with the first stage that failed. */
      for (let i = 0; i < specs.length; i++) {
        const status = exit[i];
        if (typeof status === "string") {
          return fail(new CommandFailedError(stageCommandLine(specs[i]), shown[i], `terminated by signal ${status}`));
        }
        if (typeof status === "number" && status !== 0) {
          return fail(new CommandFailedError(stageCommandLine(specs[i]), shown[i], `exited with error code ${status}`));
        }
      }
      settled = true;
      afterSweeps(() => resolve());
    };
  }).then(() => finalizeCaptures(captures));
}

/** Store every capture and gather them as a FileSet, each file under its
 * capture's name. */
function finalizeCaptures(captures: Capture[]): Computable<FileSet> {
  if (captures.length === 0) {
    return Computable.resolve(new FileSet(new Map()));
  }
  return Computable.forAll(
    captures.map(c => c.handle.finalize(c.name).then(file => [c.name, file] as [string, IFile])),
    (...entries: [string, IFile][]) => new FileSet(new Map(entries))
  );
}

/** The interactive program running in fabr's own stdio (a one-shot
 * `fabr run`, a `fabr shell`), if any, for the exit hook to kill. It shares
 * fabr's process group, so a signal sent to fabr alone does not reach it. */
let interactiveChild: ChildProcess | undefined;
/** True once the interactive child has been offered a termination signal. */
let interactiveSignalled = false;
let interactiveExitHookInstalled = false;

/** Record `child` as the interactive child for the duration of its run. */
function trackInteractive(child: ChildProcess): void {
  if (!interactiveExitHookInstalled) {
    interactiveExitHookInstalled = true;
    /* SIGKILL the child when fabr exits. Signal it by pid, not by group: it
     * is in fabr's own process group, so the group form would signal fabr. */
    process.on("exit", () => {
      const child = interactiveChild;
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    });
  }
  interactiveChild = child;
  interactiveSignalled = false;
}

/** Forget `child` once it has ended, so nothing later signals a reused pid. */
function releaseInteractive(child: ChildProcess): void {
  if (interactiveChild === child) {
    interactiveChild = undefined;
    interactiveSignalled = false;
  }
}

/**
 * Offer a termination signal fabr received to the running interactive program.
 * The signal is sent to the program only where fabr has no terminal; with one,
 * the terminal has already delivered it to the program too.
 * @return true if the program took it: the caller (the driver's signal
 * handler) should let the program end the run, its exit resolving
 * {@link executeInteractive} with 128+signal. false where there is no
 * interactive program or it has already been offered a signal: the caller
 * should exit at once, the exit hooks killing what is left.
 */
export function signalInteractiveChild(signal: NodeJS.Signals): boolean {
  const child = interactiveChild;
  if (!child || interactiveSignalled || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  interactiveSignalled = true;
  if (!hasTerminal()) {
    try {
      process.kill(child.pid, signal);
    } catch {
      /* already gone; its exit is on its way */
    }
  }
  return true;
}

/** @return true if any of fabr's standard streams is a terminal, otherwise
 * false. */
function hasTerminal(): boolean {
  return process.stdin.isTTY === true || process.stdout.isTTY === true || process.stderr.isTTY === true;
}

/**
 * Run a program in fabr's own stdio, in fabr's process group (the launch behind
 * `fabr run` and `fabr shell`). `cwd`, where given, replaces the working
 * directory and `env` the whole environment; otherwise both are fabr's own.
 * The program is the interactive child: killed when fabr exits, and offered
 * fabr's termination signals by {@link signalInteractiveChild}.
 *
 * Resolves with its exit status whatever it is, and with 128+signal where a
 * signal ended it, as a shell reports one. Rejects with an ExecutionError only
 * where it cannot be spawned.
 */
export function executeInteractive(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): Computable<number> {
  /* A failed spawn emits 'error' then 'close': Computable.from keeps the
   * rejection. */
  return Computable.from((resolve, reject) => {
    const line = commandLine(cmd, args);
    const proc = spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd, env });
    trackInteractive(proc);
    proc.on("error", e => {
      releaseInteractive(proc);
      reject(new ExecutionError(`${line}\nunable to execute: ${systemErrorText(e)}`));
    });
    proc.on("close", (code, signal) => {
      releaseInteractive(proc);
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0));
    });
  });
}

/**
 * Spawn a program in fabr's own stdio and return its handle, for a caller that
 * manages its lifecycle (`fabr run -w`'s supervisor, which restarts it). `cwd`
 * and `env` are as for {@link executeInteractive}.
 *
 * The program leads a process group of its own, so {@link killProcessGroup}
 * ends it with any workers it forked. It does not receive the terminal's
 * Ctrl-C; the caller must forward it. It is not tracked for the exit hook.
 */
export function spawnInteractive(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): ChildProcess {
  return spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd, env, detached: true });
}

/**
 * Send `signal` to the whole process group `child` leads: a child of
 * {@link spawnInteractive}, or a build step's or pipeline stage's process. An
 * exited child's group is signalled too, since its members may survive it.
 * A group that is already gone is ignored.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* ESRCH: the group is already gone. */
  }
}

/** Quote an argument for display where a shell would not read it back as written. */
function quoteArg(arg: string): string {
  return arg.length > 0 && !/[\s'"$\\`*?[\]{}()<>|&;#~!]/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Make a line splitter for each stream, each adding its lines to `into` (so
 * the two streams' lines are in arrival order) and passing them to `sink` where
 * there is one.
 */
function showLines(into: ICommandOutputLine[], sink: IOutputSink | undefined): Record<OutputStream, ReturnType<typeof lineSplitter>> {
  const splitter = (stream: OutputStream): ReturnType<typeof lineSplitter> =>
    lineSplitter(text => {
      into.push({ stream, text });
      sink?.line(text, stream);
    });
  return { out: splitter("out"), err: splitter("err") };
}
