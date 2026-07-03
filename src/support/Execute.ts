import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getSystemErrorMap } from "util";
import { Computable } from "../core/Computable";

/**
 * A mechanical failure while executing a build step (spawning processes,
 * staging files, ...) — as opposed to a semantic diagnostic like a conflict or
 * resolution failure. Multiple execution errors from one target are reported
 * grouped under the target rather than as individual diagnostics.
 */
export class ExecutionError extends Error {}

/**
 * @return a human-readable description of an OS-level error, without the errno
 * code or syscall noise (e.g. "no such file or directory" rather than
 * "spawn ... ENOENT") — libuv's strerror, via util.getSystemErrorMap. Falls
 * back to the error's own message for anything unrecognized.
 */
export function systemErrorText(err: unknown): string {
  const errno = (err as Partial<NodeJS.ErrnoException>).errno;
  if (typeof errno === "number") {
    const entry = getSystemErrorMap().get(errno);
    if (entry) {
      return entry[1];
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
 * Locate an executable by searching the directories of the PATH environment
 * variable, as a shell would. Note this is a short-term measure (the result is
 * an untracked input from the environment) until runtimes are modelled as
 * proper dependencies.
 * @throws ExecutionError if no executable of that name is on the PATH.
 */
export function findExecutable(name: string): string {
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

export function execute(cmd: string, args: string[], cwd: string, env: Record<string, string>): Computable<void> {
  return Computable.from((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, windowsHide: true });
    /* Capture the tool's output (both streams, in arrival order) so that a
     * failure can report what the tool actually said. */
    const output: Uint8Array[] = [];
    proc.stdout.on("data", data => output.push(data));
    proc.stderr.on("data", data => output.push(data));
    /* Failure to spawn at all (e.g. missing executable) is reported through
     * the 'error' event; without a handler it would crash the process. */
    proc.on("error", err => {
      reject(new ExecutionError(`Unable to execute ${cmd}: ${systemErrorText(err)}`));
    });
    proc.on("close", (code, signal) => {
      if (signal) {
        reject(new ExecutionError(withOutput(`${cmd}: terminated by signal ${signal}`, output)));
      } else if (code !== 0) {
        reject(new ExecutionError(withOutput(`${cmd}: exited with error code ${code}`, output)));
      } else {
        resolve();
      }
    });
  });
}

function withOutput(message: string, output: Uint8Array[]): string {
  const text = Buffer.concat(output).toString().trimEnd();
  return text.length > 0 ? `${message}\n${text}` : message;
}
