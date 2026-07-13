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
import { PreparedUpdate, WatchController, WatchEntry, WatchTimer } from "./WatchController";
import { expect } from "chai";

/** A manual clock: the controller only ever has one outstanding timer (it
 * clears before scheduling), so a single pending slot suffices. */
class FakeTimer implements WatchTimer {
  private pending: (() => void) | undefined;
  public schedule(fn: () => void): unknown {
    this.pending = fn;
    return fn;
  }
  public clear(handle: unknown): void {
    if (this.pending === handle) {
      this.pending = undefined;
    }
  }
  public get hasPending(): boolean {
    return this.pending !== undefined;
  }
  public fire(): void {
    const fn = this.pending;
    this.pending = undefined;
    fn?.();
  }
}

const changeEntry = (record: (event: string) => void): WatchEntry => ({
  recompute: (): Computable<PreparedUpdate | null> =>
    Computable.resolve<PreparedUpdate | null>({ invalidate: () => record("invalidate"), settle: () => record("settle") }),
});

/** An entry whose recompute stays pending until a resolver (one per call, in
 * order) is invoked — so a test can hold a flush open and interleave further
 * events, exercising the in-flight/serialization paths. */
function controllable(): {
  entry: WatchEntry & { recomputes: number };
  resolvers: Array<(update: PreparedUpdate | null) => void>;
} {
  const resolvers: Array<(update: PreparedUpdate | null) => void> = [];
  const entry = {
    recomputes: 0,
    recompute(): Computable<PreparedUpdate | null> {
      this.recomputes++;
      return Computable.from<PreparedUpdate | null>(res => resolvers.push(res));
    },
  };
  return { entry, resolvers };
}

/** A PreparedUpdate that records its settle under `tag`. */
const taggedUpdate = (settled: string[], tag: string): PreparedUpdate => ({
  invalidate: () => {},
  settle: () => settled.push(tag),
});

describe("WatchController", () => {
  let timer: FakeTimer;
  beforeEach(() => {
    timer = new FakeTimer();
  });

  it("debounces a burst of changes into a single flush", () => {
    const controller = new WatchController(50, timer);
    let recomputes = 0;
    const entry: WatchEntry = {
      recompute: () => {
        recomputes++;
        return Computable.resolve(null);
      },
    };
    controller.notifyChanged(entry);
    controller.notifyChanged(entry);
    controller.notifyChanged(entry);
    expect(recomputes).to.equal(0);
    timer.fire();
    expect(recomputes).to.equal(1);
  });

  it("applies a batch as invalidate-all then settle-all", () => {
    const controller = new WatchController(50, timer);
    const order: string[] = [];
    controller.notifyChanged(changeEntry(event => order.push(`${event}:a`)));
    controller.notifyChanged(changeEntry(event => order.push(`${event}:b`)));
    timer.fire();
    expect(order).to.deep.equal(["invalidate:a", "invalidate:b", "settle:a", "settle:b"]);
  });

  it("skips entries whose recompute reports no change", () => {
    const controller = new WatchController(50, timer);
    const applied: string[] = [];
    const unchanged: WatchEntry = { recompute: () => Computable.resolve(null) };
    controller.notifyChanged(changeEntry(event => applied.push(event)));
    controller.notifyChanged(unchanged);
    timer.fire();
    expect(applied).to.deep.equal(["invalidate", "settle"]);
  });

  it("keeps the rest of the batch when one entry's recompute fails, and retries that entry", () => {
    const errors: Error[] = [];
    const controller = new WatchController(50, timer, err => errors.push(err));
    const applied: string[] = [];
    let badRecomputes = 0;
    const bad: WatchEntry = {
      recompute: () => {
        badRecomputes++;
        return Computable.reject<PreparedUpdate | null>(new Error("io fail"));
      },
    };
    controller.notifyChanged(changeEntry(event => applied.push(event)));
    controller.notifyChanged(bad);
    timer.fire();

    /* The good entry still applied; the failure was surfaced, not swallowed. */
    expect(applied).to.deep.equal(["invalidate", "settle"]);
    expect(errors.map(err => err.message)).to.deep.equal(["io fail"]);
    expect(badRecomputes).to.equal(1);

    /* The failed entry was re-marked dirty, so a later flush retries it. */
    controller.notifyChanged(changeEntry(() => {}));
    timer.fire();
    expect(badRecomputes).to.equal(2);
  });

  it("does not start a second flush while one is still in flight", () => {
    const controller = new WatchController(50, timer);
    const a = controllable();
    controller.notifyChanged(a.entry);
    timer.fire(); // flush #1 begins; a's recompute is pending
    expect(a.entry.recomputes).to.equal(1);

    /* A fresh event fires the timer again while flush #1 is still open. */
    const b = controllable();
    controller.notifyChanged(b.entry);
    timer.fire();
    /* No concurrent flush: b is not recomputed until flush #1 finishes. */
    expect(b.entry.recomputes).to.equal(0);
    expect(a.entry.recomputes).to.equal(1);

    /* Finish flush #1 (a reports no change); the accumulated batch (b) flushes next. */
    a.resolvers[0](null);
    timer.fire();
    expect(b.entry.recomputes).to.equal(1);
  });

  it("skips settling an entry re-touched while its recompute was in flight, and retries it", () => {
    const controller = new WatchController(50, timer);
    const settled: string[] = [];
    const c = controllable();

    controller.notifyChanged(c.entry);
    timer.fire(); // flush #1; c's recompute pending
    expect(c.entry.recomputes).to.equal(1);

    /* A fresh event for c lands while its recompute is still in flight; then the
     * (now stale) recompute #1 resolves. */
    controller.notifyChanged(c.entry);
    c.resolvers[0](taggedUpdate(settled, "stale"));
    expect(settled).to.deep.equal([]); // superseded — the stale update is NOT settled

    /* c is retried; its fresh update settles. */
    timer.fire();
    expect(c.entry.recomputes).to.equal(2);
    c.resolvers[1](taggedUpdate(settled, "fresh"));
    expect(settled).to.deep.equal(["fresh"]);
  });

  it("advances the cycle (onBeforeApply) once per applied batch, and not when nothing changed", () => {
    let cycles = 0;
    const controller = new WatchController(50, timer, () => {}, () => cycles++);
    /* A batch with a real change: cycle advances once, before the settle. */
    controller.notifyChanged(changeEntry(() => {}));
    timer.fire();
    expect(cycles).to.equal(1);
    /* A batch that is all-skips (no change): cycle does not advance. */
    controller.notifyChanged({ recompute: () => Computable.resolve(null) });
    timer.fire();
    expect(cycles).to.equal(1);
  });

  it("cancels a pending flush and runs teardown on close", async () => {
    const controller = new WatchController(50, timer);
    let recomputes = 0;
    let closed = 0;
    controller.track(() => {
      closed++;
    });
    controller.notifyChanged({
      recompute: () => {
        recomputes++;
        return Computable.resolve(null);
      },
    });
    await controller.close();
    expect(closed).to.equal(1);
    timer.fire();
    expect(recomputes).to.equal(0);
  });

  it("ignores changes after close", () => {
    const controller = new WatchController(50, timer);
    controller.close();
    controller.notifyChanged({ recompute: () => Computable.resolve(null) });
    expect(timer.hasPending).to.equal(false);
  });
});
