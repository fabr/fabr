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
