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

/** The result of recomputing one entry in a batch: its update (possibly `null`
 * for a no-op), or the error that entry raised — captured per entry so a single
 * failure doesn't reject the whole batch's {@link Computable.forAll}. */
type EntryOutcome = { entry: WatchEntry; update: PreparedUpdate | null } | { entry: WatchEntry; error: Error };

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
  /** True while a batch is being recomputed/applied. Only one flush runs at a
   * time: a timer firing during it is a no-op, and the flush re-arms on completion
   * if more work accrued — so batches can't overlap and settle out of order. */
  private flushing = false;
  private readonly closers = new Set<() => void | Promise<void>>();
  private closed = false;

  constructor(
    private readonly quietMs = 100,
    private readonly timer: WatchTimer = defaultTimer,
    private readonly onError: (err: Error) => void = () => {},
    /** Invoked once per applied batch, just before the graph is re-settled — the
     * driver uses it to advance the build cycle so progress re-announces. */
    private readonly onBeforeApply: () => void = () => {},
    /** Surface a non-fatal watcher notice (e.g. a backend fallback) for the
     * driver to render; core never logs directly. */
    private readonly onWarning: (message: string) => void = () => {}
  ) {}

  /** Surface a non-fatal watcher notice (e.g. the FS backend falling back to an
   * alternate) through the driver's diagnostics. */
  public reportWarning(message: string): void {
    this.onWarning(message);
  }

  /** Register a teardown callback (e.g. closing a filesystem watcher). May be
   * async: {@link close} awaits it, so the process can exit only once the native
   * watcher thread has stopped (an abrupt exit mid-flight crashes the kqueue
   * backend — see {@link close}). */
  public track(close: () => void | Promise<void>): void {
    this.closers.add(close);
  }

  /** Surface a watcher-backend error (e.g. the filesystem subscription failing)
   * through the same channel as a recompute error. */
  public reportError(err: Error): void {
    this.onError(err);
  }

  /**
   * Note that a watched entry changed, (re)starting the quiet-window timer.
   *
   * With `defer`, the entry is recorded as dirty but the timer is NOT armed:
   * the change will be applied by whatever flush happens next, and causes none
   * of its own. This is for a change fabr itself made and already knows the
   * outcome of — a written-back test expectation — where rebuilding *because of
   * it* would only reproduce the bytes just written.
   */
  public notifyChanged(entry: WatchEntry, options?: { defer?: boolean }): void {
    if (this.closed) {
      return;
    }
    this.dirty.add(entry);
    if (!options?.defer) {
      this.scheduleFlush();
    }
  }

  /** Arm the quiet window for changes already recorded — how a deferred entry
   * (see {@link notifyChanged}) becomes a rebuild when it turns out not to have
   * been ours after all. No-op with nothing dirty: a flush of an empty batch
   * would advance the build cycle and re-announce for no work. */
  public armFlush(): void {
    if (!this.closed && this.dirty.size > 0) {
      this.scheduleFlush();
    }
  }

  /** (Re)arm the quiet-window timer for a flush. */
  private scheduleFlush(): void {
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
    }
    this.handle = this.timer.schedule(() => this.flush(), this.quietMs);
  }

  private flush(): void {
    this.handle = undefined;
    /* Only one batch in flight: a timer firing mid-flush is a no-op — the running
     * flush re-arms on completion if more accrued. This serializes batches so a
     * slow batch can't settle after a newer one and stick (and lets us drop an
     * entry re-touched mid-flight, below). */
    if (this.flushing) {
      return;
    }
    const batch = Array.from(this.dirty);
    this.dirty.clear();
    if (batch.length === 0) {
      return;
    }
    this.flushing = true;
    /* Recompute every entry independently so one entry's failure can't sink the
     * rest of the batch: each yields either its update or its error. The good
     * updates are applied atomically; a failed entry is surfaced via onError and
     * re-marked dirty (retried on a later flush), settling nothing — its leaf
     * keeps its last-good value, consistent because the memo only advances in a
     * settle that never ran. */
    /* Consumed with `once`, not read as a value: the batch is a unit of work with a
     * definite end, and its chain must not outlive it. Two reasons, and the second is
     * the load-bearing one. (a) A gathering node has no dependants, so nothing would
     * ever detach it — every flush would strand its whole recompute chain, registered
     * against each query's file cells for the rest of the session. (b) A second
     * delivery would be *wrong*, not merely wasteful: it would clear `flushing` out
     * from under a newer batch and re-apply this batch's captured updates, settling
     * file sets that have since been superseded. `once` withdraws demand before the
     * effect runs, so neither can happen. */
    Computable.forAll(
      batch.map(entry =>
        entry.recompute().then<EntryOutcome>(
          update => ({ entry, update }),
          (error: Error) => ({ entry, error })
        )
      ),
      (...outcomes) => outcomes
    ).once(
      outcomes => {
        this.flushing = false;
        if (this.closed) {
          return;
        }
        const changed: PreparedUpdate[] = [];
        for (const outcome of outcomes) {
          /* Re-touched while this flush ran → its result is already stale; skip it
           * (never settle it), leaving it dirty for the next flush to recompute
           * from fresh state — so the superseded value never enters the graph. */
          if (this.dirty.has(outcome.entry)) {
            continue;
          }
          if ("error" in outcome) {
            this.dirty.add(outcome.entry);
            this.onError(outcome.error);
          } else if (outcome.update) {
            changed.push(outcome.update);
          }
        }
        if (changed.length > 0) {
          this.onBeforeApply();
          /* Two phases: invalidate the whole affected frontier, THEN settle it, so
           * a node fed by several changed leaves recomputes once, not once each. */
          changed.forEach(update => update.invalidate());
          changed.forEach(update => update.settle());
        }
        /* Anything still dirty — superseded (skipped above) or re-marked on error —
         * gets its own flush once the quiet window elapses again. */
        if (this.dirty.size > 0) {
          this.scheduleFlush();
        }
      },
      err => {
        this.flushing = false;
        this.onError(err);
      }
    );
  }

  /** Stop watching: cancel the pending flush and run every teardown callback,
   * resolving once they all settle. The teardowns are awaited (not fire-and-
   * forget) because a filesystem watcher's `unsubscribe` stops a native thread,
   * and exiting the process before that thread has stopped crashes the kqueue
   * backend (`mutex lock failed` → SIGABRT). A teardown that rejects doesn't
   * block the others — shutdown proceeds regardless. */
  public close(): Promise<void> {
    this.closed = true;
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
      this.handle = undefined;
    }
    const closers = Array.from(this.closers);
    this.closers.clear();
    this.dirty.clear();
    return Promise.allSettled(closers.map(close => Promise.resolve().then(close))).then(() => undefined);
  }
}
