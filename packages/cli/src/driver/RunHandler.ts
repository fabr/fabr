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
  BuildCache,
  Computable,
  Diagnostic,
  executeInteractive,
  FileSet,
  findExecutable,
  killProcessGroup,
  Log,
  RunnableFileSet,
  spawnInteractive,
  syncFileSet,
  writeFileSet,
} from "@fabr-build/core";
import { ChildProcess } from "node:child_process";
import { resumeActiveTerminal, suspendActiveTerminal, withTerminalSuspended } from "./Terminal";

/**
 * `fabr run`'s execution half — kept apart from the driver's model/dispatch
 * concerns. Stage the runnable's install into a fresh work dir and launch it
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
export function runInteractive(cache: BuildCache, runnable: RunnableFileSet, callerArgs: string[]): Computable<number> {
  /* A cache work dir, not a temp dir of our own: an install is hardlinks into
   * the store, so it has to be on the store's filesystem, and the cache is what
   * reclaims it if fabr is killed before the `finally` below can run. */
  const dir = cache.createWorkDir("run-");
  const argv = launchArgv(runnable, callerArgs, dir);
  return writeFileSet(dir, runnable)
    /* The program owns the terminal while it runs (it inherits fabr's stdio),
     * so fabr's own display steps aside for the duration. */
    .then(() => withTerminalSuspended(() => executeInteractive(findExecutable(argv[0]), argv.slice(1), launchDir(runnable, dir))))
    /* Remove the staged install whichever way the run ends — a staging or launch
     * failure must not leak the work dir (only the success path did before). */
    .finally(() => cache.releaseWorkDir(dir));
}

/** The argv for launching from `dir`: an install-anchored runnable runs *in* the
 * staged dir, so its entry stays install-relative (as the exec build step); a
 * caller-cwd runnable runs in the user's directory with the entry made absolute. */
function launchArgv(runnable: RunnableFileSet, callerArgs: string[], dir: string): string[] {
  return runnable.launchCwd === "install" ? runnable.toCommandLine(callerArgs) : runnable.toCommandLine(callerArgs, { anchor: dir });
}

/** The launch cwd override: the staged dir for an install-anchored runnable,
 * none (inherit the caller's) otherwise. */
function launchDir(runnable: RunnableFileSet, dir: string): string | undefined {
  return runnable.launchCwd === "install" ? dir : undefined;
}

/** How long a gracefully-stopped child (a restart) has to exit on SIGTERM before
 * its group is SIGKILLed — long enough for a server to close its listeners and
 * free its port, short enough not to stall the relaunch. */
const RESTART_GRACE_MS = 2000;

const DIAG_RESTART = Diagnostic.Info<{ name: string }>("Restarting {name}");
const DIAG_UPDATE = Diagnostic.Info<{ name: string; count: number }>("Updating {name} content ({count} files)");
const DIAG_RUN_ERROR = Diagnostic.Error<{ name: string; message: string }>("Failed to launch {name}: {message}");

/**
 * One staged install of the program: the directory it was written to, the
 * `programKey` (program manifest + launch argv) identifying *which* program it
 * is, the `served` partition currently written into it (a content sync advances
 * this), and the child running it once launched.
 *
 * A swap has two of these live at once — the old child keeps serving out of its
 * own dir while the replacement is staged — so the supervisor's state is this
 * one type plus two pointers into it ({@link RunSupervisor.target},
 * {@link RunSupervisor.current}), which coincide from launch to the next update.
 */
interface Install {
  readonly dir: string;
  readonly programKey: string;
  served: FileSet;
  /** Absent until launched — and again once the child has exited. */
  child?: ChildProcess;
}

/**
 * `fabr run -w`'s execution half: supervise a single long-lived child across the
 * watch session, reacting when the rebuilt install actually changes.
 *
 * The graph already suppresses most churn — an edit that doesn't match the
 * runnable's globs never re-settles it, and a content-preserving touch is
 * skipped upstream — but the Computable cutoff is *identity*-based, so a genuine
 * rebuild hands us a fresh object even when its bytes are unchanged. So the
 * reaction is a pure function of successive artifacts, on two keys:
 *
 * - the **program key** — the program-partition manifest (the install minus the
 *   `served` content) plus the launch argv (an args-only decl edit must
 *   relaunch too) — a change triggers the stop-stage-relaunch;
 * - the **served content** — a content-only change is synced into the running
 *   child's staged dir in place (syncFileSet: per-file atomic, so the server —
 *   or its own fs watcher — never sees a torn file), no restart.
 *
 * An ordinary runnable has an empty `served` partition, so the second key never
 * differs and the behavior is exactly the old relaunch-on-change — not a
 * special case, the same rule.
 *
 * Deliberately scoped for now: a build error leaves the current child running
 * (the caller simply doesn't call {@link update} on a failed re-settle); a child
 * that exits on its own is *not* auto-respawned — we stay watching and relaunch
 * on the next change (opt-in respawn-on-death is a separate future option, as is
 * a notify channel telling the server what a sync changed).
 */
export class RunSupervisor {
  /** Every install staged on disk, so a shutdown removes the lot. */
  private readonly installs = new Set<Install>();
  /** The install we are *committed to* — running, or staged and waiting for the
   * old child to exit; undefined ⇒ the next update stages and launches. An
   * update is judged against this rather than against what is *running*, or a
   * revert-to-what-is-running (save, then undo) mid-swap would read as
   * unchanged and leave the in-flight swap to launch the superseded program. */
  private target?: Install;
  /** The install whose child is live. */
  private current?: Install;
  /** Bumped per state-changing reaction; a slower async stage (or sync) checks
   * it to bail out when a newer reaction has superseded it. */
  private generation = 0;
  /** Serializes content syncs: each chains behind the previous, so overlapping
   * re-settles can't interleave their per-file writes out of order. It is a
   * *gate*, not a history — once the newest sync has landed there is nothing left
   * to queue behind, so {@link updateContent} collapses it back to a settled node.
   * Left to accumulate it would hold one chain node per sync for the life of the
   * run, each retaining the RunnableFileSet its callback closed over. */
  private lastSync: Computable<void> = Computable.resolve(undefined);
  /** The most recently queued content sync. Only that one may collapse the gate:
   * an earlier sync finishing behind a newer one must leave it in place, or the
   * newer one's writes would stop being serialized against it. */
  private syncSeq = 0;

  constructor(
    private readonly cache: BuildCache,
    private readonly name: string,
    private readonly callerArgs: string[],
    private readonly log: Log
  ) {
    /* Whatever ends fabr (SIGINT/SIGTERM → exit 0, an error, a stall) must take
     * the child with it — a synchronous exit hook kills it and clears its
     * install. This relies on the process ending via `process.exit` (the watch
     * lifecycle routes both signals through it); a default signal disposition
     * would bypass the hook, which is why those signals are handled explicitly. */
    process.on("exit", () => this.stop());
  }

  /** React to a freshly-settled runnable: relaunch iff its program changed,
   * sync in place iff only its served content did. The result settles when the
   * reaction has fully landed (child swapped, sync applied, or nothing to do) —
   * completion, not success: failures are logged here and never reject, so a
   * caller can sequence after it (the driver's cycle-completion marker). */
  public update(runnable: RunnableFileSet): Computable<void> {
    /* Key on the install-relative argv (no anchor), identical across staged
     * dirs — so an args/entry-only change relaunches, a mere restage doesn't. */
    const programKey = `${runnable.programManifest()}\n$ ${runnable.toCommandLine(this.callerArgs).join("\0")}`;
    if (programKey === this.target?.programKey) {
      return this.updateContent(runnable);
    }
    const wasRunning = this.current !== undefined;
    const generation = ++this.generation;
    /* Stage the replacement install BEFORE touching the running child: the old
     * process keeps serving while we write, and a staging failure leaves it
     * running (killing it up front would leave nothing to fall back to). The
     * running child is only stopped once the new install is ready to launch. */
    const install: Install = { dir: this.cache.createWorkDir("run-"), programKey, served: runnable.served };
    this.installs.add(install);
    /* Commit at stage time, not at launch, so an update arriving mid-swap is
     * judged against what we are heading for and a content sync lands in this
     * install whether or not the child has been swapped over to it yet. */
    this.target = install;
    const argv = launchArgv(runnable, this.callerArgs, install.dir);
    const staged = writeFileSet(install.dir, runnable);
    /* Syncs queue behind the staging write — the dir does not exist until it
     * lands. Bump syncSeq too: it declares every already-queued sync superseded,
     * so a stale sync's finish() cannot collapse this gate back to settled while
     * the staging write is still in flight (letting a later sync's writes
     * interleave with the restage). */
    this.syncSeq++;
    this.lastSync = staged.then(
      () => undefined,
      () => undefined
    );
    return staged.then(
      () => this.swap(install, argv, runnable, generation, wasRunning),
      err => {
        this.discard(install);
        this.logRunError(err);
      }
    );
  }

  /** `install` is staged — stop the old child (if any) and launch it once that
   * child has *actually exited*. The wait matters: a real server still holds its
   * port until it exits, so binding the replacement synchronously races it
   * (EADDRINUSE) — exactly the dev-server case run supervises. Resolves when the
   * new child is running (or the update was superseded meanwhile). */
  private swap(
    install: Install,
    argv: string[],
    runnable: RunnableFileSet,
    generation: number,
    wasRunning: boolean
  ): Computable<void> {
    /* A newer update raced ahead while we staged — discard this one and leave the
     * current child alone (that newer update will supersede it). */
    if (generation !== this.generation) {
      this.discard(install);
      return Computable.resolve(undefined);
    }
    const old = this.current?.child;
    if (!old) {
      this.launch(install, argv, runnable, generation, wasRunning);
      return Computable.resolve(undefined);
    }
    /* Stop the old child gracefully and defer the launch to its exit — its own
     * exit handler ({@link onChildGone}) drops its staged install, so we neither
     * pre-remove it (the child may still read the tree while shutting down) nor
     * spawn over a still-listening server. The escalation timer SIGKILLs a child
     * that overruns the grace window; that kill's exit still drives the launch. */
    return Computable.from(resolve => {
      old.once("exit", () => {
        this.launch(install, argv, runnable, generation, wasRunning);
        resolve(undefined);
      });
      this.stopChildGroup(old);
    });
  }

  /** Give `install` its child. Generation-guarded: a newer update that superseded
   * us while the old child was exiting discards this now-stale install instead of
   * launching it. */
  private launch(
    install: Install,
    argv: string[],
    runnable: RunnableFileSet,
    generation: number,
    wasRunning: boolean
  ): void {
    if (generation !== this.generation) {
      this.discard(install);
      return;
    }
    try {
      if (wasRunning) {
        this.log.log(DIAG_RESTART, { name: this.name });
      }
      const child = spawnInteractive(findExecutable(argv[0]), argv.slice(1), launchDir(runnable, install.dir));
      /* The supervised program owns the terminal from here until it exits —
       * which outlives the build that launched it, so the hand-over is bracketed
       * by the child's own lifetime rather than by a chain. Rebuild diagnostics
       * still print; only the live pane stands down. */
      suspendActiveTerminal();
      install.child = child;
      this.current = install;
      /* `target` is not re-pointed here — it was set when this install was staged,
       * and a content sync that landed since has already advanced its `served`. */
      child.on("error", err => this.onChildGone(install, err));
      child.on("exit", () => this.onChildGone(install));
    } catch (err) {
      this.discard(install);
      this.logRunError(err);
    }
  }

  /** Forget an install and remove it from disk — superseded, failed to stage or
   * launch, or its child has gone. Idempotent. If it was still the commitment
   * (rather than a newer update having taken over) that goes with it, so the next
   * update stages afresh instead of matching a dead install's key. */
  private discard(install: Install): void {
    this.installs.delete(install);
    if (this.target === install) {
      this.target = undefined;
    }
    this.cache.releaseWorkDir(install.dir);
  }

  private logRunError(err: unknown): void {
    this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err instanceof Error ? err.message : String(err) });
  }

  /** SIGTERM a child's whole process group, escalating to SIGKILL if it hasn't
   * exited within {@link RESTART_GRACE_MS} — so a well-behaved server closes its
   * listeners (frees its port) first. Unref'd so the escalation timer never keeps
   * the loop alive on its own; the live child handle does until it exits. */
  private stopChildGroup(child: ChildProcess): void {
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => killProcessGroup(child, "SIGKILL"), RESTART_GRACE_MS).unref();
  }

  /** The program is unchanged — apply a served-content delta (if any) to the
   * committed install's dir in place. Chained behind that dir's staging write
   * and any earlier sync so writes apply in settle order; generation-guarded so
   * a restart that supersedes a queued sync discards it (and silences its
   * failures — its dir may be gone). Settles when this cycle's sync has landed
   * (or proved unnecessary). */
  private updateContent(runnable: RunnableFileSet): Computable<void> {
    const generation = this.generation;
    const seq = ++this.syncSeq;
    /* Release the gate on every terminal path (including the nothing-to-do ones),
     * so a run that syncs indefinitely holds one settled node rather than a chain. */
    let collapsed = false;
    const finish = (): undefined => {
      if (seq === this.syncSeq) {
        this.lastSync = Computable.resolve(undefined);
        collapsed = true;
      }
      return undefined;
    };
    const sync = this.lastSync.then(() => {
      const target = this.target;
      if (generation !== this.generation || !target || target.served.toManifest() === runnable.served.toManifest()) {
        return finish();
      }
      return syncFileSet(target.dir, target.served, runnable.served).then(
        ({ written, removed }) => {
          if (generation === this.generation) {
            target.served = runnable.served;
            this.log.log(DIAG_UPDATE, { name: this.name, count: written + removed });
          }
          finish();
        },
        err => {
          if (generation === this.generation) {
            this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err instanceof Error ? err.message : String(err) });
          }
          finish();
        }
      );
    });
    /* A sync with nothing to do settles while `then` is still constructing, so the
     * gate is already released by here — taking `sync` as the gate would reinstate
     * the chain it just dropped. */
    if (!collapsed) {
      this.lastSync = sync;
    }
    return sync;
  }

  /** `install`'s child ended (crash, one-shot completion, or a spawn error): drop
   * it, so the next change relaunches. Keyed on the install, so a handler for a
   * superseded one can't clear the live child. */
  private onChildGone(install: Install, err?: Error): void {
    if (err) {
      this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err.message });
    }
    /* The terminal is fabr's again (a restart's new child suspends it afresh). */
    resumeActiveTerminal();
    install.child = undefined;
    if (this.current === install) {
      this.current = undefined;
    }
    this.discard(install);
  }

  /** Kill every live child's whole process group and remove every staged install
   * — one loop, since `installs` is exactly what is on disk (the running one plus
   * any staged mid-restart). Synchronous and hard (SIGKILL), so it is safe and
   * reliable from a `process.on("exit")` hook: fabr is already leaving, so
   * guaranteeing no orphaned workers outranks giving the child a graceful window.
   * The whole group is signalled, not just the direct child, so a program that
   * forked its own workers isn't left orphaned. */
  public stop(): void {
    for (const install of this.installs) {
      if (install.child) {
        killProcessGroup(install.child, "SIGKILL");
      }
      this.cache.releaseWorkDir(install.dir);
    }
    this.installs.clear();
    this.target = undefined;
    this.current = undefined;
  }
}
