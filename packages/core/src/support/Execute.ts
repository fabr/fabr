import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";
import { getSystemErrorMap } from "util";
import type { IOutputHandle } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { ExecutionError } from "../core/Errors";
import { FileSet, IFile } from "../core/FileSet";

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

export function execute(cmd: string, args: string[], cwd: string, env: Record<string, string>, quiet = true): Computable<void> {
  /* A failed spawn emits 'error' then a spurious 'close' (code -2): Computable.once
   * keeps the first (informative ENOENT) rejection and drops the useless "-2". */
  return Computable.once((resolve, reject) => {
    const line = commandLine(cmd, args);
    /* stdin from /dev/null ("ignore"), not the default open pipe: a build step is
     * non-interactive, so a tool that reads stdin must get EOF at once rather than
     * blocking forever on input the parent never sends. Then two modes for the
     * output streams: `quiet` PIPES and captures them, showing them only if the
     * step fails; otherwise the child INHERITS fabr's stderr for both (fd 2), so
     * output goes straight to the terminal, live, and a failure needn't reprint
     * what already scrolled by. Both streams go to *stderr*, never stdout: fabr's
     * stdout is reserved for its own data (cat/ls), and a genrule runs during those
     * too. The environment (color forced) is the same either way — deterministic,
     * and a captured or inherited failure reads well on a TTY. */
    const output: Uint8Array[] = [];
    const stdio: Array<"ignore" | "pipe" | number> = quiet ? ["ignore", "pipe", "pipe"] : ["ignore", 2, 2];
    const proc = spawn(cmd, args, { cwd, env: { ...FORCE_COLOR_ENV, ...env }, stdio, windowsHide: true });
    if (quiet) {
      proc.stdout?.on("data", data => output.push(data));
      proc.stderr?.on("data", data => output.push(data));
    }
    /* Failure to spawn at all (e.g. missing executable) is reported through
     * the 'error' event; without a handler it would crash the process. */
    proc.on("error", err => {
      reject(new ExecutionError(`${line}\nunable to execute: ${systemErrorText(err)}`));
    });
    /* Failures report the command line, then (quiet only) the captured output,
     * then how it ended; inherited output already reached the terminal live. */
    proc.on("close", (code, signal) => {
      const how = signal ? `terminated by signal ${signal}` : code !== 0 ? `exited with error code ${code}` : undefined;
      if (how === undefined) {
        resolve();
      } else {
        reject(new ExecutionError(quiet ? withOutput(line, output, how) : `${line}\n${how}`));
      }
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
export function executePipeline(
  specs: StageSpec[],
  cwd: string,
  createOutput: () => IOutputHandle,
  stdin?: Uint8Array,
  quiet = true
): Computable<FileSet> {
  const captures: Capture[] = [];
  return Computable.once<void>((resolve, reject) => {
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
    const exit: Array<number | string | undefined> = specs.map(() => undefined);
    let settled = false;
    let remaining = specs.length;

    const killAll = (): void => procs.forEach(p => p.kill());
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        killAll();
        captures.forEach(c => c.handle.discard());
        reject(err);
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
        const capStderr = spec.stderr !== undefined || capBoth;
        /* stdin: first stage from supplied bytes (else EOF); a later stage reads the
         * previous stage's stdout (wired below). A stream captured as content or
         * feeding the next stage is PIPED. A user-facing un-redirected stream is
         * INHERITED to fabr's stderr (fd 2, live) — or, under `quiet`, piped and
         * buffered (stderr, to report on failure) / discarded (a final stdout nobody
         * reads). Env stays clean ({}) either way: captured content must be raw. */
        const stdinCfg = i === 0 ? (stdin ? "pipe" : "ignore") : "pipe";
        const stdoutCfg = capStdout || !isLast ? "pipe" : quiet ? "ignore" : 2;
        const stderrCfg = capStderr ? "pipe" : quiet ? "pipe" : 2;
        const proc = spawn(argvs[i][0], argvs[i].slice(1), {
          cwd,
          env: {},
          stdio: [stdinCfg, stdoutCfg, stderrCfg],
          windowsHide: true,
        });
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
          } else if (quiet) {
            /* Un-redirected stderr, buffered (small) to report on failure; not
             * quiet, it was inherited to fd 2 above and there is nothing to buffer. */
            proc.stderr?.on("data", data => stderr[i].push(data));
          }
        }
        proc.on("error", e => fail(new ExecutionError(`${stageCommandLine(spec)}\nunable to execute: ${systemErrorText(e)}`)));
        proc.on("close", (code, signal) => {
          exit[i] = signal ?? code ?? 0;
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
      resolve();
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

/**
 * Run a command interactively: the child inherits this process's stdio (tty,
 * pipes, stdin) and environment, and its exit code resolves as *data* — a
 * program may legitimately exit non-zero, unlike `execute`, which fails the
 * build on a non-zero exit. Rejects only when the process cannot be spawned or
 * is killed by a signal. This is the launch behind `fabr run`. `cwd` overrides
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
  /* A failed spawn emits 'error' then 'close': Computable.once keeps the informative
   * rejection and stops 'close' flipping a settled failure into a success. */
  return Computable.once((resolve, reject) => {
    const line = commandLine(cmd, args);
    const proc = spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd, env });
    proc.on("error", e => reject(new ExecutionError(`${line}\nunable to execute: ${systemErrorText(e)}`)));
    proc.on("close", (code, signal) => {
      if (signal) {
        reject(new ExecutionError(`${line}\nterminated by signal ${signal}`));
      } else {
        resolve(code ?? 0);
      }
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
 * leaving orphans behind. Only meaningful for a child spawned by
 * {@link spawnInteractive} (a group leader). A no-op if the child never got a pid
 * or has already exited (so a recycled pid is never signalled); ESRCH — the group
 * is already gone — is swallowed, since "not running" is precisely the goal.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
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
