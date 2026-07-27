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

/** How long {@link WatchSession.stop} gives the child to exit on its signal
 * before SIGKILLing it. Longer than fabr's own SHUTDOWN_GRACE_MS deadline, so
 * the clean (and the deadline-forced) exits win whenever fabr is responsive. */
const STOP_KILL_GRACE_MS = 8000;

/* Every live watch subprocess, so the reaper below can tear any survivor down.
 * A watch child is the fabr supervisor, which owns (and, on a signal, tears down)
 * the app/server it launched — so signalling fabr cleans up the whole tree; the
 * harness needn't know the launched program's own (detached) process group. The
 * normal path (a test's finally { session.stop() }) empties this set; the reaper
 * is the safety net for the paths that skip it — a test that times out
 * mid-await, or the runner process itself being interrupted. */
const liveWatchers = new Set<ChildProcess>();

/* SIGTERM every watch subprocess still alive when the runner exits or is
 * interrupted, so a timed-out test (or a Ctrl-C'd `yarn bootstrap`) can't leave
 * orphaned `fabr run -w` trees behind: each fabr handles the SIGTERM and kills
 * its own launched app before exiting (fabr is a separate process, so it
 * survives the runner's exit long enough to do so). Registered once; the exit
 * hook is synchronous (the only safe kind), and the signal handlers exit after
 * so the runner still terminates. SIGKILL of the runner is unstoppable and
 * unavoidably orphans — nothing can run cleanup after it. */
let reaperInstalled = false;
function installWatchReaper(): void {
  if (reaperInstalled) {
    return;
  }
  reaperInstalled = true;
  const reap = (): void => liveWatchers.forEach(child => child.kill("SIGTERM"));
  process.on("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      reap();
      process.exit(1);
    });
  }
}

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
      /* stdin from /dev/null: these runs are non-interactive, so a fabr verb that
       * spawns a stdin-reading child with inherited stdio (`fabr shell`'s shell)
       * gets an immediate EOF and exits, rather than blocking on a stdin that
       * never closes — which would hang the whole test with no timeout to catch it. */
      stdio: ["ignore", "pipe", "pipe"],
      /* Hard cap: spawnSync blocks the worker's event loop, so a fabr that hangs
       * (a regression in the no-hung-builds guarantee) would freeze the whole
       * runner with no per-test timeout able to fire. SIGKILL because a hung
       * fabr may be beyond signal handlers; the null status reads as -1. */
      timeout: 180_000,
      killSignal: "SIGKILL",
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
 * Run `fabr <args>` but slam the read end of one of its output streams shut as
 * soon as the child is up — the `… | head` case, where a consumer stops reading
 * mid-stream. The next write to that stream in the child then hits `EPIPE`; a
 * well-behaved fabr swallows it (rather than dumping a raw Node stack) while
 * still exiting with its real status. Returns the exit code and whatever it
 * managed to write to the *other*, still-open stream. (Needs a real async spawn
 * — {@link runFabr}'s `spawnSync` drains the streams fully and can't close one
 * early.) `close` picks which reader to drop; a `cat` of many files (or one
 * larger than the pipe buffer) makes a stdout close land a write after the drop.
 */
export function runFabrClosingStream(
  files: Record<string, string>,
  args: string[],
  close: "stdout" | "stderr" = "stdout"
): Promise<FabrResult> {
  if (!fs.existsSync(FABR)) {
    throw new Error(`fabr is not built at ${FABR} — run 'yarn build' (the 'yarn dist' gate does this)`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-proj-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const child = spawn(NODE, [FABR, ...args], {
    cwd: dir,
    env: { PATH: CHILD_PATH, FABR_CACHE_DIR: CACHE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  /* Capture the stream we're leaving open; close the other's read end so the
   * child's next write to it has no reader and fails with EPIPE. */
  const open = close === "stdout" ? child.stderr : child.stdout;
  let captured = "";
  open?.setEncoding("utf8");
  open?.on("data", (chunk: string) => (captured += chunk));
  (close === "stdout" ? child.stdout : child.stderr)?.destroy();
  return new Promise<FabrResult>(resolve => {
    child.on("exit", (code, signal) => {
      fs.rmSync(dir, { recursive: true, force: true });
      /* A raw uncaught EPIPE would kill the child by SIGPIPE/stack, not a clean
       * exit; surface the signal as a negative status so the test can catch it. */
      const status = code ?? (signal ? -1 : -1);
      resolve(close === "stdout" ? { stdout: "", stderr: captured, status } : { stdout: captured, stderr: "", status });
    });
  });
}

/**
 * The orphan-reaper daemon: a detached helper process holding a pipe from this
 * (harness) process. The kernel closes that pipe when we die by ANY means —
 * including the SIGKILL of a force-exited jest worker, which runs no exit hook
 * — and the daemon then SIGTERMs every registered watcher pid (SIGKILL after a
 * grace, for a natively-wedged fabr that can't run a signal handler) and exits.
 * This keeps the "reap me if my creator is hard-killed" contract entirely in
 * the harness: fabr itself needs no parent-death behavior (which would break
 * deliberate daemonization — setsid/disown a `fabr build -w`).
 *
 * The in-process exit-hook reaper ({@link installWatchReaper}) remains the
 * first line of defense (it runs on every orderly exit, before pid-reuse could
 * matter); the daemon is the SIGKILL-proof backstop. Registered pids are
 * forgotten on a session's normal stop, so the daemon's sweep only ever sees
 * watchers whose sessions never completed.
 */
const REAPER_SCRIPT =
  "const kids=new Set();let buf=\"\";" +
  'process.stdin.setEncoding("utf8");' +
  'process.stdin.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){' +
  "const [cmd,pid]=buf.slice(0,i).split(\" \");buf=buf.slice(i+1);" +
  'if(cmd==="WATCH")kids.add(Number(pid));' +
  'if(cmd==="FORGET")kids.delete(Number(pid));}});' +
  "const reap=()=>{" +
  'for(const pid of kids){try{process.kill(pid,"SIGTERM");}catch{}}' +
  "setTimeout(()=>{" +
  'for(const pid of kids){try{process.kill(pid,"SIGKILL");}catch{}}' +
  "process.exit(0);},5000);};" +
  'process.stdin.on("end",reap);process.stdin.on("close",reap);';

export interface OrphanReaper {
  register(pid: number): void;
  forget(pid: number): void;
  /** Simulate the harness dying (kernel-close of the pipe): the daemon reaps.
   * Exposed for the e2e that pins the mechanism — a SIGKILL of this process
   * closes the pipe identically, the daemon cannot tell the difference. */
  dropPipe(): void;
}

/** Spawn a reaper daemon. Fully unref'd: it must never keep the harness's own
 * event loop alive (that's the wedge that used to hang `fabr test` runs). */
export function spawnOrphanReaper(): OrphanReaper {
  const daemon = spawn(NODE, ["-e", REAPER_SCRIPT], { stdio: ["pipe", "ignore", "ignore"] });
  daemon.unref();
  const stdin = daemon.stdin!;
  stdin.on("error", () => undefined); /* daemon already gone — nothing to reap */
  (stdin as unknown as { unref?: () => void }).unref?.();
  return {
    register: pid => stdin.write(`WATCH ${pid}\n`),
    forget: pid => stdin.write(`FORGET ${pid}\n`),
    dropPipe: () => stdin.destroy(),
  };
}

/** The harness's own daemon, lazily started with the first watch session. */
let orphanReaper: OrphanReaper | undefined;
function reaperFor(child: ChildProcess): OrphanReaper {
  orphanReaper ??= spawnOrphanReaper();
  if (child.pid !== undefined) {
    orphanReaper.register(child.pid);
  }
  return orphanReaper;
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
  /** The fabr process's pid (for liveness assertions in the reaper e2e). */
  readonly pid: number | undefined;
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
  installWatchReaper();
  const child: ChildProcess = spawn(NODE, [FABR, ...args], {
    cwd: dir,
    env: { PATH: CHILD_PATH, FABR_CACHE_DIR: cacheDir },
  });
  liveWatchers.add(child);
  /* SIGKILL-proof backstop: the daemon reaps this pid if the harness process
   * itself dies without running its exit hook (a force-exited jest worker). */
  const reaper = reaperFor(child);
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
    pid: child.pid,
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
          clearTimeout(killer);
          liveWatchers.delete(child);
          if (child.pid !== undefined) {
            reaper.forget(child.pid);
          }
          fs.rmSync(dir, { recursive: true, force: true });
          fs.rmSync(cacheDir, { recursive: true, force: true });
          resolve(code ?? -1);
        };
        /* A wedged fabr (e.g. the @parcel/watcher native deadlock — see
         * KNOWN-ISSUES) can't run ANY signal handler, so waiting on 'exit' alone
         * can hang forever — and the child's open pipes then pin the runner's
         * event loop, so even the exit-hook reaper never fires (jest force-exits
         * the worker, skipping the reaper and orphaning the child; `fabr test`
         * has no force-exit and hangs the whole build). Escalate to SIGKILL
         * after a grace so a stuck child becomes a visible test failure (-1 /
         * non-zero exit), never a hang. */
        const killer = setTimeout(() => child.kill("SIGKILL"), STOP_KILL_GRACE_MS);
        killer.unref();
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
