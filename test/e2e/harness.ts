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
 * End-to-end test harness: writes a fixture project to a temp directory and
 * runs the built fabr CLI against it as a subprocess, capturing stdout / stderr
 * / exit status. These tests exercise the whole stack through the real command
 * line. They dual-run like every other suite: under jest, and under `fabr test`
 * itself via the `fabr_e2e` js_test target (which carries @fabr-build/cli as a dep,
 * so the CLI under test is the one that {@link FABR} resolves — see below).
 *
 * Plugins resolve from the fabr installation (`require.resolve`), not the
 * project dir, so `plugin @fabr-build/js;` works from a temp dir with no node_modules.
 * A stub `tsc` (STUB_TSC / STUB_TSC_CONFIG) lets TS-compiling fixtures avoid the
 * real typescript download; it copies each `src/*.ts` to `build/*.js` verbatim,
 * so fixture "TypeScript" must be type-annotation-free (valid JS).
 */

import { ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* The CLI under test, resolved as a runtime dependency rather than a build-dir
 * path: @fabr-build/cli is a dep of the enclosing test target, so it mounts into
 * node_modules and require.resolve finds its entry — the same line works under
 * jest (the workspace symlink → build/index.js) and under `fabr test` (the
 * staged built package → index.js). */
const FABR = require.resolve("@fabr-build/cli");

/* Spawns inherit no PATH under `fabr test`'s clean env, so name the node binary
 * explicitly and give the child an explicit PATH holding the tools its fixtures
 * shell out to by name: node (js_script/run, the stub tsc) from its own dir, and
 * sh (the `script` rule) from the standard system dirs. Any inherited PATH (jest)
 * is appended so a non-standard toolchain still resolves. */
const NODE = process.execPath;
const CHILD_PATH = [path.dirname(NODE), "/usr/bin", "/bin", process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter);

/* One cache for the whole test process: content-addressed, so sharing it across
 * fixtures just reuses the stub-tsc / package builds. Left for the OS to reap. */
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-cache-"));

export interface FabrResult {
  stdout: string;
  stderr: string;
  status: number;
  /** Contents of the paths requested via `readback`, project-relative -> content
   * (paths that don't exist after the run are omitted). Read before the temp dir
   * is cleaned up, so a verb that writes into the project (e.g. `fabr cp`) can be
   * asserted on. Undefined when no `readback` was requested. */
  files?: Record<string, string>;
}

/**
 * Write `files` (relative path -> contents) into a fresh temp project dir and
 * run `fabr <args>` there. Returns the captured streams and exit status; when
 * `readback` paths are given, their post-run contents too (for verbs that write
 * files into the project).
 */
export function runFabr(files: Record<string, string>, args: string[], readback?: string[]): FabrResult {
  if (!fs.existsSync(FABR)) {
    throw new Error(`fabr is not built at ${FABR} — run 'yarn build' (the 'yarn dist' gate does this)`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-proj-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const result = spawnSync(NODE, [FABR, ...args], {
      cwd: dir,
      env: { PATH: CHILD_PATH, FABR_CACHE_DIR: CACHE_DIR },
      encoding: "utf8",
    });
    let read: Record<string, string> | undefined;
    if (readback) {
      read = {};
      for (const rel of readback) {
        const abs = path.join(dir, rel);
        if (fs.existsSync(abs)) {
          read[rel] = fs.readFileSync(abs, "utf8");
        }
      }
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1, files: read };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stub `tsc` package for fixtures that compile TypeScript, avoiding the real
 * typescript download. Spread into the fixture files and add STUB_TSC_CONFIG to
 * the project. It reads the generated tsconfig (rootDir/outDir) and copies each
 * `.ts` to `.js` verbatim (fixtures must be type-free), emitting a trivial
 * `.d.ts`. Under `allowJs` it also copies `.js`/`.jsx` inputs to `.js` verbatim,
 * standing in for tsc's real downlevel (which the tsconfig unit test covers).
 */
export const STUB_TSC: Record<string, string> = {
  "teststub/typescript/bin/tsc": `const fs = require("fs"), path = require("path");
const cfg = JSON.parse(fs.readFileSync("tsconfig.json", "utf8")).compilerOptions || {};
const rootDir = cfg.rootDir || "src", outDir = cfg.outDir || "build";
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      const rel = path.relative(rootDir, p).replace(/\\.ts$/, "");
      const outJs = path.join(outDir, rel + ".js");
      fs.mkdirSync(path.dirname(outJs), { recursive: true });
      fs.writeFileSync(outJs, fs.readFileSync(p, "utf8"));
      fs.writeFileSync(path.join(outDir, rel + ".d.ts"), "export {};\\n");
    }
    else if (cfg.allowJs && /\\.jsx?$/.test(e.name)) {
      const rel = path.relative(rootDir, p).replace(/\\.jsx?$/, ".js");
      const outJs = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(outJs), { recursive: true });
      fs.writeFileSync(outJs, fs.readFileSync(p, "utf8"));
    }
  }
})(rootDir);
`,
};

/** The project lines that make the stub a runnable toolchain and point TSC at it. */
export const STUB_TSC_CONFIG =
  "js_script stub_tsc { deps = teststub:typescript/**; entry = teststub:typescript/bin/tsc; }\nTSC = stub_tsc;\n";

/**
 * A live `fabr <cmd> -w` subprocess for watch-mode e2e: unlike {@link runFabr}
 * it does not run to completion — it stays up while the test mutates fixture
 * files and asserts on the incremental stderr, then is stopped with SIGINT. All
 * waits are on explicit stderr signals (not sleeps) with a timeout, to stay
 * deterministic.
 */
export interface WatchSession {
  /** The project directory (mutate fixture files here via {@link write}). */
  readonly dir: string;
  /** Everything the process has written to stderr so far. */
  readonly stderr: string;
  /** Write/overwrite a fixture file (relative to the project dir). */
  write(rel: string, content: string): void;
  /** Resolve once `pattern` has appeared at least `count` times on stderr (or reject on timeout). */
  waitFor(pattern: string | RegExp, opts?: { count?: number; timeoutMs?: number }): Promise<void>;
  /** Signal the process (SIGINT by default) and resolve with its exit code,
   * cleaning up the dir. */
  stop(signal?: NodeJS.Signals): Promise<number>;
}

function toGlobalRegExp(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) {
    return pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

export function startFabrWatch(files: Record<string, string>, args: string[]): WatchSession {
  if (!fs.existsSync(FABR)) {
    throw new Error(`fabr is not built at ${FABR} — run 'yarn build' (the 'yarn dist' gate does this)`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-watch-"));
  const write = (rel: string, content: string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) {
    write(rel, content);
  }

  /* A private cache (not the shared CACHE_DIR): a watch session's rebuilds churn
   * the store while other e2e suites build in parallel — an isolated cache keeps
   * that fs contention (and any cross-process cache racing) off the shared pool. */
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-watch-cache-"));
  const child: ChildProcess = spawn(NODE, [FABR, ...args], {
    cwd: dir,
    env: { PATH: CHILD_PATH, FABR_CACHE_DIR: cacheDir },
  });
  let stderr = "";
  interface Waiter {
    satisfied(): boolean;
    resolve(): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
  const waiters = new Set<Waiter>();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    for (const waiter of [...waiters]) {
      if (waiter.satisfied()) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });

  return {
    dir,
    get stderr(): string {
      return stderr;
    },
    write,
    waitFor(pattern, opts = {}): Promise<void> {
      const { count = 1, timeoutMs = 20000 } = opts;
      const regExp = toGlobalRegExp(pattern);
      const satisfied = (): boolean => (stderr.match(regExp) || []).length >= count;
      if (satisfied()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          satisfied,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`timed out waiting for ${count}x ${pattern}\n--- stderr so far ---\n${stderr}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    stop(signal: NodeJS.Signals = "SIGINT"): Promise<number> {
      return new Promise<number>(resolve => {
        const finish = (code: number | null): void => {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.rmSync(cacheDir, { recursive: true, force: true });
          resolve(code ?? -1);
        };
        /* If the child already exited (e.g. it crashed — exactly the case where a
         * test most needs stop() to complete so its diagnostics surface), resolve
         * now; the 'exit' listener would never fire again and hang forever. */
        if (child.exitCode !== null || child.signalCode !== null) {
          finish(child.exitCode);
          return;
        }
        child.on("exit", finish);
        child.kill(signal);
      });
    },
  };
}
