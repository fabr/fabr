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
import { Computable } from "../core/Computable";
import { FileSource } from "../core/FileSet";
import { Log } from "../support/Log";
import { Semaphore } from "../support/Semaphore";
import { declName, ITargetDecl } from "./AST";
import { Constraints } from "./Constraints";

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
 * A target actually starting to build (a build-cache miss, as opposed to being
 * served from cache) — either a declared target or an anonymous sub-target of
 * one (a sub-target is a target too: it builds under a context with its own
 * constraints and operation, so it is not a separate event kind — it just
 * carries a `label`). The driver renders "Building X" for a declared target and
 * e.g. "Compiling X" for a labelled sub-target.
 */
export interface ITargetBuildEvent {
  kind: "target-build";
  target: ITargetDecl;
  /** The BUILD_OPERATION the evaluation is running under ('build', 'test', ...) */
  operation: string;
  /** The full constraint set the target is building under. The driver decides
   * what to surface (it elides the ambient keys it injected — the host facts
   * and BUILD_OPERATION — leaving the explicit ones, e.g. a reference's
   * `<BUILD_TYPE=release>` requirement or a `-D` override). */
  constraints: Constraints;
  /** The targets that required this one (nearest requester first; empty for a
   * target requested directly, and for a sub-target — the umbrella declared
   * event carries the chain). */
  requiredBy: ITargetDecl[];
  /** For an anonymous sub-target: the action verb its creator gave it
   * ("Compiling"), used verbatim as the display verb; absent for a declared
   * target, where the driver derives the verb from `operation`. */
  label?: string;
}

/**
 * A repository actually resolving a batch of requirements (as opposed to the
 * resolution being served from a memo). Emitted by the repository's own
 * implementation, since only it knows when real resolution work happens.
 */
export interface IRepositoryResolveEvent {
  kind: "repository-resolve";
  /** The repository the requirements are resolved against, as the references
   *  wrote it (the declared alias) — the resolution layer holds no decl. */
  repository: string;
  /** The requirement keys of the joint batch */
  requirements: string[];
}

/**
 * A URL actually being fetched (as opposed to served from cache).
 */
export interface IFetchEvent {
  kind: "fetch";
  url: string;
  /** The target (usually a repository) on whose behalf the fetch happens */
  target: ITargetDecl;
  /**
   * An optional human noun for what is being fetched (e.g. "metadata",
   * "package"), supplied by the repository so the driver can distinguish kinds
   * of download; the URL alone is opaque.
   */
  resource?: string;
}

/**
 * Progress: work that is actually being performed, as opposed to being
 * served from cache — never emitted for a cache hit. The model and rules
 * only emit events — rendering them is the listener's (i.e. the driver's)
 * job.
 */
export type ProgressEvent = ITargetBuildEvent | IRepositoryResolveEvent | IFetchEvent;

export type ProgressListener = (event: ProgressEvent) => void;

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

  public get current(): number {
    return this.count;
  }

  /** Advance to the next build cycle (watch mode, before re-settling the graph). */
  public advance(): void {
    this.count++;
  }
}

/**
 * The fixed runtime surroundings of a build run, as distinct from the model
 * (which is purely the declarations as written): the build cache to run
 * against, the driver's diagnostic log, and its progress observer. Constructed
 * by the driver and threaded through getConfig(), so every BuildContext of a
 * run — including the constraint-override configs spawned during evaluation —
 * shares the one instance.
 *
 * The `log` is here as a run-surrounding the *driver* reads (status lines, the
 * failure tree); the model still only ever emits ProgressEvents and never logs
 * — reporting stays the driver's job.
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
  private progressListener?: ProgressListener;
  /** Whether a subcommand's output is captured to a buffer and shown only on
   * failure (`-q`), rather than inherited live to fabr's stderr as the step runs.
   * Read by {@link BuildContext.runAction} into each action's context; set by the
   * driver, and defaults to inherit-live. */
  public quiet = false;
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
  /** The top-level (directly-requested) targets that had work performed for
   * them since the last {@link takeBuiltTargets} — accumulated from
   * `target-build` progress events (emitted only from a cache-miss path — never
   * a cache hit), so an empty set is exactly "nothing happened". A dependency's
   * build is *attributed to the requester at the end of its demand chain* (the
   * directly-requested target), not recorded under its own name: the set
   * answers "which of the run's requests did this cycle do work for", so a
   * request whose own evaluation yields no action (a `serve` target whose
   * `files` dependency rebuilt) still counts as built. Sub-target events (a
   * `label`) are skipped — their declared owner announces alongside. The driver
   * reports these names per watch cycle. */
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
  }

  /**
   * @return the declared targets that built since the previous call (or since the
   * start), clearing that baseline — so each watch-mode rebuild reports only what
   * it did. A one-shot run calls this once; an empty list means the run had no
   * effect ("already up to date").
   */
  public takeBuiltTargets(): string[] {
    const names = [...this.builtTargets];
    this.builtTargets.clear();
    return names;
  }

  /** The current build cycle — a target's per-cycle announce flag is keyed by it
   *  (see {@link BuildCycle}). */
  public get buildGeneration(): number {
    return this.cycle.current;
  }

  /**
   * Install the progress listener notified as work is actually performed.
   */
  public onProgress(listener: ProgressListener): void {
    this.progressListener = listener;
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

  public notifyProgress(event: ProgressEvent): void {
    /* Record the *top-level* target each build serves, for the driver's
     * per-cycle status line: the announced target itself when directly
     * requested, else the outermost requester on its demand chain
     * (`requiredBy` is nearest-first, so its last element). Every event is
     * from a cache-miss path. */
    if (event.kind === "target-build" && event.label === undefined) {
      const topLevel = event.requiredBy.length > 0 ? event.requiredBy[event.requiredBy.length - 1] : event.target;
      this.builtTargets.add(declName(topLevel));
    }
    this.progressListener?.(event);
  }
}
