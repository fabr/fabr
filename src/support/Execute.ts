import { spawn } from "child_process";
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

export function execute(cmd: string, args: string[], cwd: string, env: Record<string, string>): Computable<void> {
  return Computable.from((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, windowsHide: true });
    proc.stdout.on("data", data => {});
    proc.stderr.on("data", data => {});
    /* Failure to spawn at all (e.g. missing executable) is reported through
     * the 'error' event; without a handler it would crash the process. */
    proc.on("error", err => {
      reject(new ExecutionError(`Unable to execute ${cmd}: ${systemErrorText(err)}`));
    });
    proc.on("close", (code, signal) => {
      if (signal) {
        reject(new ExecutionError(`${cmd}: terminated by signal ${signal}`));
      } else if (code !== 0) {
        reject(new ExecutionError(`${cmd}: exited with error code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
