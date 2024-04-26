import { spawn } from "child_process";
import { Computable } from "../core/Computable";

export function execute(cmd: string, args: string[], cwd: string, env: Record<string, string>): Computable<void> {
  return Computable.from((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, windowsHide: true });
    proc.stdout.on("data", data => {});
    proc.stderr.on("data", data => {});
    proc.on("close", (code, signal) => {
      if (signal) {
        reject("Terminated by signal " + signal);
      } else if (code !== 0) {
        reject("Exited with error code " + code);
      } else {
        resolve();
      }
    });
  });
}
