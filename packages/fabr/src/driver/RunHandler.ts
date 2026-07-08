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

import {
  Computable,
  Diagnostic,
  executeInteractive,
  findExecutable,
  Log,
  RunnableFileSet,
  spawnInteractive,
  writeFileSet,
} from "@fabr/core";
import { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `fabr run`'s execution half — kept apart from the driver's model/dispatch
 * concerns. Stage the runnable's install into a fresh temp dir and launch it
 * *interactively*: inherited stdio, so args, pipes, tty and the exit code all
 * pass through, and it runs in the user's own working directory (the entry is
 * anchored at the staged dir, so its module/resource resolution still points at
 * the install regardless of cwd). Returns the program's exit code.
 *
 * This shares the launch reduction (`toCommandLine`) with the codegen `run`
 * build step; the intentional differences from that path — inherited (not
 * captured) stdio, the user's cwd (not the staged dir), and passing the exit
 * code through rather than failing on non-zero — are exactly what makes running
 * a program interactive rather than a cached build step.
 */
export function runInteractive(runnable: RunnableFileSet, callerArgs: string[]): Computable<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-run-"));
  const argv = runnable.toCommandLine(callerArgs, { anchor: dir });
  return writeFileSet(dir, runnable)
    .then(() => executeInteractive(findExecutable(argv[0]), argv.slice(1)))
    .then(code => {
      fs.rmSync(dir, { recursive: true, force: true });
      return code;
    });
}

const DIAG_RESTART = Diagnostic.Info<{ name: string }>("Restarting {name}");
const DIAG_RUN_ERROR = Diagnostic.Error<{ name: string; message: string }>("Failed to launch {name}: {message}");

/**
 * `fabr run -w`'s execution half: supervise a single long-lived child across the
 * watch session, relaunching it when the rebuilt install actually changes.
 *
 * The graph already suppresses most churn — an edit that doesn't match the
 * runnable's globs never re-settles it, and a content-preserving touch is
 * skipped upstream — but the Computable cutoff is *identity*-based, so a genuine
 * rebuild hands us a fresh object even when its bytes are unchanged. So we key
 * the decision on the install's content manifest: an identical manifest leaves
 * the running process untouched, a changed one triggers a stop-stage-relaunch.
 *
 * Deliberately scoped for now: a build error leaves the current child running
 * (the caller simply doesn't call {@link update} on a failed re-settle); a child
 * that exits on its own is *not* auto-respawned — we stay watching and relaunch
 * on the next change (opt-in respawn-on-death is a separate future option, as is
 * SIGHUP-instead-of-restart when only the process's inputs changed, not its
 * binary).
 */
export class RunSupervisor {
  private child?: ChildProcess;
  private stagedDir?: string;
  /** Content manifest of the currently-launched install (undefined ⇒ nothing
   * running), so an identical rebuild is a no-op. */
  private manifest?: string;
  /** Bumped per {@link update}; a slower async stage checks it to bail out when a
   * newer update has superseded it. */
  private generation = 0;

  constructor(private readonly name: string, private readonly callerArgs: string[], private readonly log: Log) {
    /* Whatever ends fabr (SIGINT → exit 0, an error, a stall) must take the
     * child with it — a synchronous exit hook kills it and clears its install. */
    process.on("exit", () => this.stop());
  }

  /** React to a freshly-settled runnable: relaunch iff its install changed. */
  public update(runnable: RunnableFileSet): void {
    const manifest = runnable.toManifest();
    if (this.child && manifest === this.manifest) {
      return;
    }
    const wasRunning = this.child !== undefined;
    const generation = ++this.generation;
    this.stop();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-run-"));
    const argv = runnable.toCommandLine(this.callerArgs, { anchor: dir });
    writeFileSet(dir, runnable).then(
      () => {
        /* A newer update raced ahead while we staged — discard this one. */
        if (generation !== this.generation) {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        }
        try {
          if (wasRunning) {
            this.log.log(DIAG_RESTART, { name: this.name });
          }
          const child = spawnInteractive(findExecutable(argv[0]), argv.slice(1));
          this.child = child;
          this.stagedDir = dir;
          this.manifest = manifest;
          child.on("error", err => this.onChildGone(child, dir, err));
          child.on("exit", () => this.onChildGone(child, dir));
        } catch (err) {
          fs.rmSync(dir, { recursive: true, force: true });
          this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err instanceof Error ? err.message : String(err) });
        }
      },
      err => {
        fs.rmSync(dir, { recursive: true, force: true });
        this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err instanceof Error ? err.message : String(err) });
      }
    );
  }

  /** The child ended (crash, one-shot completion, or a spawn error). Clear it so
   * the next change relaunches, and drop its install. Guarded on identity so a
   * stale handler can't clobber a newer child. */
  private onChildGone(child: ChildProcess, dir: string, err?: Error): void {
    if (err) {
      this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err.message });
    }
    if (this.child === child) {
      this.child = undefined;
      this.manifest = undefined;
    }
    if (this.stagedDir === dir) {
      this.stagedDir = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Kill the running child (if any) and remove its staged install. Synchronous
   * so it is safe from a `process.on("exit")` hook. */
  public stop(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }
    this.manifest = undefined;
    if (this.stagedDir) {
      fs.rmSync(this.stagedDir, { recursive: true, force: true });
      this.stagedDir = undefined;
    }
  }
}
