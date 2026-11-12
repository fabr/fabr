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
  deleteTree,
  Diagnostic,
  executeInteractive,
  FileSet,
  findExecutable,
  ILaunch,
  killProcessGroup,
  Log,
  manifestArguments,
  RunnableFileSet,
  spawnInteractive,
  startLaunch,
  syncFileSet,
  toArgv,
  writeFileSet,
} from "@fabr-build/core";
import { ChildProcess } from "node:child_process";
import { resumeActiveTerminal, suspendActiveTerminal, withTerminalSuspended } from "./Terminal";

/**
 * Run `runnable` for `fabr run`: stage its install into the program's kept
 * work dir (`key`), syncing what changed since the dir was last written, and
 * launch it with `callerArgs` and fabr's stdio, the terminal's pane suspended
 * while it runs. It runs in the user's working directory, its entry made
 * absolute in the staged dir, or, where `launchCwd` is `"install"`, in the
 * staged dir. Its environment is fabr's with the runnable's `env` over it, and
 * its launch is ended (its teardown run) once it exits, however it ends.
 *
 * Resolves to the program's exit status. Rejects where the install cannot be
 * staged or the program cannot be started.
 */
export function runInteractive(cache: BuildCache, key: string, runnable: RunnableFileSet, callerArgs: string[]): Computable<number> {
  /* Stage into a kept work dir, on the store's filesystem: an install is
   * hardlinks into the store. */
  const dir = cache.holdKeptWorkDir(key);
  const argv = launchArgv(runnable, callerArgs, dir);
  return (
    stageInstall(cache, dir, runnable)
      /* The program owns the terminal while it runs. */
      .then(() => {
        const launch = startLaunch(runnable, dir, launchEnv(runnable));
        return withTerminalSuspended(() =>
          executeInteractive(findExecutable(argv[0], launchDir(runnable, dir)), argv.slice(1), launchDir(runnable, dir), launch.env)
        ).finally(() => launch.end());
      })
      .finally(() => cache.releaseKeptWorkDir(dir))
  );
}

/**
 * Bring the kept work dir `dir` to hold exactly `runnable`: by syncing what
 * changed from what it holds — `held`, or what was recorded of it — or, where
 * that is unknown, by clearing it and writing the lot. The record is cleared
 * while the dir changes, so a stage that never finishes leaves it unknown.
 */
function stageInstall(cache: BuildCache, dir: string, runnable: RunnableFileSet, held?: FileSet): Computable<void> {
  return (held !== undefined ? Computable.resolve<FileSet | undefined>(held) : cache.keptWorkDirRecord(dir)).then(before =>
    cache
      .recordKeptWorkDir(dir, undefined)
      .then(() =>
        before !== undefined
          ? syncFileSet(dir, before, runnable).then(() => undefined)
          : deleteTree(dir).then(() => writeFileSet(dir, runnable))
      )
      .then(() => cache.recordKeptWorkDir(dir, runnable))
  );
}

/** Make the argv for launching `runnable` staged at `dir`: install-relative for
 * a runnable launched in the install (`launchCwd: "install"`), else made
 * absolute in `dir`. */
function launchArgv(runnable: RunnableFileSet, callerArgs: string[], dir: string): string[] {
  return toArgv(runnable.toCommandLine(callerArgs), runnable.launchCwd === "install" ? undefined : dir);
}

/** Choose the launch directory: `dir` for a runnable launched in the install,
 * else undefined (the caller's). */
function launchDir(runnable: RunnableFileSet, dir: string): string | undefined {
  return runnable.launchCwd === "install" ? dir : undefined;
}

/** Make the launch environment override: this process's own with the runnable's
 * variables over it, or none (inherit it as it is) where the runnable has none. */
function launchEnv(runnable: RunnableFileSet): Record<string, string> | undefined {
  if (runnable.env.size === 0) {
    return undefined;
  }
  const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.fromEntries([...inherited, ...runnable.env]);
}

/** How long a child stopped for a restart has to exit after SIGTERM before
 * its process group is sent SIGKILL. */
const RESTART_GRACE_MS = 2000;

const DIAG_RESTART = Diagnostic.Info<{ name: string }>("Restarting {name}");
const DIAG_UPDATE = Diagnostic.Info<{ name: string; count: number }>("Updating {name} content ({count} files)");
const DIAG_RUN_ERROR = Diagnostic.Error<{ name: string; message: string }>("Failed to launch {name}: {message}");

/** One staged install of the program, in a kept work dir, and the child running it once launched. */
interface Install {
  readonly dir: string;
  /** The key of the program staged: its program manifest, launch argv and variables. */
  readonly programKey: string;
  /** What the dir holds, as fabr last wrote it; undefined where a write into it
   * failed, so its contents are unknown until it is written whole. */
  held: FileSet | undefined;
  /** The `served` content the dir holds. */
  served: FileSet;
  /** The last write into the dir queued, each queued behind the one before so
   * none interleaves with another. Once the newest has landed it is replaced
   * by a settled node, so the install holds no chain of writes. */
  writes: Computable<void>;
  /** The number of the most recently queued sync. Only the newest write (that
   * sync, or the staging write where none is queued) may replace `writes`: an
   * earlier one finishing later must leave it in place. */
  writeSeq: number;
  /** The child running from the dir; undefined until launched and once it has exited. */
  child?: ChildProcess;
  /** The child's launch, ended (its teardown run) once the child has exited. */
  launch?: ILaunch;
}

/**
 * The supervisor of `fabr run -w`'s program: one child, launched from the
 * runnable each {@link update} is given, across the watch session.
 *
 * Each update is compared with the install the supervisor is committed to on
 * two keys:
 * - the **program key**: the program's manifest (`programManifest`, the
 *   install less its `served` content), its launch argv and its `env`. A
 *   change stages a new install, then stops the running child (SIGTERM, then
 *   SIGKILL after {@link RESTART_GRACE_MS}) and launches the new one once the
 *   old has exited, logging "Restarting" where one was running.
 * - the **served content**: where only it changed, it is synced into the
 *   committed install's dir in place (syncFileSet, each file replaced
 *   atomically), with no restart, logging "Updating … content".
 *
 * A runnable with no `served` content relaunches on every change of its
 * program key. Installs are kept work dirs of the program (`key`): a new one
 * is staged into the dir a finished child left, else into a slot an earlier
 * session left, else a new one, by syncing what changed, while the old child
 * keeps running from its own. A child that exits on its own is not relaunched
 * until the next update. On fabr's exit every child's process group is killed
 * ({@link stop}); the dirs are kept for the next session.
 */
export class RunSupervisor {
  /** Every install staged on disk, so a shutdown releases the lot. */
  private readonly installs = new Set<Install>();
  /** The install a finished child left, if any, for the next relaunch to sync into. */
  private spare?: Install;
  /** The install committed to: running, or staged and waiting for the old
   * child to exit; undefined where the next update stages and launches. Judge
   * an update against this, not against the install running: mid-swap, an edit
   * reverting to the running program must still supersede the swap. */
  private target?: Install;
  /** The install whose child is live. */
  private current?: Install;
  /** The number of the newest update that changed the program; a stage, swap
   * or sync started by an older one stops where it finds this changed. */
  private generation = 0;

  constructor(
    private readonly cache: BuildCache,
    private readonly key: string,
    private readonly name: string,
    private readonly callerArgs: string[],
    private readonly log: Log
  ) {
    /* Kill the children however fabr ends. This needs the process to end
     * through `process.exit`: the watch driver handles SIGINT, SIGTERM and
     * SIGHUP by calling it, where a default signal disposition would skip the
     * hook. */
    process.on("exit", () => this.stop());
  }

  /** React to a newly settled runnable: relaunch where its program changed,
   * sync in place where only its served content did. Settles when the reaction
   * is done (the child swapped, the sync applied, or nothing to do, or a newer
   * update superseded it). Never rejects: a failure is logged. */
  public update(runnable: RunnableFileSet): Computable<void> {
    /* The command line's key text names no staged dir, so a restage alone
     * does not change it. */
    const variables = [...runnable.env].map(([name, value]) => `${name}=${value}`).join("\0");
    const programKey = `${runnable.programManifest()}\n$ ${manifestArguments(runnable.toCommandLine(this.callerArgs))}\n${variables}`;
    if (programKey === this.target?.programKey) {
      return this.updateContent(runnable);
    }
    const wasRunning = this.current !== undefined;
    const generation = ++this.generation;
    /* Stage the new install before stopping the running child, which keeps
     * running where staging fails. */
    const spare = this.spare;
    this.spare = undefined;
    const install: Install = {
      dir: spare?.dir ?? this.cache.holdKeptWorkDir(this.key),
      programKey,
      held: runnable,
      served: runnable.served,
      writes: Computable.resolve(undefined),
      writeSeq: 0,
    };
    this.installs.add(install);
    /* Commit as staging starts: a later update is judged against this
     * install, and a content sync lands in it, whether or not the child has
     * been swapped to it yet. */
    this.target = install;
    const argv = launchArgv(runnable, this.callerArgs, install.dir);
    /* A restage into the spare queues behind the writes still landing in it,
     * and starts from what they left: `held` is read once they are done. */
    const staged = (spare?.writes ?? Computable.resolve(undefined)).then(() =>
      stageInstall(this.cache, install.dir, runnable, spare?.held)
    );
    /* Syncs into this install queue behind its staging write. Once that has
     * landed, replace `writes` with a settled node, or each install would hold
     * the spare it was staged from, back through every install of the session. */
    const seq = install.writeSeq;
    let collapsed = false;
    const landed = (): undefined => {
      if (seq === install.writeSeq) {
        install.writes = Computable.resolve(undefined);
        collapsed = true;
      }
      return undefined;
    };
    const gate = staged.then(landed, landed);
    if (!collapsed) {
      install.writes = gate;
    }
    return staged.then(
      () => this.swap(install, argv, runnable, generation, wasRunning),
      err => {
        /* What a failed write left in the directory is unknown; its record says so. */
        this.discard(install);
        this.logRunError(err);
      }
    );
  }

  /** Swap to the staged `install`: stop the old child, if any, and launch the
   * new one once the old has exited (a server holds its port until then).
   * Resolves once the new child is launched, or the update was superseded and
   * `install` retired. */
  private swap(
    install: Install,
    argv: string[],
    runnable: RunnableFileSet,
    generation: number,
    wasRunning: boolean
  ): Computable<void> {
    /* A newer update came while this one staged: retire this install and
     * leave the running child to the newer update. */
    if (generation !== this.generation) {
      this.retire(install);
      return Computable.resolve(undefined);
    }
    const old = this.current?.child;
    if (!old) {
      this.launch(install, argv, runnable, generation, wasRunning);
      return Computable.resolve(undefined);
    }
    /* Launch once the old child has exited, whether on SIGTERM or on the
     * SIGKILL after the grace period. Its own exit handler ({@link onChildGone})
     * retires its install. */
    return Computable.from(resolve => {
      old.once("exit", () => {
        this.launch(install, argv, runnable, generation, wasRunning);
        resolve(undefined);
      });
      this.stopChildGroup(old);
    });
  }

  /** Launch `install`'s child, unless a newer update superseded it while the
   * old child was exiting, in which case `install` is retired. A failure to
   * launch is logged, and the install discarded. */
  private launch(install: Install, argv: string[], runnable: RunnableFileSet, generation: number, wasRunning: boolean): void {
    if (generation !== this.generation) {
      this.retire(install);
      return;
    }
    try {
      if (wasRunning) {
        this.log.log(DIAG_RESTART, { name: this.name });
      }
      const launch = startLaunch(runnable, install.dir, launchEnv(runnable));
      install.launch = launch;
      const child = spawnInteractive(
        findExecutable(argv[0], launchDir(runnable, install.dir)),
        argv.slice(1),
        launchDir(runnable, install.dir),
        launch.env
      );
      /* The program owns the terminal until it exits ({@link onChildGone}
       * resumes it); only the pane stands down, and fabr's log lines still print. */
      suspendActiveTerminal();
      install.child = child;
      this.current = install;
      /* `target` was set when this install was staged. */
      child.on("error", err => this.onChildGone(install, err));
      child.on("exit", () => this.onChildGone(install));
    } catch (err) {
      this.discard(install);
      this.logRunError(err);
    }
  }

  /** Forget an install that failed to stage or launch, and give up its dir.
   * Where it was the `target`, the next update stages afresh. */
  private discard(install: Install): void {
    this.forget(install);
    this.cache.releaseKeptWorkDir(install.dir);
  }

  /** Forget an install whose contents are as fabr wrote them — superseded, or its
   * child has gone — keeping its directory as the spare, or giving it up where
   * there is one already. */
  private retire(install: Install): void {
    if (!this.installs.has(install)) {
      return;
    }
    this.forget(install);
    if (this.spare === undefined) {
      this.spare = install;
    } else {
      this.cache.releaseKeptWorkDir(install.dir);
    }
  }

  /** Drop `install` from the installs held, and from `target` where it is that. */
  private forget(install: Install): void {
    this.installs.delete(install);
    if (this.target === install) {
      this.target = undefined;
    }
  }

  private logRunError(err: unknown): void {
    this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err instanceof Error ? err.message : String(err) });
  }

  /** Send a child's whole process group SIGTERM, and SIGKILL after
   * {@link RESTART_GRACE_MS}. The timer is unref'd, so it never keeps the
   * process alive. */
  private stopChildGroup(child: ChildProcess): void {
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => killProcessGroup(child, "SIGKILL"), RESTART_GRACE_MS).unref();
  }

  /** Sync `runnable`'s served content into the committed install's dir in
   * place, the program being unchanged, where it differs from what the dir
   * holds; a dir whose contents are unknown is written whole. Queued behind
   * the install's writes, so they apply in the order the updates came. A
   * restart before the sync starts cancels it; a sync that has started runs
   * to its end, and the install's `held` and record follow what it wrote.
   * Settles once the sync has landed or was not needed. Never rejects: a
   * failure is logged, and leaves `held` unknown. */
  private updateContent(runnable: RunnableFileSet): Computable<void> {
    const target = this.target;
    if (target === undefined) {
      return Computable.resolve(undefined);
    }
    const generation = this.generation;
    const seq = ++target.writeSeq;
    /* Replace `writes` with a settled node on every way out, including
     * nothing to do, so the install holds no chain of syncs. */
    let collapsed = false;
    const finish = (): undefined => {
      if (seq === target.writeSeq) {
        target.writes = Computable.resolve(undefined);
        collapsed = true;
      }
      return undefined;
    };
    const sync = target.writes.then(() => {
      if (
        generation !== this.generation ||
        (target.held !== undefined && target.served.toManifest() === runnable.served.toManifest())
      ) {
        return finish();
      }
      /* A dir whose contents are unknown (a write into it failed) is written whole. */
      const write =
        target.held === undefined
          ? stageInstall(this.cache, target.dir, runnable).then(() => runnable.served.size)
          : this.cache
              .recordKeptWorkDir(target.dir, undefined)
              .then(() => syncFileSet(target.dir, target.served, runnable.served))
              .then(({ written, removed }) => this.cache.recordKeptWorkDir(target.dir, runnable).then(() => written + removed));
      return write.then(
        count => {
          target.served = runnable.served;
          target.held = runnable;
          if (generation === this.generation) {
            this.log.log(DIAG_UPDATE, { name: this.name, count });
          }
          finish();
        },
        err => {
          target.held = undefined;
          if (generation === this.generation) {
            this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err instanceof Error ? err.message : String(err) });
          }
          finish();
        }
      );
    });
    /* A sync with nothing to do runs `finish` while `then` is still making
     * `sync`; taking `sync` as `writes` then would hold the chain again. */
    if (!collapsed) {
      target.writes = sync;
    }
    return sync;
  }

  /** Drop `install`'s child once it has ended (it exited, or failed to spawn,
   * `err` then logged): resume the terminal, end its launch and retire the
   * install. The next update launches a child again. */
  private onChildGone(install: Install, err?: Error): void {
    if (install.child === undefined) {
      /* `error` and `exit` can both fire for one child: act on the first only,
       * or the second resume would lift another suspension. */
      return;
    }
    if (err) {
      this.log.log(DIAG_RUN_ERROR, { name: this.name, message: err.message });
    }
    /* End the launch (run its teardown) before anything relaunches. */
    resumeActiveTerminal();
    install.launch?.end();
    install.launch = undefined;
    install.child = undefined;
    if (this.current === install) {
      this.current = undefined;
    }
    this.retire(install);
  }

  /** Send every live child's whole process group SIGKILL, end each launch, and
   * give up every install's dir, leaving it on disk for the next session as
   * its record describes it. Synchronous, so it can run from a
   * `process.on("exit")` hook. */
  public stop(): void {
    for (const install of this.installs) {
      if (install.child) {
        killProcessGroup(install.child, "SIGKILL");
      }
      install.launch?.end();
      this.cache.releaseKeptWorkDir(install.dir);
    }
    if (this.spare !== undefined) {
      this.cache.releaseKeptWorkDir(this.spare.dir);
      this.spare = undefined;
    }
    this.installs.clear();
    this.target = undefined;
    this.current = undefined;
  }
}
