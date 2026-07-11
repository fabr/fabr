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

import { BuildCache } from "../core/BuildCache";
import { Log } from "../support/Log";
import { ITargetDecl } from "./AST";

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
   * `<BUILD_TYPE=release>` delta or a `-D` override). */
  constraints: Record<string, string>;
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
  /** The repository target the requirements are resolved against */
  repository: ITargetDecl;
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
  private progressListener?: ProgressListener;
  private generation = 0;
  /** Work signalled this run and the amount already reported, so watch mode can
   * take a per-rebuild delta. Counted from the progress events (every one is
   * emitted from a cache-miss path — never a cache hit), so "work happened" is
   * exactly "some progress event fired"; no separate tally is threaded through
   * the store. */
  private workSignals = 0;
  private reportedWork = 0;

  constructor(buildCache: BuildCache, log: Log) {
    this.buildCache = buildCache;
    this.log = log;
  }

  /**
   * @return the number of work events (builds/fetches/resolutions) since the
   * previous call (or since the start), resetting that baseline — so each
   * watch-mode rebuild reports only what it did. A one-shot run calls this once;
   * zero means the run had no effect ("already up to date").
   */
  public takeBuildCount(): number {
    const delta = this.workSignals - this.reportedWork;
    this.reportedWork = this.workSignals;
    return delta;
  }

  /**
   * A monotonically increasing "build cycle" counter. In watch mode the driver
   * advances it before each rebuild so a target that already announced itself in
   * an earlier cycle announces again for the new one (the per-target announce
   * flag is keyed by this, not a plain boolean).
   */
  public get buildGeneration(): number {
    return this.generation;
  }

  /** Advance to the next build cycle (watch mode, before re-settling the graph). */
  public beginBuildCycle(): void {
    this.generation++;
  }

  /**
   * Install the progress listener notified as work is actually performed.
   */
  public onProgress(listener: ProgressListener): void {
    this.progressListener = listener;
  }

  public notifyProgress(event: ProgressEvent): void {
    /* Every progress event marks real work (never a cache hit), so this doubles
     * as the "was anything done" tally the driver's status line reads. */
    this.workSignals++;
    this.progressListener?.(event);
  }
}
