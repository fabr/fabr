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
 */

import { Computable } from "./Computable";

/**
 * A single leaf's pending re-settlement, split into two phases so a whole batch
 * can be applied atomically: every affected leaf is {@link invalidate}d first
 * (marking the dependent subgraph stale without running anything), then every
 * leaf is {@link settle}d with its new value. Because a dependant only runs once
 * all its inputs are settled again, a node fed by several changed leaves rebuilds
 * exactly once per batch rather than once per leaf.
 */
export interface PreparedUpdate {
  /** Mark the leaf (and hence its dependants) stale, without supplying a value. */
  invalidate(): void;
  /** Push the recomputed value into the leaf, cascading the recompute. */
  settle(): void;
}

/**
 * A watched source whose backing files may change. On a change it is asked to
 * {@link recompute}: read the current state and return the update to apply, or
 * `null` when nothing actually changed (a touch / metadata-only event) so no
 * cascade happens at all.
 */
export interface WatchEntry {
  recompute(): Computable<PreparedUpdate | null>;
}

/**
 * Injectable timer so the debounce is deterministically testable (a fake clock)
 * without real `setTimeout` delays.
 */
export interface WatchTimer {
  schedule(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: WatchTimer = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coordinates watch-mode re-settlement across every watched source in a run.
 * A burst of filesystem events is collapsed behind a quiet-window timer into a
 * single batch: after `quietMs` of no further events, all dirty entries are
 * recomputed together and applied as one atomic invalidate-then-settle pass, so
 * the live Computable graph does a single minimal recompute per quiet window.
 *
 * The controller drives the graph; it does not report — the driver observes the
 * top-level Computable re-settling and renders the outcome.
 */
export class WatchController {
  private readonly dirty = new Set<WatchEntry>();
  private handle: unknown;
  private readonly closers = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly quietMs = 100,
    private readonly timer: WatchTimer = defaultTimer,
    private readonly onError: (err: Error) => void = () => {},
    /** Invoked once per applied batch, just before the graph is re-settled — the
     * driver uses it to advance the build cycle so progress re-announces. */
    private readonly onBeforeApply: () => void = () => {}
  ) {}

  /** Register a teardown callback (e.g. closing a filesystem watcher). */
  public track(close: () => void): void {
    this.closers.add(close);
  }

  /** Note that a watched entry changed, (re)starting the quiet-window timer. */
  public notifyChanged(entry: WatchEntry): void {
    if (this.closed) {
      return;
    }
    this.dirty.add(entry);
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
    }
    this.handle = this.timer.schedule(() => this.flush(), this.quietMs);
  }

  private flush(): void {
    this.handle = undefined;
    const batch = Array.from(this.dirty);
    this.dirty.clear();
    if (batch.length === 0) {
      return;
    }
    Computable.forAll(
      batch.map(entry => entry.recompute()),
      (...updates) => {
        const changed = updates.filter((update): update is PreparedUpdate => update !== null);
        if (changed.length === 0) {
          return;
        }
        this.onBeforeApply();
        /* Two phases: invalidate the whole affected frontier, THEN settle it, so
         * a node fed by several changed leaves recomputes once, not once each. */
        changed.forEach(update => update.invalidate());
        changed.forEach(update => update.settle());
      },
      err => this.onError(err)
    );
  }

  /** Stop watching: cancel the pending flush and run every teardown callback. */
  public close(): void {
    this.closed = true;
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
      this.handle = undefined;
    }
    this.closers.forEach(close => close());
    this.closers.clear();
    this.dirty.clear();
  }
}
