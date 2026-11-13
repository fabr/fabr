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

import { availableParallelism } from "os";
import { BuildCache } from "../core/BuildCache";
import { Computable, ComputableHandle, ComputableSource, ComputableState } from "../core/Computable";
import { toError } from "../core/Errors";
import { FileSource } from "../core/FileSet";
import { AbsolutePathSource } from "../core/AbsolutePathSource";
import { FSFileSource } from "../core/FSFileSource";
import { IndexedFileSource } from "../core/IndexedFileSource";
import type { WatchController } from "../core/WatchController";
import { activityCounter, ITaskReport } from "../support/Execute";
import { Log } from "../support/Log";
import { Semaphore } from "../support/Semaphore";
import type { ISlsaBuild } from "../support/Slsa";
import { declName, ITargetDecl } from "./AST";
import { BuildEvent, BuildListener, TaskDescription } from "./BuildEvents";
import { TaskProgress, TaskState } from "../support/Tasks";

/**
 * The driver's terminal, for an interaction a protocol requires mid-run (an
 * npm publish asking for a second factor). Present on the ExecutionContext
 * only when fabr is attached to an interactive terminal; a caller that finds
 * it absent fails with an error naming the unattended alternatives.
 */
export interface UserInteraction {
  /** Ask a one-line question on the terminal; resolves to the line entered. */
  prompt(question: string): Computable<string>;
  /**
   * Open the user's browser at `url`, announced with `purpose`; the URL is
   * displayed too. Resolves once the browser has been launched: the caller
   * finds out itself when the user has finished there (e.g. by polling).
   */
  openUrl(url: string, purpose: string): Computable<void>;
}

/**
 * The issuer of OIDC identity tokens naming the CI job fabr runs in (GitHub
 * Actions, GitLab, CircleCI), which a publish destination exchanges for a
 * short-lived credential. Present on the ExecutionContext only where the job
 * has an identity. Only publish steps read it; a token must reach no cache
 * key, log line or error.
 */
export interface IdentityProvider {
  /** Get a freshly issued identity token (a JWT) for `audience`. */
  token(audience: string): Computable<string>;
  /** The job's build, as a provenance statement records it; absent where the
   *  job states none. */
  readonly build?: ISlsaBuild;
}

/**
 * A key a plugin keeps its per-run state under on the ExecutionContext, read
 * with {@link ExecutionContext.getOrCreatePluginContext}; `T` is the state's
 * type. Keys compare by identity (`name` is for debugging), so a plugin
 * declares one as a module constant.
 */
export class PluginKey<T> {
  constructor(public readonly name: string) {}
  /* Ties T to the type; never assigned. */
  declare private readonly _type: T;
}

/**
 * The build-cycle counter, starting at 0. The watch controller advances it
 * once per batch of changes it applies, and the ExecutionContext sharing it
 * emits a `cycle-start` for each advance.
 */
export class BuildCycle {
  private count = 0;
  private readonly observers: Array<(cycle: number) => void> = [];

  public get current(): number {
    return this.count;
  }

  /** Advance to the next build cycle, notifying observers with its number. */
  public advance(): void {
    this.count++;
    this.observers.forEach(observer => observer(this.count));
  }

  /** Call `observer` with the new cycle's number on each advance. */
  public onAdvance(observer: (cycle: number) => void): void {
    this.observers.push(observer);
  }
}

/**
 * The runtime surroundings of a build run, shared by every BuildContext of
 * the run (it is passed to `BuildModel.getConfig`): the build cache, the file
 * sources, the driver's log, the build-event listeners, the process limit and
 * the per-run settings the driver makes (forced targets, `retryFailed`, the
 * terminal and CI identity).
 *
 * The `log` is for the driver to write to; model code emits BuildEvents and
 * typed errors, and never logs.
 */
export class ExecutionContext {
  public readonly buildCache: BuildCache;
  public readonly log: Log;
  /** The project's source tree (the tree containing PROJECT.fabr), watched in
   *  watch mode. */
  public readonly sourceFileSource: FileSource;
  /**
   * A FileSource reading files by absolute host path: configuration a
   * repository reads (a user `~/.npmrc`, `~/.m2/settings.xml`). Not watched. Nothing read through it is copied into the cache, as it may
   * read credentials.
   */
  public readonly absFileSource: FileSource;
  /**
   * A FileSource reading the files of fabr's own installation by absolute path
   * (`fabr_home`), each copied into the cache's blob pool so it can be staged.
   * Not watched.
   */
  public readonly installedFileSource: FileSource;
  /**
   * A FileSource reading the host's files by absolute path where they lie,
   * identified by content: the programs `@host` names. Watched in watch mode,
   * a directory at a time.
   */
  public readonly hostFileSource: FileSource;
  /** The build-cycle counter, shared with the watch controller (which advances it). */
  private readonly cycle: BuildCycle;
  /** The build-event subscribers, in subscription order. */
  private readonly listeners: BuildListener[] = [];
  /** True if any subscriber asked for `task-output` events; with none, a
   *  task is given no output sink. */
  private wantsOutput = false;
  /** The next task id {@link runTask} gives out; ids are unique per run. */
  private nextTaskId = 1;
  /**
   * The declarations of the targets this run rebuilds even where their
   * outputs are cached (the driver's `-f`). A forced target's sub-targets are
   * forced with it (`BuildContextImpl.runAction` asks of their declared
   * owner); its dependencies are not.
   */
  private readonly forcedTargets = new Set<ITargetDecl>();

  /** Mark `target` to be rebuilt rather than served from the cache, under
   *  every constraint set. */
  public forceTarget(target: ITargetDecl): void {
    this.forcedTargets.add(target);
  }

  /** @return true if `target` is marked to be rebuilt, otherwise false. */
  public isForced(target: ITargetDecl): boolean {
    return this.forcedTargets.has(target);
  }

  /**
   * True if a failed test run found in the cache is performed again rather
   * than served (the driver's `--retry-failed`). It is retried once, from its
   * own last run, so a step keeping per-test-file state reruns only what
   * failed or changed; the outcome is committed like any other.
   */
  public retryFailed = false;
  /** The interactive terminal, set by the driver only when attached to a tty
   *  (see {@link UserInteraction}). */
  public interaction?: UserInteraction;
  /** The CI job's identity provider, when the job has an identity — see
   * {@link IdentityProvider}. Set by the driver. */
  public identityProvider?: IdentityProvider;
  /**
   * The run-wide limit on work running at once, one slot per CPU. A slot is
   * held for a process's lifetime by `execute`/`executePipeline` (a whole
   * pipeline takes one slot, since its stages must run together), and for a
   * step's staging and collection through `ActionContext.admit`. Never hold a
   * slot while acquiring another: that could deadlock. Cache hits take none.
   */
  public readonly processLimit = new Semaphore(availableParallelism());
  /** The per-run state plugins keep here, by {@link PluginKey}. */
  private readonly pluginContexts = new Map<PluginKey<unknown>, unknown>();
  /** The names of the directly requested targets that had tasks performed for
   *  them since the last {@link endCycle}, reported on the cycle-end event; a
   *  dependency's task counts for the outermost target that required it. */
  private readonly builtTargets = new Set<string>();

  constructor(
    buildCache: BuildCache,
    log: Log,
    sourceFileSource: FileSource,
    absFileSource: FileSource,
    /* Shared with the watch controller, which advances it. */
    cycle: BuildCycle = new BuildCycle(),
    hostFileSource: FileSource = hostFiles(buildCache),
    installedFileSource: FileSource = new AbsolutePathSource(root => new FSFileSource(root, undefined, buildCache))
  ) {
    this.buildCache = buildCache;
    this.log = log;
    this.sourceFileSource = sourceFileSource;
    this.absFileSource = absFileSource;
    this.installedFileSource = installedFileSource;
    this.cycle = cycle;
    this.hostFileSource = hostFileSource;
    /* Subscribed first, so the record is current when any other listener
     * sees the event. */
    this.onBuildEvent(event => this.recordBuiltTarget(event));
    this.cycle.onAdvance(count => this.emit({ kind: "cycle-start", cycle: count }));
  }

  /**
   * Designate `evaluation` as the run's evaluation: each of its settlements,
   * changed or not, ends the current cycle with a cycle-end. Called once per
   * run, by {@link Fabr.evaluate}; a cycle is never ended twice.
   */
  public observeEvaluation(evaluation: ComputableSource<unknown>): void {
    /* The chain's dependant list keeps the sink alive; nothing to store. */
    new ComputableHandle(source => this.endCycle(source.state === ComputableState.Error)).seat(evaluation);
  }

  /** The last cycle a cycle-end was emitted for. */
  private lastEndedCycle = -1;

  /** Emit the cycle-end for the current cycle, unless already emitted, with
   *  the targets built since the last one. */
  private endCycle(failed: boolean): void {
    const cycle = this.cycle.current;
    if (cycle === this.lastEndedCycle) {
      return;
    }
    this.lastEndedCycle = cycle;
    const built = [...this.builtTargets];
    this.builtTargets.clear();
    this.emit({ kind: "cycle-end", cycle, failed, built });
  }

  /**
   * Subscribe `listener` to the build-event stream. `output: true` also asks
   * for `task-output` events; with no subscriber asking, a step's process
   * output is shown only in a failure. The listener must not throw: an
   * exception propagates into whatever emitted the event.
   */
  public onBuildEvent(listener: BuildListener, options?: { output?: boolean }): void {
    this.listeners.push(listener);
    this.wantsOutput ||= options?.output === true;
  }

  /**
   * Perform `run` as one task described by `task`: emits task-start now and
   * task-end when the returned chain settles or `run` throws. `run` is given
   * the task's {@link ITaskReport}, for its output, its slot activity, its
   * progress and a failure of its own (`fail`), which ends the task failed
   * while its result still resolves.
   */
  public runTask<T>(task: TaskDescription, run: (report: ITaskReport) => Computable<T>): Computable<T> {
    const id = this.nextTaskId++;
    /* Each task-progress carries both the current state and the latest
     * measure. */
    let state: TaskState = "running";
    let latest: TaskProgress | undefined;
    let failure: Error | undefined;
    const status = (): void => this.emit({ kind: "task-progress", id, task, state, progress: latest });
    const report: ITaskReport = {
      output: this.wantsOutput ? { line: (line, stream) => this.emit({ kind: "task-output", id, task, line, stream }) } : undefined,
      activity: activityCounter(next => {
        state = next;
        status();
      }),
      progress: measured => {
        latest = measured;
        status();
      },
      fail: error => {
        failure = error;
      },
    };
    this.emit({ kind: "task-start", id, task, state });
    const end = (failed: boolean, error?: unknown): void =>
      this.emit({ kind: "task-end", id, task, failed, ...(failed ? { error: toError(error) } : {}) });
    /* End the task on a synchronous throw too, or its start is never
     * paired. */
    let chain: Computable<T>;
    try {
      chain = run(report);
    } catch (err) {
      end(true, err);
      throw err;
    }
    return chain.then(
      result => {
        end(failure !== undefined, failure);
        return result;
      },
      err => {
        end(true, err);
        throw err;
      }
    );
  }

  /** Get this run's state for `key`, or undefined if none has been made. */
  public getPluginContext<T>(key: PluginKey<T>): T | undefined {
    return this.pluginContexts.get(key as PluginKey<unknown>) as T | undefined;
  }

  /** Get this run's state for `key`, made with `create` on first access and
   *  shared by every BuildContext of the run. */
  public getOrCreatePluginContext<T>(key: PluginKey<T>, create: () => T): T {
    let context = this.getPluginContext(key);
    if (context === undefined) {
      context = create();
      this.pluginContexts.set(key as PluginKey<unknown>, context);
    }
    return context;
  }

  /** Deliver an event to every subscriber, in subscription order. */
  private emit(event: BuildEvent): void {
    this.listeners.forEach(listener => listener(event));
  }

  /** Record the directly requested target a target-build task serves: the
   *  target itself, or the last of its `requiredBy` (nearest first). */
  private recordBuiltTarget(event: BuildEvent): void {
    /* A sub-target's task names its owner's target, which may already be in
     * the set. */
    if (event.kind === "task-start" && event.task.kind === "target-build") {
      const { target, requiredBy } = event.task;
      this.builtTargets.add(declName(requiredBy.length > 0 ? requiredBy[requiredBy.length - 1] : target));
    }
  }
}

/** Make the FileSource of the host's files: by absolute path, read in place
 *  and watched a directory at a time (see {@link ExecutionContext.hostFileSource}). */
export function hostFiles(cache: BuildCache, watchController?: WatchController): AbsolutePathSource<IndexedFileSource> {
  return new AbsolutePathSource(root => new IndexedFileSource(root, cache, { read: "in-place", watch: "queried" }, watchController));
}
