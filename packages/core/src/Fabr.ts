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

import { PROJECT_FILENAME } from "./Constants";
import { BuildCache } from "./core/BuildCache";
import { Computable } from "./core/Computable";
import { FSFileSource } from "./core/FSFileSource";
import { SourceRef } from "./core/Repository";
import { getSourceFileSource, SourceFileSource } from "./core/SourceFileSource";
import { WatchController } from "./core/WatchController";
import { BuildContext } from "./model/BuildContext";
import { BuildModel } from "./model/BuildModel";
import { BuildCycle, ExecutionContext } from "./model/ExecutionContext";
import { reportFailure } from "./model/ErrorFormatter";
import { loadProject } from "./model/Loader";
import { SyncSource } from "./rules/BuildSync";
import { Diagnostic, Log } from "./support/Log";

const DIAG_WATCH_WARNING = Diagnostic.Warn<{ message: string }>("{message}");

/** Quiet window (ms) collapsing a burst of filesystem events into one watch
 *  rebuild — long enough to coalesce an editor's save, short enough to feel
 *  live. */
export const WATCH_QUIET_MS = 100;

export interface IFabrOptions {
  /** Root of the project source tree (the directory holding PROJECT.fabr). */
  sourceRoot: string;
  /** The build cache directory. */
  cacheRoot: string;
  /** The run's diagnostic log (written by the engine, rendered by the driver). */
  log: Log;
  /** Watch the source tree: filesystem changes become build cycles. */
  watch?: boolean;
}

/**
 * One fabr run — the central interface between a driver (the CLI, an IDE, an
 * embedder) and the engine. Construction assembles the run's surroundings
 * (cache, build cycle, watch controller, source tree) around an
 * {@link ExecutionContext}; the driver subscribes to build events
 * ({@link ExecutionContext.onBuildEvent}), evaluates operations against the
 * loaded model ({@link evaluate}), and composes its rendering onto their
 * results. Process policy — exit codes, signals, the terminal — stays the
 * driver's.
 */
export class Fabr {
  public readonly execution: ExecutionContext;
  /** The project source tree, concretely — the write-back face the driver's
   *  invocation site needs (the execution holds it as a plain FileSource). */
  public readonly sourceFileSource: SourceFileSource;
  /** Present when watching; the driver drives shutdown through {@link WatchController.close}. */
  public readonly controller?: WatchController;
  /** The run's cycle counter — what {@link maybeCollectGarbage}'s preemption
   *  watches. */
  private readonly cycle: BuildCycle;

  constructor(options: IFabrOptions) {
    const cache = new BuildCache(options.cacheRoot, options.log);
    /* Shared: the controller advances it per applied batch; the execution
     * reads it and emits the cycle boundaries. */
    const cycle = new BuildCycle();
    this.cycle = cycle;
    /* Watcher errors take the one error-reporting path; notices are
     * infrastructure diagnostics, logged like BuildCache's own. */
    this.controller = options.watch
      ? new WatchController(
          WATCH_QUIET_MS,
          undefined,
          err => reportFailure(options.log, err),
          () => cycle.advance(),
          message => options.log.log(DIAG_WATCH_WARNING, { message })
        )
      : undefined;
    this.sourceFileSource = getSourceFileSource(options.sourceRoot, cache, this.controller);
    this.execution = new ExecutionContext(cache, options.log, this.sourceFileSource, new FSFileSource("/"), cycle);
    /* The source index persists per settled cycle — cycle-end fires even when
     * every recomputed value was identical (a touch without an edit), which is
     * exactly when rows changed but no result did — and drains ungated when
     * the watch controller closes (the driver awaits close before exit).
     * Under watch, the daily cache trim rides the same settled moment, after
     * the record lands; a one-shot run's trim is instead the driver's, which
     * alone can hold the process exit for it. */
    this.execution.onBuildEvent(event => {
      if (event.kind === "cycle-end") {
        const persisted = this.sourceFileSource.persistIndex();
        if (this.controller) {
          persisted.then(() => this.maybeCollectGarbage());
        }
      }
    });
    this.controller?.track(
      () => new Promise<void>(resolve => this.sourceFileSource.persistIndex(true).then(() => resolve(), () => resolve()))
    );
  }

  /**
   * Load the project and evaluate `operation` against its model, as the run's
   * evaluation: each settlement ends the current build cycle (see
   * {@link ExecutionContext.observeEvaluation}).
   */
  public evaluate<T>(operation: (model: BuildModel) => Computable<T>): Computable<T> {
    const evaluation = loadProject(this.execution, PROJECT_FILENAME).then(operation);
    this.execution.observeEvaluation(evaluation);
    return evaluation.finally(() => this.sourceFileSource.persistIndex());
  }

  /**
   * Run the cache's daily trim if it is due (see
   * {@link BuildCache.maybeCollectGarbage}) — cheap when it is not, and
   * preempted outright by any new build cycle. The watch-mode trigger is the
   * facade's own (cycle-end, above); a one-shot driver calls this at the end
   * of the run — for a takeover verb, after the interactive child exits — and
   * awaits it, since only the driver can hold the process exit for it.
   */
  public maybeCollectGarbage(): Computable<void> {
    const startedAt = this.cycle.current;
    return this.execution.buildCache.maybeCollectGarbage({
      shouldAbort: () => this.cycle.current !== startedAt,
    });
  }
}

/** Build each named target under `config`'s operation (bare target names). */
function build(config: BuildContext, names: string[]): Computable<SourceRef[]>[] {
  return names.map(name => config.getTargetRef(name));
}

/** Build each named target, realising any release namespaces, and yield the
 *  results. */
export function buildOperation(config: BuildContext, names: string[]): Computable<SourceRef[][]> {
  return Computable.forAll(build(config, names), (...results: SourceRef[][]) =>
    Computable.forAll(results.map(realiseNamespaces), () => results)
  );
}

/** Build and run each named target's tests, yielding the results (the test
 *  reports ride them as artifacts). */
export function testOperation(config: BuildContext, names: string[]): Computable<SourceRef[][]> {
  return Computable.forAll(build(config, names), (...results: SourceRef[][]) => results);
}

/**
 * Mark `names`' targets to rebuild rather than serve from cache (the driver's
 * `-f` — see {@link ExecutionContext.forceTarget}). The model says which target
 * each written name references; a name with no declared target behind it
 * (`@npm:esbuild`) marks nothing — there is no build of its own to force.
 */
export function forceTargets(model: BuildModel, execution: ExecutionContext, names: string[]): void {
  for (const name of names) {
    const target = model.getReferencedTarget(name);
    if (target) {
      execution.forceTarget(target);
    }
  }
}

/**
 * Force what a target's own build promises but produces on demand: a release
 * namespace packages a member when something names one, so building the target
 * itself — which asks for its outputs, not for a reference into them — must
 * realise every member. That is the sync dry-run, and it is why laziness
 * belongs to references into a namespace rather than to the target's build.
 */
function realiseNamespaces(sources: SourceRef[]): Computable<unknown> {
  return Computable.forAll(
    sources.filter((source): source is SyncSource => source instanceof SyncSource).map(release => release.members()),
    (...realised: unknown[]) => realised
  );
}
