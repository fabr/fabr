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
import { FileSource } from "../core/FileSet";
import { activityCounter, ITaskReport } from "../support/Execute";
import { Log } from "../support/Log";
import { Semaphore } from "../support/Semaphore";
import { declName, ITargetDecl } from "./AST";
import { BuildEvent, BuildListener, TaskDescription, TaskProgress, TaskState } from "./BuildEvents";

/**
 * The driver's terminal, for the rare interaction a protocol genuinely requires
 * mid-run (an npm publish demanding a second factor). Present on the
 * ExecutionContext only when fabr is attached to an interactive terminal;
 * absent under redirection/CI, which a caller treats as "non-interactive" and
 * turns into a typed error naming the unattended alternatives. Model and rule
 * code never reads or renders the terminal itself — it asks through this
 * surface, and the driver owns how the asking looks.
 */
export interface UserInteraction {
  /** Ask a one-line question on the terminal; resolves to the line entered. */
  prompt(question: string): Computable<string>;
  /**
   * Send the user's browser to `url` for a ceremony performed there,
   * announced with `purpose`. The URL itself is always displayed, so a failed
   * launch — or a remote session with no local browser — still leaves it
   * actionable. Resolves once the browser has been dispatched; the ceremony's
   * completion is observed by the caller (e.g. by polling), not here.
   */
  openUrl(url: string, purpose: string): Computable<void>;
}

/**
 * A typed handle a plugin uses to stash its own per-run state on the
 * ExecutionContext — the plugin equivalent of core simply holding a field here.
 * One key per plugin; `T` is the plugin's context object. Identity is by object
 * (the `name` is debug-only), so two keys never collide even with the same name.
 * A plugin declares one as a module constant and reads its state back through
 * {@link ExecutionContext.getOrCreatePluginContext}.
 */
export class PluginKey<T> {
  constructor(public readonly name: string) {}
  /* Makes T load-bearing at the type level (never assigned). */
  declare private readonly _type: T;
}

/**
 * The monotonic build-cycle counter. In watch mode the driver advances it once
 * per applied batch (before the graph re-settles), so a target that already
 * announced itself in an earlier cycle announces again for the new one (the
 * per-target announce flag is keyed by the cycle, not a plain boolean). Split out
 * of the ExecutionContext so the watch controller and the execution can share it
 * WITHOUT a construction cycle — the controller is built with the source FS, which
 * the execution then holds, so it's built first and both are wired to it.
 */
export class BuildCycle {
  private count = 0;
  private readonly observers: Array<(cycle: number) => void> = [];

  public get current(): number {
    return this.count;
  }

  /** Advance to the next build cycle (watch mode, before re-settling the
   *  graph), notifying observers with the new cycle's number. */
  public advance(): void {
    this.count++;
    this.observers.forEach(observer => observer(this.count));
  }

  /** Observe each advance — how the execution turns the watch controller's
   *  cycle boundary into a `cycle-start` build event. */
  public onAdvance(observer: (cycle: number) => void): void {
    this.observers.push(observer);
  }
}

/**
 * The fixed runtime surroundings of a build run, as distinct from the model
 * (which is purely the declarations as written): the build cache to run
 * against, the driver's diagnostic log, and its build-event listeners.
 * Constructed by the driver and threaded through getConfig(), so every
 * BuildContext of a run — including the constraint-override configs spawned
 * during evaluation — shares the one instance.
 *
 * The `log` is here as a run-surrounding the *driver* reads (status lines, the
 * failure tree); the model still only ever emits BuildEvents and never logs —
 * reporting stays the driver's job.
 */
export class ExecutionContext {
  public readonly buildCache: BuildCache;
  public readonly log: Log;
  /**
   * The project's source tree (the tree containing PROJECT.fabr), watched when
   * watch mode is enabled.
   */
  public readonly sourceFileSource: FileSource;
  /**
   * A FileSource for reading files by absolute path, for general host filesystem
   * access — the loader's plugin/core lib `.fabr` files, and absolute config a
   * repository consults (e.g. a user `~/.npmrc`). Not watched.
   */
  public readonly absFileSource: FileSource;
  /** The build-cycle counter, shared with the watch controller (which advances it). */
  private readonly cycle: BuildCycle;
  /** The build-event subscribers (the driver's renderer, and the execution's
   *  own built-target record). */
  private readonly listeners: BuildListener[] = [];
  /** Whether any subscriber asked for `task-output` events; with none, a step
   *  is given no output sink and captures instead. */
  private wantsOutput = false;
  /** Identities for {@link runTask}; per-run, so a listener may key its own
   *  per-task state (a start time, a pane row) by them. */
  private nextTaskId = 1;
  /**
   * The targets this run must rebuild even when their outputs are already
   * cached (the driver's `-f`) — for timing a build step whose inputs have not
   * changed. Held by *declaration*, so it says exactly what the command line
   * named: a target's own sub-targets are forced with it (they are its work,
   * asked through their declared owner — see {@link BuildContext.runAction}),
   * its dependencies are not, and neither is decided by inference. Nothing is
   * forced by default.
   *
   * Naming what to force is the only workable form: the cache key identifies
   * the work and never who asked for it, so "force" cannot be a property of an
   * entry — only of the run's request for it.
   */
  private readonly forcedTargets = new Set<ITargetDecl>();

  /** Mark a target as one to rebuild rather than serve from cache. */
  public forceTarget(target: ITargetDecl): void {
    this.forcedTargets.add(target);
  }

  public isForced(target: ITargetDecl): boolean {
    return this.forcedTargets.has(target);
  }
  /** The interactive terminal, when there is one — see {@link UserInteraction}.
   * Set by the driver only when attached to a tty; its absence is the
   * "non-interactive run" signal. */
  public interaction?: UserInteraction;
  /**
   * Bounds how many build actions run at once — the run-wide execution budget,
   * held here because it is a property of the run's surroundings (the machine),
   * shared by every BuildContext of the run, and no concern of the cache.
   * Without it a cold build of a wide graph spawns a process per cache miss
   * simultaneously; the machine's parallelism is what that work can actually
   * use.
   *
   * The unit admitted is the *process execution*, acquired around exactly the
   * process lifetime by {@link IActionContext.execute} — with one refinement: a
   * command pipeline's stages are pipe-wired and must co-run, so a pipeline is
   * ONE unit (admitting its stages individually could wedge it half-started).
   * Step code itself holds no slot — staging and collection are event-loop
   * I/O, not machine parallelism — so a step waiting on its processes never
   * holds a slot while waiting for one: no hold-and-wait, no deadlock, and a
   * step may fan out as many executions as it likes (the per-file test run).
   * Cache hits and the resolution memos sharing that cache queue for nothing.
   */
  public readonly processLimit = new Semaphore(availableParallelism());
  /** Per-run state a plugin keeps here, keyed by its {@link PluginKey}. Lazily
   *  populated on first access (see {@link getOrCreatePluginContext}). */
  private readonly pluginContexts = new Map<PluginKey<unknown>, unknown>();
  /** The top-level (directly-requested) targets that had tasks performed for
   * them since the last {@link endCycle}, reported on the cycle-end event. A
   * dependency's build is attributed to the outermost requester on its demand
   * chain, so the set answers "which of the run's requests did this cycle do
   * work for". Fed by {@link recordBuiltTarget}. */
  private readonly builtTargets = new Set<string>();

  constructor(
    buildCache: BuildCache,
    log: Log,
    sourceFileSource: FileSource,
    absFileSource: FileSource,
    /* Shared with the watch controller (which advances it); defaulted so a
     * non-watch construction — including tests — gets its own. */
    cycle: BuildCycle = new BuildCycle()
  ) {
    this.buildCache = buildCache;
    this.log = log;
    this.sourceFileSource = sourceFileSource;
    this.absFileSource = absFileSource;
    this.cycle = cycle;
    /* Subscribed first, so the built-target record is current by the time any
     * later listener sees the same event. */
    this.onBuildEvent(event => this.recordBuiltTarget(event));
    this.cycle.onAdvance(count => this.emit({ kind: "cycle-start", cycle: count }));
  }

  /**
   * Designate `evaluation` as the run's evaluation: each of its settlements
   * ends the current cycle. Called once per run ({@link Fabr.evaluate}); were a
   * second chain ever observed, {@link endCycle}'s guard keeps a cycle from
   * being reported twice.
   */
  public observeEvaluation(evaluation: ComputableSource<unknown>): void {
    /* The chain's dependant list keeps the sink alive; nothing to store. */
    new ComputableHandle(source => this.endCycle(source.state === ComputableState.Error)).seat(evaluation);
  }

  /** The last cycle a cycle-end was emitted for — the once-per-cycle guard. */
  private lastEndedCycle = -1;

  /** Emit the cycle-end for the current cycle, carrying everything built since
   *  the last report. */
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
   * Subscribe to the build event stream. `output: true` additionally requests
   * `task-output` events; with no output subscriber (`-q`, a headless run) a
   * step captures its subprocess output and reports it only on failure.
   */
  /* Listeners must not throw: an exception propagates into whatever emission
   * point fired (a task's create path, the watch flush). */
  public onBuildEvent(listener: BuildListener, options?: { output?: boolean }): void {
    this.listeners.push(listener);
    this.wantsOutput ||= options?.output === true;
  }

  /**
   * Perform `run` as one tracked task: emits task-start now and task-end when
   * the returned chain settles, either way. `run` receives the task's
   * {@link ITaskReport} for streaming its output, phases, and progress.
   */
  public runTask<T>(task: TaskDescription, run: (report: ITaskReport) => Computable<T>): Computable<T> {
    const id = this.nextTaskId++;
    /* Each task-progress carries the latest of both halves, so any single
     * status event is the task's whole condition. */
    let state: TaskState = "running";
    let latest: TaskProgress | undefined;
    const status = (): void => this.emit({ kind: "task-progress", id, task, state, progress: latest });
    const report: ITaskReport = {
      output: this.wantsOutput ? { line: line => this.emit({ kind: "task-output", id, task, line }) } : undefined,
      activity: activityCounter(next => {
        state = next;
        status();
      }),
      progress: measured => {
        latest = measured;
        status();
      },
    };
    this.emit({ kind: "task-start", id, task, state });
    const end = (failed: boolean): void => this.emit({ kind: "task-end", id, task, failed });
    /* A synchronous throw must still end the task, or the start dangles (a
     * phantom "running" row for the rest of a watch session). */
    let chain: Computable<T>;
    try {
      chain = run(report);
    } catch (err) {
      end(true);
      throw err;
    }
    return chain.then(
      result => {
        end(false);
        return result;
      },
      err => {
        end(true);
        throw err;
      }
    );
  }

  /** This run's state for `key`, or undefined if no plugin has established it
   *  yet. Use {@link getOrCreatePluginContext} to read-or-initialize in one step. */
  public getPluginContext<T>(key: PluginKey<T>): T | undefined {
    return this.pluginContexts.get(key as PluginKey<unknown>) as T | undefined;
  }

  /** This run's state for `key`, creating it on first access via `create` (so a
   *  plugin's per-run state — e.g. a parsed `.npmrc` — is built once and shared by
   *  all its instances across the run's BuildContexts). */
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

  /** Record the top-level target a task serves: the building target itself
   *  when directly requested, else the outermost requester on its demand chain
   *  (`requiredBy` is nearest-first, so its last element). */
  private recordBuiltTarget(event: BuildEvent): void {
    /* A labelled sub-task re-adds its owner (its description spreads the
     * owner's target/requiredBy); the Set absorbs the duplicate. */
    if (event.kind === "task-start" && event.task.kind === "target-build") {
      const { target, requiredBy } = event.task;
      this.builtTargets.add(declName(requiredBy.length > 0 ? requiredBy[requiredBy.length - 1] : target));
    }
  }
}
