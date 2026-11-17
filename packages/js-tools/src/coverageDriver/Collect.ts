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

/**
 * Coverage collection in a measured test process, loaded by the module the
 * coverage driver prepares: V8's precise coverage, started before any test
 * code loads and written as the process exits, of the measured files alone.
 * It loads nothing but node's own modules and the virtual-path helper, since
 * every test process loads it.
 */

import * as fs from "node:fs";
import * as inspector from "node:inspector";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { resolveVirtual } from "../pnp/VirtualPath";
import { COVERAGE_DIR_VARIABLE } from "./Options";

/** As much of V8's script coverage as collection reads. */
interface IScriptCoverage {
  url: string;
}

/**
 * Make a resolver of the physical path of a file: through its PnP virtual
 * location where it is written through one, then its directory's real path
 * (the file itself is never a link), each directory resolved once. A path
 * that does not exist is its own.
 */
export function physicalPaths(): (file: string) => string {
  const directories = new Map<string, string>();
  return file => {
    const located = resolveVirtual(file);
    const directory = path.dirname(located);
    let real = directories.get(directory);
    if (real === undefined) {
      try {
        real = fs.realpathSync(directory);
      } catch {
        real = directory;
      }
      directories.set(directory, real);
    }
    return path.join(real, path.basename(located));
  };
}

/** Whether this process is recording its coverage already, the preload loaded twice. */
let collecting = false;

/**
 * Start recording this process's coverage, where {@link COVERAGE_DIR_VARIABLE}
 * names a directory, and on exit write what it recorded of the measured files
 * into that directory: one document per process and thread, in V8's coverage
 * format, each script's `url` the name the table at `table` (read then; a JSON
 * object of names by physical path) gives the file. A process killed before
 * it exits writes nothing. The processes this one starts load `preload`, the
 * module calling this, too ({@link carryIntoChildren}).
 *
 * Must be called before any module imports `node:child_process` as an ES
 * module, whose named bindings would keep the unwrapped functions.
 */
export function collectCoverage(table: string, preload: string): void {
  const directory = process.env[COVERAGE_DIR_VARIABLE];
  if (directory === undefined || collecting) {
    return;
  }
  collecting = true;
  carryIntoChildren(preload);
  const session = new inspector.Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  process.on("exit", () => {
    /* An in-process session answers synchronously, so the document is
     * written before the process ends. */
    session.post("Profiler.takePreciseCoverage", (err, taken) => {
      try {
        if (err !== null) {
          throw err;
        }
        const names = new Map(Object.entries(JSON.parse(fs.readFileSync(table, "utf8")) as Record<string, string>));
        const physical = physicalPaths();
        const result = (taken.result as IScriptCoverage[]).flatMap(script => {
          const name = script.url.startsWith("file:") ? names.get(physical(fileURLToPath(script.url))) : undefined;
          return name === undefined ? [] : [{ ...script, url: name }];
        });
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `coverage-${process.pid}-${threadId}.json`), JSON.stringify({ result }));
      } catch (failure) {
        process.stderr.write(`fabr: could not record coverage: ${failure instanceof Error ? failure.message : String(failure)}\n`);
      }
    });
  });
}

/** The `child_process` functions that start a process. */
const SPAWNERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/**
 * Make every process this one starts load `preload` too, where its
 * environment names a coverage directory ({@link COVERAGE_DIR_VARIABLE}) but a
 * `NODE_OPTIONS` of its own leaves `preload` out: `--require` is appended to
 * it. A process given an environment without the coverage directory is left
 * as it is.
 */
function carryIntoChildren(preload: string): void {
  const required = `--require ${JSON.stringify(preload)}`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const processes = require("node:child_process") as Record<string, (...args: unknown[]) => unknown>;
  for (const name of SPAWNERS) {
    const start = processes[name];
    /* The options follow the command, or the argument list where one is
     * given; exec and execSync take none. */
    const at = (args: unknown[]): number => (name !== "exec" && name !== "execSync" && Array.isArray(args[1]) ? 2 : 1);
    processes[name] = function (this: unknown, ...args: unknown[]): unknown {
      const index = at(args);
      const given = args[index];
      const options = given !== null && typeof given === "object" ? (given as { env?: NodeJS.ProcessEnv }) : undefined;
      const env = options?.env ?? process.env;
      if (env[COVERAGE_DIR_VARIABLE] === undefined || (env.NODE_OPTIONS ?? "").includes(required)) {
        return start.apply(this, args);
      }
      const carried = { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, required].filter(Boolean).join(" ") };
      const changed = [...args];
      if (options === undefined) {
        changed.splice(index, 0, { env: carried });
      } else {
        changed[index] = { ...options, env: carried };
      }
      return start.apply(this, changed);
    };
  }
}
