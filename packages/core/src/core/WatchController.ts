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
 * One watched source's prepared change, applied in two phases across a batch:
 * every source in the batch is {@link invalidate}d first, then every one is
 * {@link settle}d with its new value, so a node fed by several changed
 * sources computes once per batch.
 */
export interface PreparedUpdate {
  /** Mark the source Invalid, and its dependants maybe-invalid, without a value. */
  invalidate(): void;
  /** Settle the source with its new value, which its dependants then compute from. */
  settle(): void;
}

/** A watched source whose files may change. */
export interface WatchEntry {
  /** Read the current state, and return the update to apply, or `null` where
   * nothing changed (a touch). */
  recompute(): Computable<PreparedUpdate | null>;
}

/** The result of recomputing one entry of a batch: its update (`null` where
 * nothing changed), or the error it failed with. */
type EntryOutcome = { entry: WatchEntry; update: PreparedUpdate | null } | { entry: WatchEntry; error: Error };

/** The timer behind the quiet window; a test passes a fake clock. */
export interface WatchTimer {
  schedule(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: WatchTimer = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Apply watched changes to the graph in batches, for every watched source of
 * a run. An entry reported changed ({@link notifyChanged}) is dirty; once
 * `quietMs` pass with no further change, every dirty entry is recomputed and
 * the updates applied together, each invalidated and then each settled, so
 * the graph computes once per batch. One batch runs at a time:
 * - An entry that changes again while its batch is recomputed is skipped,
 *   and recomputed in the next batch.
 * - An entry whose recompute fails is reported through `onError` and stays
 *   dirty, keeping its last value; the rest of the batch is applied.
 * - What is still dirty after a batch starts the quiet window again.
 *
 * The controller reports nothing of the build: the driver observes the graph
 * settling.
 */
export class WatchController {
  /** The entries changed since the last batch began. */
  private readonly dirty = new Set<WatchEntry>();
  /** The quiet-window timer, while one is set. */
  private handle: unknown;
  /** True while a batch is being recomputed and applied. A timer firing
   * meanwhile does nothing; the batch starts the quiet window again when it
   * ends, where entries are dirty. */
  private flushing = false;
  /** The teardowns {@link close} runs. */
  private readonly closers = new Set<() => void | Promise<void>>();
  private closed = false;

  constructor(
    private readonly quietMs: number,
    private readonly timer: WatchTimer = defaultTimer,
    private readonly onError: (err: Error) => void = () => {},
    /** Called once per batch with updates to apply, just before they are
     * applied: the facade advances the build cycle here. */
    private readonly onBeforeApply: () => void = () => {},
    /** Called with a non-fatal watcher notice (a backend fallback), for the
     * driver to show. */
    private readonly onWarning: (message: string) => void = () => {}
  ) {}

  /** Report a non-fatal watcher notice (a filesystem backend falling back
   * to another) through `onWarning`. */
  public reportWarning(message: string): void {
    this.onWarning(message);
  }

  /** Register a teardown for {@link close} to run (closing a filesystem
   * subscription). It may return a promise, which close waits for. */
  public track(close: () => void | Promise<void>): void {
    this.closers.add(close);
  }

  /** Report a watcher error (a filesystem subscription failing) through
   * `onError`, as a failed recompute is. */
  public reportError(err: Error): void {
    this.onError(err);
  }

  /**
   * Mark `entry` dirty and start the quiet window again. With `defer`, only
   * mark it dirty: the change is applied by the next batch something else
   * starts. Pass `defer` for a change fabr itself made (a written-back test
   * expectation). Does nothing once closed.
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

  /** Start the quiet window for the entries already dirty, as for a change
   * deferred ({@link notifyChanged}) that turns out not to be fabr's own. Does
   * nothing where none is dirty, or once closed. */
  public armFlush(): void {
    if (!this.closed && this.dirty.size > 0) {
      this.scheduleFlush();
    }
  }

  /** Start the quiet window again, replacing the timer set. */
  private scheduleFlush(): void {
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
    }
    this.handle = this.timer.schedule(() => this.flush(), this.quietMs);
  }

  /** Recompute and apply the dirty entries as one batch (see the class
   * doc). */
  private flush(): void {
    this.handle = undefined;
    if (this.flushing) {
      return;
    }
    const batch = Array.from(this.dirty);
    this.dirty.clear();
    if (batch.length === 0) {
      return;
    }
    this.flushing = true;
    /* Each entry's recompute yields its update or its error, so one failure
     * does not reject the batch. Consume the batch with `once`: its chain
     * must detach when the batch ends, and a second call would clear
     * `flushing` under a newer batch and apply superseded updates. */
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
          /* Changed again while this batch ran: skip its stale update, and
           * leave it dirty for the next batch. */
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
          /* Invalidate every update before settling any, so a node fed by
           * several changed sources computes once. */
          changed.forEach(update => update.invalidate());
          changed.forEach(update => update.settle());
        }
        /* Entries skipped or failed above are still dirty. */
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

  /** Stop watching: cancel the quiet window, forget the dirty entries, and
   * run every teardown, resolving once all have settled, whether or not they
   * failed. Wait for it before the process exits: exiting while a native
   * watcher thread is still running crashes the kqueue backend (SIGABRT). */
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
