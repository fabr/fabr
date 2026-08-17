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
import { Writable } from "stream";
import { getSystemErrorMap } from "util";
import type { IOutputHandle } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { ExecutionError } from "../core/Errors";
import { FileSet, IFile } from "../core/FileSet";
import { Semaphore } from "./Semaphore";
import type { TaskProgress, TaskState } from "../model/BuildEvents";

/**
 * Where a running process's output goes, one complete line at a time — the
 * live alternative to capturing it and reporting it only on failure. A step is
 * given one by the framework, and it is the *driver* that implements it, which
 * is what keeps attribution (prefixing each line with the target it came from)
 * a rendering decision rather than something the execution layer has to know.
 */
export interface IOutputSink {
  /** One complete line of the child's output, newline already stripped. */
  line(text: string): void;
}

/**
 * Where one process execution is in the machine-wide funnel: `queued` waiting
 * for a slot, `started` holding one, `finished` having given it back.
 *
 * Reported per *execution*, not per step, because a step may run many at once
 * (the per-file test fan-out) — so whoever displays it counts, rather than
 * being told a state that the last execution to finish would wrongly clear.
 */
export type ExecutionPhase = "queued" | "started" | "finished";

/**
 * Derive a task's {@link TaskState} from its executions' phases, calling
 * `onState` on each change. Counted rather than assigned because a step may
 * run several executions at once — the first to finish must not clear a state
 * the others still hold.
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
    /* Blocked only while everything it wants is queued: one admitted piece
     * running is the work running, however much else is behind it. */
    const state: TaskState = running === 0 && queued > 0 ? "waiting" : "running";
    if (state !== reported) {
      reported = state;
      onState(state);
    }
  };
}

/**
 * How a task reports itself to the build-event stream, handed to the code
 * performing it by ExecutionContext.runTask. Display only: nothing here
 * reaches the cache key, the command, or the outcome.
 */
export interface ITaskReport {
  /** Where output goes, line by line; absent ⇒ captured, shown only on failure
   *  — the one optional channel, its absence being the display decision. */
  output?: IOutputSink;
  /** Where each execution's funnel phases go. */
  activity: (phase: ExecutionPhase) => void;
  /** Where the work says how far along it is. Callable as often as it likes:
   *  a listener keeps the latest and displays it on its own schedule. */
  progress: (progress: TaskProgress) => void;
}

/** The report for work nobody observes — a unit test's stand-in. */
export const SILENT_REPORT: ITaskReport = { activity: () => undefined, progress: () => undefined };

/** Brackets a unit of work as a reported task — the shape of a partially
 *  applied ExecutionContext.runTask, for a layer that must apply the caller's
 *  bracketing around work whose timing only it knows (the cache around an
 *  actual transfer). */
export type TaskTracker<T> = (run: (report: ITaskReport) => Computable<T>) => Computable<T>;

/**
 * Split a byte stream into lines for a sink: a partial line is held until its
 * newline arrives, `\r\n` is normalized, a bare `\r` (a tool repainting one
 * line) also ends a line — except a chunk-final `\r`, held back in case it is
 * half of a split `\r\n` — and the unterminated tail is flushed at stream end.
 */
export function lineSplitter(sink: IOutputSink): { push(chunk: Uint8Array): void; flush(): void } {
  let held = "";
  return {
    push(chunk: Uint8Array): void {
      held += Buffer.from(chunk).toString("utf8");
      /* Hold a trailing \r back from the split (see above); it rejoins the
       * remainder so the next chunk (or flush) sees it in context. */
      const splittable = held.endsWith("\r") ? held.slice(0, -1) : held;
      const carried = held.slice(splittable.length);
      const lines = splittable.split(/\r\n|\n|\r/);
      /* The last element is the unterminated remainder (empty if the chunk
       * ended exactly on a newline) — hold it for the next chunk. */
      held = (lines.pop() ?? "") + carried;
      lines.forEach(line => sink.line(line));
    },
    flush(): void {
      if (held.length > 0) {
        /* A held trailing \r was a line ending after all — just one that never
         * got its \n. It terminates the line rather than appearing in it. */
        sink.line(held.endsWith("\r") ? held.slice(0, -1) : held);
        held = "";
      }
    },
  };
}

/**
 * @return a human-readable description of an OS-level error, without the errno
 * code or syscall noise (e.g. "no such file or directory" rather than
 * "spawn ... ENOENT") — libuv's strerror, via util.getSystemErrorMap. Falls
 * back to the error's own message for anything unrecognized.
 */
export function systemErrorText(err: unknown): string {
  const sys = err as Partial<NodeJS.ErrnoException>;
  if (typeof sys.errno === "number") {
    const entry = getSystemErrorMap().get(sys.errno);
    if (entry) {
      return entry[1];
    }
  }
  /* HACK: the map is keyed by libuv's negative errnos, but Node's C++ fs.rm
   * implementation (v23+) throws with the raw *positive* POSIX errno and a
   * nonstandard message (nodejs/node#57095 area), so the lookup above misses.
   * The `code` name is still correct on those errors — match on it instead. */
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
 * As systemErrorText, but naming the file the operation failed on where known.
 */
export function describeSystemError(err: unknown): string {
  const text = systemErrorText(err);
  const sys = err as Partial<NodeJS.ErrnoException> & { dest?: string };
  const target = typeof sys.errno === "number" ? sys.dest ?? sys.path : undefined;
  return target ? `${text}: ${target}` : text;
}

/**
 * Locate an executable. A name with a path separator is used directly (as a
 * shell does — a command containing a slash is not PATH-searched), which also
 * lets a caller resolve a specific binary by absolute path without any PATH.
 * A bare name is searched on the PATH environment variable. Note the PATH
 * search is a short-term measure (the result is an untracked input from the
 * environment) until runtimes are modelled as proper dependencies.
 * @throws ExecutionError if the executable cannot be found.
 */
export function findExecutable(name: string): string {
  if (path.basename(name) !== name) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      if (fs.statSync(name).isFile()) {
        return name;
      }
    } catch {
      /* fall through to the error */
    }
    throw new ExecutionError(`'${name}' is not an executable file`);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* Not here; keep looking */
    }
  }
  throw new ExecutionError(`Unable to find '${name}' in PATH`);
}

/**
 * Build steps run in **driver-owned process groups** (POSIX; Windows keeps the
 * plain spawn): each step's process is spawned detached, leading its own group,
 * and when it exits the group is swept — SIGTERM immediately (a straggler that
 * cleans its own children on TERM, like a supervised watcher, gets to), SIGKILL
 * after a grace. This makes the step boundary a real containment boundary: fabr
 * must not rely on the tools — or a test suite's code — being well behaved, and
 * anything a step leaves running would otherwise leak as an orphan (and, by
 * holding the step's output pipes open, could hang the build waiting for a
 * stream close that never comes; the sweep is what forces those pipes shut).
 * Only a child that starts its *own* session escapes the sweep — the TERM'd
 * parent cleaning up behind itself is the recovery there.
 *
 * Because a detached step no longer sits in the terminal's foreground group,
 * Ctrl-C stops reaching it directly — the driver compensates by routing its own
 * termination signals through `process.exit`, which fires {@link sweepAllGroups}
 * from the exit hook installed here.
 *
 * The sweep signals the group by the (exited) leader's pid; POSIX keeps that
 * pgid reserved while any member survives, so the signal is precise whenever
 * there is anything to kill. An *empty* group has dissolved and the sweep gets
 * ESRCH — with a theoretical pid-reuse window between dissolve and sweep that
 * is accepted (microseconds against a full pid-space cycle).
 */
const GROUPS_SUPPORTED = process.platform !== "win32";

/** Grace between the sweep's SIGTERM and its SIGKILL escalation — long enough
 * for a straggler to tear down its own children, short enough not to dawdle. */
const SWEEP_KILL_GRACE_MS = 5000;

/** How often a sweep re-checks whether the TERM'd group has drained, so a straggler
 * that honours TERM costs one interval rather than the whole grace. */
const SWEEP_POLL_MS = 25;

/** Group leaders of in-flight steps (and of sweeps still in their KILL grace),
 * so the exit hook can sweep whatever is live when fabr itself dies. */
const liveGroups = new Set<number>();
let exitSweepInstalled = false;

/** Register a just-spawned step leader for the exit sweep. */
function trackGroup(pid: number | undefined): void {
  if (!GROUPS_SUPPORTED || pid === undefined) {
    return;
  }
  if (!exitSweepInstalled) {
    exitSweepInstalled = true;
    /* Fabr is dying: no grace — guaranteeing no orphans outranks giving a
     * straggler a graceful window (same rationale as the run supervisor). */
    process.on("exit", killLiveChildren);
  }
  liveGroups.add(pid);
}

/**
 * Synchronously SIGKILL everything fabr spawned that is still alive — the
 * detached step groups and the interactive child. Exit-hook duty only: the
 * hooks installed here use it as the last-resort sweep, and Staging's temp-tree
 * hook calls it BEFORE removing the trees those processes run in (exit hooks
 * run in registration order, and the temp-tree hook registers first) — so a
 * child is never left running over a deleted install. Idempotent; never throws.
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
      /* Already gone — the desired end state. */
    }
  }
}

/** Whether any member of `pid`'s group is still alive — signal 0 probes without
 * delivering, so ESRCH means the group has dissolved. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The step's own process exited — sweep its group for stragglers, resolving once the
 * group is gone.
 *
 * The result is awaited before the step settles, so a straggler cannot still be writing
 * into the work dir when it is reclaimed. That matters only for a straggler which does
 * NOT hold the step's stdio: one that does keeps `close` from firing (see execute), so
 * the settle already waits for it, whereas one that redirected its output lets `close`
 * fire at once — and the reclaim would then race its writes, leaving debris below a tree
 * the exit hook has already forgotten.
 *
 * The happy case costs nothing: an empty group gives ESRCH on the first signal and the
 * result is already settled, so the caller consumes it in line.
 */
function sweepGroup(pid: number | undefined): Computable<void> {
  if (!GROUPS_SUPPORTED || pid === undefined) {
    return Computable.resolve<void>(undefined);
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* ESRCH: the group dissolved with the leader — the common, clean case. */
    liveGroups.delete(pid);
    return Computable.resolve<void>(undefined);
  }
  /* Something survived the step. TERM was just delivered; poll until the group drains,
   * escalating to KILL at the grace (a natively-wedged process handles no signal but
   * KILL). The timers are deliberately NOT unref'd — the step's outcome now waits on
   * this, so it must hold the loop open. The group stays registered throughout, so a
   * concurrent fabr exit still KILLs it via the exit hook. */
  return Computable.fromOnce<void>(resolve => {
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

/** Spawn options putting a step in its own group where supported. */
const DETACHED = GROUPS_SUPPORTED ? { detached: true } : {};

/**
 * Ask tools to keep their color/formatting: set unconditionally so a step's
 * environment stays deterministic — never conditioned on the driver's terminal
 * (a step's inputs, and thus its cache key, must not depend on it). When output
 * is captured (quiet), the driver strips the codes at render time if its own
 * output isn't a TTY; when inherited (live), the child writes straight to fabr's
 * stderr and the codes stand as-is. A caller's own env entries win.
 */
const FORCE_COLOR_ENV = { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" };

/** The `$ cmd args…` line shown at the head of an execution error, args quoted
 * where they wouldn't survive a shell round-trip. */
function commandLine(cmd: string, args: string[]): string {
  return "$ " + [cmd, ...args].map(quoteArg).join(" ");
}

/**
 * Run one command through the given execution funnel (a build step passes
 * `IActionContext.processLimit`): the slot is acquired around exactly the
 * process lifetime, so boundedness is enforced by this signature — there is no
 * unbounded way to run a build process. The interactive spawns below take no
 * limit, deliberately: the user's foreground program is not build parallelism.
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
    /* A synchronous throw must still report `finished`, or the task looks
     * running forever (the Semaphore turns the throw into a rejection). */
    try {
      return work().finally(() => report.activity("finished"));
    } catch (err) {
      report.activity("finished");
      throw err;
    }
  });
}

function executeUnbounded(cmd: string, args: string[], cwd: string, env: Record<string, string>, sink?: IOutputSink): Computable<void> {
  /* A failed spawn emits 'error' then a spurious 'close' (code -2): Computable.fromOnce
   * keeps the first (informative ENOENT) rejection and drops the useless "-2". */
  return Computable.fromOnce((resolve, reject) => {
    const line = commandLine(cmd, args);
    /* stdin from /dev/null ("ignore"), not the default open pipe: a build step is
     * non-interactive, so a tool that reads stdin must get EOF at once rather than
     * blocking forever on input the parent never sends. Both output streams are
     * always PIPED — fabr is the pump either way — and the two modes differ only
     * in what it does with the bytes: with a `sink` they are split into lines and
     * forwarded live (so the driver can attribute each line to this step and keep
     * its own terminal display coherent); without one they are captured and shown
     * only if the step fails (`-q`). Nothing is ever inherited: a child writing
     * straight to fd 2 could not be attributed, and would scribble through
     * whatever the driver is painting. Everything lands on *stderr*, never
     * stdout: fabr's stdout is reserved for its own data (cat/ls), and a genrule
     * runs during those too. The environment (color forced) is the same either
     * way — deterministic, and both a captured and a streamed failure read well
     * on a TTY. */
    const output: Uint8Array[] = [];
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
    const proc = spawn(cmd, args, { cwd, env: { ...FORCE_COLOR_ENV, ...env }, stdio, windowsHide: true, ...DETACHED });
    trackGroup(proc.pid);
    /* Sweep on 'exit', not 'close': a straggler holding the step's output pipes
     * open is exactly what keeps 'close' from ever firing — the sweep is what
     * unblocks it (killed stragglers drop the pipes, 'close' follows, settle).
     * Held so 'close' can wait for it (already settled in the common case — see
     * sweepGroup); starts settled for a step that never reaches 'exit' at all. */
    let swept: Computable<void> = Computable.resolve<void>(undefined);
    proc.on("exit", () => {
      swept = sweepGroup(proc.pid);
    });
    /* One splitter for both streams, so a tool writing to each keeps its lines
     * in arrival order rather than interleaved mid-line. */
    const lines = sink && lineSplitter(sink);
    const consume = (data: Uint8Array): void => (lines ? lines.push(data) : void output.push(data));
    proc.stdout?.on("data", consume);
    proc.stderr?.on("data", consume);
    /* Failure to spawn at all (e.g. missing executable) is reported through
     * the 'error' event; without a handler it would crash the process. */
    proc.on("error", err => {
      reject(new ExecutionError(`${line}\nunable to execute: ${systemErrorText(err)}`));
    });
    /* Failures report the command line, then (captured only) the output, then
     * how it ended; streamed output has already reached the terminal live. */
    proc.on("close", (code, signal) => {
      /* Whatever the tool left unterminated is still its output, and a tool
       * that dies mid-line is exactly when it matters most. */
      lines?.flush();
      const how = signal ? `terminated by signal ${signal}` : code !== 0 ? `exited with error code ${code}` : undefined;
      const deliver = (): void => {
        if (how === undefined) {
          resolve();
        } else {
          reject(new ExecutionError(lines ? `${line}\n${how}` : withOutput(line, output, how)));
        }
      };
      /* Report only once the group is gone, so whoever reclaims the work dir on this
       * outcome cannot race a straggler still writing into it (see sweepGroup). Both
       * arms deliver the step's own outcome: a sweep cannot fail, and if one somehow
       * did, that is no reason to lose the result. */
      swept.once(deliver, deliver);
    });
  });
}

/** The output streams a pipeline stage captures as content, each named by the
 * content its bytes become. `both` merges stdout and stderr in arrival order
 * (the `&>` redirect); `stdout`/`stderr` collect each separately. A name being
 * present is the signal to capture that stream (capturing stdout is only valid
 * on the final stage — an earlier stage's stdout feeds the pipe). Shared by the
 * resolved rule stage ({@link ResolvedCommandStage}) and the run spec. */
export interface StageStreams {
  stdout?: string;
  stderr?: string;
  both?: string;
}

/** One stage of an {@link executePipeline}: the resolved argv to run plus the
 * streams it captures. The whole pipeline shares one cwd and the head stage's
 * stdin, passed to executePipeline directly rather than repeated per stage. */
export interface StageSpec extends StageStreams {
  argv: string[];
}

function stageCommandLine(spec: StageSpec): string {
  return commandLine(spec.argv[0], spec.argv.slice(1));
}

/** A capture in flight: the redirect target `name` and the store-write `handle`
 * its stream(s) are piped into. */
interface Capture {
  name: string;
  handle: IOutputHandle;
}

/**
 * Run a pipeline of stages as concurrent child processes in `cwd`, stdout→stdin
 * wired between consecutive stages, the head fed `stdin` (if any), and stream
 * each captured redirect straight into the content store via `createOutput`.
 * Clean environment (no FORCE_COLOR — captured content must be the tool's raw
 * bytes, not ANSI). Fails on the first stage to exit non-zero or by signal
 * (pipefail): a redirected stderr is the *user's* stream, so only an
 * un-redirected stage's stderr is buffered (small) to report on failure. On
 * success resolves a FileSet of the captured content, each file named by its
 * redirect target; on failure every in-flight capture is discarded (nothing
 * enters the store). A single-stage pipeline is the ordinary "run one command
 * and capture its output" case.
 */
/* The pipeline takes ONE slot of the funnel for all its stages: they are
 * pipe-wired and must co-run — admitting them separately could wedge a stage
 * behind its own reader. Bounded by signature, like `execute`. */
export function executePipeline(
  limit: Semaphore,
  specs: StageSpec[],
  cwd: string,
  createOutput: () => IOutputHandle,
  stdin: Uint8Array | undefined,
  report: ITaskReport
): Computable<FileSet> {
  return admitted(limit, report, () => pipelineUnbounded(specs, cwd, createOutput, stdin, report.output));
}

function pipelineUnbounded(
  specs: StageSpec[],
  cwd: string,
  createOutput: () => IOutputHandle,
  stdin: Uint8Array | undefined,
  sink: IOutputSink | undefined
): Computable<FileSet> {
  const captures: Capture[] = [];
  return Computable.fromOnce<void>((resolve, reject) => {
    /* Resolve every command to an executable up front, so a bad one rejects
     * before any process is spawned (rather than leaving a half-built pipeline).
     * The failure is framed like a spawn 'error' below ("unable to execute"). */
    const argvs: string[][] = [];
    for (const spec of specs) {
      try {
        argvs.push([findExecutable(spec.argv[0]), ...spec.argv.slice(1)]);
      } catch (e) {
        return reject(new ExecutionError(`${stageCommandLine(spec)}\nunable to execute: ${systemErrorText(e)}`));
      }
    }
    const procs: ChildProcess[] = [];
    /* Un-redirected stderr only — a stage that captures stderr sends it to a
     * handle, so there is nothing here to report on that stage's failure. */
    const stderr: Uint8Array[][] = specs.map(() => []);
    /* One line splitter per stage (feeding the shared sink), so two stages
     * writing at once can't interleave mid-line. Absent ⇒ buffering instead. */
    const stageLines = specs.map(() => sink && lineSplitter(sink));
    const exit: Array<number | string | undefined> = specs.map(() => undefined);
    let settled = false;
    let remaining = specs.length;

    /* Pipefail teardown kills each stage's whole GROUP (the stages are group
     * leaders now), so a driver that doesn't forward signals to its own children
     * no longer leaves them briefly orphaned. An exited stage is signalled too:
     * its own sweep may still be within its KILL grace, and a dissolved group is
     * a swallowed ESRCH. */
    const killAll = (): void => procs.forEach(p => killProcessGroup(p, "SIGTERM"));
    /* The sweeps of stages that have exited. Deliberately only the *started* ones: a
     * stage still running is TERM'd by killAll and left to the exit hook exactly as
     * before, since waiting on a process that may never exit would trade debris for a
     * hang. Empty or already-settled ⇒ the outcome is delivered in line. */
    const sweeps: Computable<void>[] = [];
    const afterSweeps = (deliver: () => void): void => {
      Computable.forAll(sweeps.slice(), () => undefined).once(deliver, deliver);
    };
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        killAll();
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
     * disk error opening a capture) fails the whole run, discarding any
     * captures already opened rather than leaking them and stalling. */
    try {
      specs.forEach((spec, i) => {
        const isLast = i === specs.length - 1;
        const capBoth = spec.both !== undefined;
        const capStdout = spec.stdout !== undefined || capBoth;
        /* stdin: first stage from supplied bytes (else EOF); a later stage reads the
         * previous stage's stdout (wired below). Every stream fabr looks at is
         * PIPED — captured as content, feeding the next stage, streamed to the
         * sink, or buffered to report on failure. The one stream nobody wants is a
         * final un-redirected stdout with no sink, which is discarded unread. Env
         * stays clean ({}) throughout: captured content must be raw. */
        const stdinCfg = i === 0 ? (stdin ? "pipe" : "ignore") : "pipe";
        const stdoutCfg = capStdout || !isLast || sink ? "pipe" : "ignore";
        const stderrCfg = "pipe";
        const proc = spawn(argvs[i][0], argvs[i].slice(1), {
          cwd,
          env: {},
          stdio: [stdinCfg, stdoutCfg, stderrCfg],
          windowsHide: true,
          ...DETACHED,
        });
        trackGroup(proc.pid);
        proc.on("exit", () => sweeps.push(sweepGroup(proc.pid)));
        procs.push(proc);
        /* Swallow stream errors on the stdio fabr wires up: when a downstream
         * stage exits before draining its input (the SIGPIPE case, `… | head`),
         * writing to its closed stdin — or the head stage's stdin write below —
         * emits EPIPE, which Node escalates to an uncaught exception (killing the
         * whole process) if unhandled. The stage's exit code is the real failure
         * signal (pipefail, in finish()); a broken pipe is not our error. */
        proc.stdin?.on("error", () => undefined);
        proc.stdout?.on("error", () => undefined);
        /* Captures stream into store handles (piped with `{ end: false }` — the
         * handle is ended by finalize, not by the source). `&>` merges stdout and
         * stderr, chunk-interleaved, into one handle. */
        if (capBoth) {
          const merged = capture(spec.both!);
          proc.stdout?.pipe(merged, { end: false });
          proc.stderr?.pipe(merged, { end: false });
        } else {
          if (spec.stdout !== undefined) {
            proc.stdout?.pipe(capture(spec.stdout), { end: false });
          }
          if (spec.stderr !== undefined) {
            proc.stderr?.pipe(capture(spec.stderr), { end: false });
          } else {
            /* Un-redirected stderr: the user's own stream — streamed live to the
             * sink, or buffered (small) to report on this stage's failure. */
            const lines = stageLines[i];
            proc.stderr?.on("data", data => (lines ? lines.push(data) : void stderr[i].push(data)));
          }
        }
        /* A final un-redirected stdout is the pipeline's own output: with a sink
         * it streams live like stderr; without one it was never piped at all. */
        if (isLast && !capStdout && sink) {
          proc.stdout?.on("data", data => stageLines[i]?.push(data));
        }
        proc.on("error", e => fail(new ExecutionError(`${stageCommandLine(spec)}\nunable to execute: ${systemErrorText(e)}`)));
        proc.on("close", (code, signal) => {
          exit[i] = signal ?? code ?? 0;
          stageLines[i]?.flush();
          /* Propagate a broken pipe upstream (SIGPIPE-equivalent): if this stage
           * exited while its producer is still writing, close fabr's read end of
           * the producer's stdout so the producer's next write fails, rather than
           * leaving it blocked forever on a pipe nobody drains (a hung pipeline). */
          if (i > 0) {
            procs[i - 1].stdout?.destroy();
          }
          if (--remaining === 0 && !settled) {
            finish();
          }
        });
      });

      /* Wire the pipes (previous stdout → next stdin) and feed the head's stdin. */
      for (let i = 1; i < procs.length; i++) {
        procs[i - 1].stdout?.pipe(procs[i].stdin!);
      }
      if (stdin && procs[0].stdin) {
        procs[0].stdin.write(stdin);
        procs[0].stdin.end();
      }
    } catch (e) {
      fail(e instanceof Error ? e : new ExecutionError(String(e)));
      return;
    }

    const finish = (): void => {
      /* pipefail: report the earliest stage that failed (discarding captures). */
      for (let i = 0; i < specs.length; i++) {
        const status = exit[i];
        if (typeof status === "string") {
          return fail(new ExecutionError(withOutput(stageCommandLine(specs[i]), stderr[i], `terminated by signal ${status}`)));
        }
        if (typeof status === "number" && status !== 0) {
          return fail(new ExecutionError(withOutput(stageCommandLine(specs[i]), stderr[i], `exited with error code ${status}`)));
        }
      }
      settled = true;
      afterSweeps(() => resolve());
    };
  }).then(() => finalizeCaptures(captures));
}

/** Place every finished capture in the store and gather them as a FileSet, each
 * file named by its redirect target. */
function finalizeCaptures(captures: Capture[]): Computable<FileSet> {
  if (captures.length === 0) {
    return Computable.resolve(new FileSet(new Map()));
  }
  return Computable.forAll(
    captures.map(c => c.handle.finalize(c.name).then(file => [c.name, file] as [string, IFile])),
    (...entries: [string, IFile][]) => new FileSet(new Map(entries))
  );
}

/** The interactive program currently running in fabr's own stdio (a one-shot
 * `fabr run`, a `fabr shell`), if any. Tracked because fabr's death must not
 * leave it behind: it is deliberately NOT detached (see
 * {@link executeInteractive}), so a signal directed at fabr alone — a CI job or
 * a supervisor stopping the run, the ordinary way to stop a running program —
 * never reaches it on its own. */
let interactiveChild: ChildProcess | undefined;
/** Whether the live interactive child has already been offered a termination
 * signal, so a second one escalates (fabr exits, the hook kills the child)
 * instead of waiting again on a program that is ignoring signals. */
let interactiveSignalled = false;
let interactiveExitHookInstalled = false;

/** Take ownership of the interactive child for the duration of its run. */
function trackInteractive(child: ChildProcess): void {
  if (!interactiveExitHookInstalled) {
    interactiveExitHookInstalled = true;
    /* Fabr is leaving: the program it launched goes with it. Hard (SIGKILL) and
     * synchronous because an exit hook can neither wait nor escalate — the same
     * rationale as the run supervisor's stop, and the reason the signal path
     * below gives the program its graceful window *before* fabr exits. By pid,
     * not by group: this child shares fabr's own process group (it must, to stay
     * in the terminal's foreground and read stdin), so the group form would
     * signal fabr itself; a program that forks its own workers is supervised by
     * `fabr run -w`, which does spawn a group leader. */
    process.on("exit", () => {
      const child = interactiveChild;
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* Already gone — the desired end state. */
        }
      }
    });
  }
  interactiveChild = child;
  interactiveSignalled = false;
}

/** Release it once it has ended, so nothing later signals a recycled pid. */
function releaseInteractive(child: ChildProcess): void {
  if (interactiveChild === child) {
    interactiveChild = undefined;
    interactiveSignalled = false;
  }
}

/**
 * Offer a termination signal to the running interactive program. `true` means it
 * took it: the caller (the driver's signal handler) should then let the program
 * end the run in its own time — its exit resolves {@link executeInteractive} with
 * 128+signal, and the ordinary path releases the staged install and exits with
 * that status. `false` — no interactive program, or it has already been given one
 * — leaves the caller to exit immediately, the exit hooks killing what is left;
 * so a second Ctrl-C (or TERM) always forces the issue.
 *
 * The signal is only *forwarded* when fabr has no terminal of its own. With one,
 * fabr and the child share the foreground process group and the terminal already
 * delivered the Ctrl-C to both, so forwarding would double-signal the program —
 * and a second SIGINT means "quit now" to plenty of them (a REPL, a dev server).
 * Without a terminal (CI, a supervisor) the signal was directed at fabr alone and
 * the program would otherwise never hear it.
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
      /* Already gone; its exit is on its way. */
    }
  }
  return true;
}

/** Whether fabr is attached to a terminal on any of its own standard streams —
 * i.e. whether a Ctrl-C at that terminal reached the foreground group as a
 * whole, this process included. */
function hasTerminal(): boolean {
  return process.stdin.isTTY === true || process.stdout.isTTY === true || process.stderr.isTTY === true;
}

/**
 * Run a command interactively: the child inherits this process's stdio (tty,
 * pipes, stdin) and environment, and its outcome resolves as *data* — a program
 * may legitimately exit non-zero, unlike `execute`, which fails the build on a
 * non-zero exit. A program killed by a signal resolves as the shell's own
 * 128+signal rather than failing: being stopped is a way to end a run, not a
 * build error (and stopping fabr stops the program — see
 * {@link signalInteractiveChild}). Rejects only when the process cannot be
 * spawned at all. This is the launch behind `fabr run`. `cwd` overrides
 * the inherited working directory — an install-anchored runnable (`launchCwd
 * === "install"`) launches at its staged root rather than the caller's cwd.
 * `env` (when given) REPLACES the inherited environment — `fabr shell` passes the
 * build step's own (clean) env so the sandbox matches what the build runs under;
 * omitted, the child inherits this process's env (the `fabr run` case).
 */
export function executeInteractive(
  cmd: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>
): Computable<number> {
  /* A failed spawn emits 'error' then 'close': Computable.fromOnce keeps the informative
   * rejection and stops 'close' flipping a settled failure into a success. */
  return Computable.fromOnce((resolve, reject) => {
    const line = commandLine(cmd, args);
    const proc = spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd, env });
    trackInteractive(proc);
    proc.on("error", e => {
      releaseInteractive(proc);
      reject(new ExecutionError(`${line}\nunable to execute: ${systemErrorText(e)}`));
    });
    proc.on("close", (code, signal) => {
      releaseInteractive(proc);
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 0);
    });
  });
}

/**
 * Spawn an interactive child (inherited stdio) and return the live handle, for a
 * caller that must manage its lifecycle — kill it, restart it, watch for its
 * exit — rather than merely await it. This is the supervised counterpart of
 * {@link executeInteractive} (the one-shot form that resolves on exit); it backs
 * `fabr run -w`, where a source change relaunches the program. All process
 * spawning stays centralized here.
 *
 * Spawned **detached**, so the child leads its own process group: a launched
 * program that forks its own workers (every real dev server does) puts them in
 * that group, and {@link killProcessGroup} then tears the whole tree down as a
 * unit rather than orphaning the workers. (The child is *not* unref'd — the
 * supervisor still tracks it and waits on its exit.) One consequence of the new
 * session: the controlling terminal no longer delivers Ctrl-C straight to the
 * child — only fabr receives it, and the supervisor forwards it to the group,
 * which is exactly the supervision we want.
 */
export function spawnInteractive(cmd: string, args: string[], cwd?: string): ChildProcess {
  return spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd, detached: true });
}

/**
 * Signal a detached child's whole process **group** (the negative-pid form), so a
 * launched program that forked its own workers is torn down as a unit instead of
 * leaving orphans behind. Only meaningful for a group leader — a child spawned by
 * {@link spawnInteractive}, or a build-step/pipeline-stage process (all spawned
 * detached; see the group-ownership note above). ESRCH — the group is already
 * gone — is swallowed, since "not running" is precisely the goal.
 *
 * The target is the **group**, which outlives its leader, so an already-exited
 * child is signalled all the same: its surviving workers are exactly what a
 * SIGKILL escalation is for. POSIX reserves the pgid while any member survives,
 * so the signal is precise whenever there is anything to kill; an empty group
 * has dissolved and yields ESRCH, with the same theoretical pid-reuse window
 * {@link sweepGroup} accepts.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* ESRCH: the group already exited — the desired end state, nothing to do. */
  }
}

/** Quote an argument for display where it wouldn't survive a shell round-trip */
function quoteArg(arg: string): string {
  return arg.length > 0 && !/[\s'"$\\`*?[\]{}()<>|&;#~!]/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function withOutput(commandLine: string, output: Uint8Array[], result: string): string {
  const text = Buffer.concat(output).toString().trimEnd();
  return text.length > 0 ? `${commandLine}\n${text}\n${result}` : `${commandLine}\n${result}`;
}
