import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getSystemErrorMap } from "util";
import { Computable } from "../core/Computable";
import { ExecutionError } from "../core/Errors";

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
 * Because the child's output is captured (a pipe, not a TTY), tools would
 * suppress their color/formatting; these conventional variables ask them not
 * to. Set unconditionally — never conditioned on the driver's own terminal —
 * so a step's environment stays deterministic; the driver strips the codes at
 * render time when its output isn't a TTY. A caller's own env entries win.
 */
const FORCE_COLOR_ENV = { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" };

export function execute(cmd: string, args: string[], cwd: string, env: Record<string, string>): Computable<void> {
  /* A failed spawn emits 'error' then a spurious 'close' (code -2): Computable.once
   * keeps the first (informative ENOENT) rejection and drops the useless "-2". */
  return Computable.once((resolve, reject) => {
    const commandLine = "$ " + [cmd, ...args].map(quoteArg).join(" ");
    /* stdin from /dev/null ("ignore"), not the default open pipe: a build step is
     * non-interactive, so a tool that reads stdin must get EOF at once rather than
     * blocking forever on input the parent never sends. stdout/stderr stay piped
     * so their output is captured below. */
    const proc = spawn(cmd, args, { cwd, env: { ...FORCE_COLOR_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    /* Capture the tool's output (both streams, in arrival order) so that a
     * failure can report what the tool actually said. */
    const output: Uint8Array[] = [];
    proc.stdout.on("data", data => output.push(data));
    proc.stderr.on("data", data => output.push(data));
    /* Failure to spawn at all (e.g. missing executable) is reported through
     * the 'error' event; without a handler it would crash the process. */
    proc.on("error", err => {
      reject(new ExecutionError(`${commandLine}\nunable to execute: ${systemErrorText(err)}`));
    });
    /* Failures report the command line that ran first, then the tool's
     * output, then how it ended. */
    proc.on("close", (code, signal) => {
      if (signal) {
        reject(new ExecutionError(withOutput(commandLine, output, `terminated by signal ${signal}`)));
      } else if (code !== 0) {
        reject(new ExecutionError(withOutput(commandLine, output, `exited with error code ${code}`)));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Run a command interactively: the child inherits this process's stdio (tty,
 * pipes, stdin) and environment, and its exit code resolves as *data* — a
 * program may legitimately exit non-zero, unlike `execute`, which fails the
 * build on a non-zero exit. Rejects only when the process cannot be spawned or
 * is killed by a signal. This is the launch behind `fabr run`. `cwd` overrides
 * the inherited working directory — an install-anchored runnable (`launchCwd
 * === "install"`) launches at its staged root rather than the caller's cwd.
 */
export function executeInteractive(cmd: string, args: string[], cwd?: string): Computable<number> {
  /* A failed spawn emits 'error' then 'close': Computable.once keeps the informative
   * rejection and stops 'close' flipping a settled failure into a success. */
  return Computable.once((resolve, reject) => {
    const commandLine = "$ " + [cmd, ...args].map(quoteArg).join(" ");
    const proc = spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd });
    proc.on("error", e => reject(new ExecutionError(`${commandLine}\nunable to execute: ${systemErrorText(e)}`)));
    proc.on("close", (code, signal) => {
      if (signal) {
        reject(new ExecutionError(`${commandLine}\nterminated by signal ${signal}`));
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
 */
export function spawnInteractive(cmd: string, args: string[], cwd?: string): ChildProcess {
  return spawn(cmd, args, { stdio: "inherit", windowsHide: true, cwd });
}

/** Quote an argument for display where it wouldn't survive a shell round-trip */
function quoteArg(arg: string): string {
  return arg.length > 0 && !/[\s'"$\\`*?[\]{}()<>|&;#~!]/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function withOutput(commandLine: string, output: Uint8Array[], result: string): string {
  const text = Buffer.concat(output).toString().trimEnd();
  return text.length > 0 ? `${commandLine}\n${text}\n${result}` : `${commandLine}\n${result}`;
}
