/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { Computable, ComputableSource, ComputableState } from "./Computable";
import { MultiError } from "./Errors";
import { expect } from "chai";

/** A pull-based external source with observable attach/detach counters, for exercising
 * the demand-driven attachment lifecycle. Models a real reactive leaf (e.g. a filesystem
 * watch): `set`/`invalidate` update a backing store at any time, but it only *settles*
 * while attached — a change arriving while detached is recorded and re-read on the next
 * attach, so it is never settled while detached. */
class TestSource<T> extends ComputableSource<T> {
  public attaches = 0;
  public detaches = 0;
  private current: T | undefined;
  private pending = true;

  /** Push a new backing value ("the world changed"); propagates only if attached. */
  public set(value: T): void {
    this.current = value;
    this.pending = false;
    if (this.state !== ComputableState.Detached) {
      this.settle(ComputableState.Valid, value);
    }
  }

  /** Mark the backing value stale/pending; propagates only if attached. */
  public override invalidate(): void {
    this.pending = true;
    if (this.state !== ComputableState.Detached) {
      super.invalidate();
    }
  }

  protected override attach(): void {
    super.attach();
    this.attaches++;
    /* Re-read the current backing value on (re)attach; stay pending if there is none. */
    if (!this.pending) {
      this.settle(ComputableState.Valid, this.current as T);
    }
  }

  protected override detach(): void {
    super.detach();
    this.detaches++;
  }
}

/* `removeDependant` is protected structural plumbing; reach it here to drive the
 * attach/detach lifecycle directly — production tears edges down via the cascade,
 * never an outside call. */
function unlink<P, D>(source: ComputableSource<P>, dependant: ComputableSource<D>): void {
  (source as unknown as { removeDependant(d: ComputableSource<D>): void }).removeDependant(dependant);
}

describe("Computable", () => {
  it("Simple", () => {
    const values: number[] = [];
    let resolve: (value: number) => void = () => {};
    const c = Computable.from<number>(res => {
      resolve = res;
    });
    resolve(3);
    const c2 = c.then(value => value + 4);
    c2.then(value => values.push(value));
    expect(values).to.deep.equal([7]);
    /* Changed value propagates */
    resolve(10);
    expect(values).to.deep.equal([7, 14]);

    /* Same value doesn't cause child updates */
    resolve(10);
    expect(values).to.deep.equal([7, 14]);
  });

  it("Subgraph invalidation", () => {
    const values: number[] = [];
    let resolve: (value: number) => void = () => {};
    const c = Computable.from<number>(res => {
      resolve = res;
    });
    const left = c.then(value => value + 4);
    const right = c.then(value => Math.trunc(value / 2));
    const child = Computable.forAll([left, right], (l, r) => {
      return l + r;
    });
    child.then(result => values.push(result));
    resolve(3);
    expect(values).to.deep.equal([8]);
    resolve(4);
    expect(values).to.deep.equal([8, 10]);
  });

  it("propagates errors to dependent computables", () => {
    const errors: string[] = [];
    const c = Computable.reject<number>(new Error("boom"));
    c.then(value => value + 1).catch(err => errors.push(err.message));
    expect(errors).to.deep.equal(["boom"]);
  });

  it("catch passes valid values through", () => {
    const values: number[] = [];
    Computable.resolve(5)
      .catch(() => -1)
      .then(value => values.push(value));
    expect(values).to.deep.equal([5]);
  });

  it("handles errors with two-arg then", () => {
    const values: string[] = [];
    let reject: (err: unknown) => void = () => {};
    const c = Computable.from<number>((_resolve, rej) => {
      reject = rej;
    });
    c.then(
      value => "ok:" + value,
      err => "err:" + err.message
    ).then(value => values.push(value));
    reject(new Error("bad"));
    expect(values).to.deep.equal(["err:bad"]);
  });

  it("recovers when a dependency re-resolves after an error", () => {
    const values: string[] = [];
    let resolve: (value: number) => void = () => {};
    let reject: (err: unknown) => void = () => {};
    const c = Computable.from<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    c.then(
      value => "ok:" + value,
      err => "err:" + err.message
    ).then(value => values.push(value));
    reject(new Error("bad"));
    resolve(7);
    expect(values).to.deep.equal(["err:bad", "ok:7"]);
  });

  it("aggregates multiple distinct errors into a MultiError", () => {
    const errors: Error[] = [];
    const a = Computable.reject<number>(new Error("a"));
    const b = Computable.reject<number>(new Error("b"));
    Computable.forAll([a, b], (x, y) => x + y).catch(err => errors.push(err));
    expect(errors).to.have.length(1);
    expect(errors[0]).to.be.an.instanceOf(MultiError);
    expect((errors[0] as MultiError).errors.map(err => err.message)).to.deep.equal(["a", "b"]);
  });

  it("dedupes the same error arriving via multiple paths", () => {
    const errors: Error[] = [];
    const root = Computable.reject<number>(new Error("root"));
    const left = root.then(value => value + 1);
    const right = root.then(value => value * 2);
    Computable.forAll([left, right], (l, r) => l + r).catch(err => errors.push(err));
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.equal("root");
    expect(errors[0]).to.not.be.an.instanceOf(MultiError);
  });

  it("coerces thrown non-Error values to Error", () => {
    const errors: Error[] = [];
    Computable.resolve(1)
      .then(() => {
        throw "plain string";
      })
      .catch(err => errors.push(err));
    expect(errors).to.have.length(1);
    expect(errors[0]).to.be.an.instanceOf(Error);
    expect(errors[0].message).to.equal("plain string");
  });

  it("restores a valid node without recomputation when inputs revalidate unchanged", () => {
    let resolve: (value: number) => void = () => {};
    const src = Computable.from<number>(res => {
      resolve = res;
    });
    resolve(1);
    let runs = 0;
    const doubled = src.then(value => {
      runs++;
      return value * 2;
    });
    const values: number[] = [];
    doubled.then(value => values.push(value));
    expect(values).to.deep.equal([2]);
    expect(runs).to.equal(1);

    /* Revalidate with the same value: nothing recomputes */
    src.invalidate();
    resolve(1);
    expect(runs).to.equal(1);
    expect(values).to.deep.equal([2]);

    /* An actual change recomputes as usual */
    resolve(3);
    expect(runs).to.equal(2);
    expect(values).to.deep.equal([2, 6]);
  });

  it("recomputes a shared dependant once when several inputs re-settle as a batch", () => {
    let resolveA: (value: number) => void = () => {};
    let resolveB: (value: number) => void = () => {};
    const a = Computable.from<number>(res => {
      resolveA = res;
    });
    const b = Computable.from<number>(res => {
      resolveB = res;
    });
    resolveA(1);
    resolveB(1);
    let runs = 0;
    const sum = Computable.forAll([a, b], (x, y) => {
      runs++;
      return x + y;
    });
    const values: number[] = [];
    sum.then(value => values.push(value));
    expect(runs).to.equal(1);
    expect(values).to.deep.equal([2]);

    /* The WatchController batch pattern: invalidate the whole frontier first,
     * then settle it. The shared dependant must not run until *both* inputs are
     * settled again, so it recomputes exactly once — not once per input. */
    a.invalidate();
    b.invalidate();
    resolveA(10);
    resolveB(20);
    expect(runs).to.equal(2);
    expect(values).to.deep.equal([2, 30]);
  });

  it("restores an errored node without recomputation when inputs revalidate unchanged", () => {
    let resolve: (value: number) => void = () => {};
    const src = Computable.from<number>(res => {
      resolve = res;
    });
    resolve(1);
    let runs = 0;
    const failing = src.then(value => {
      runs++;
      throw new Error("fail:" + value);
    });
    const caught: string[] = [];
    failing.catch(err => caught.push(err.message));
    expect(caught).to.deep.equal(["fail:1"]);
    expect(runs).to.equal(1);

    /* Revalidate with the same value: nothing recomputes, the error state is retained */
    src.invalidate();
    resolve(1);
    expect(runs).to.equal(1);
    expect(caught).to.deep.equal(["fail:1"]);

    /* An actual change recomputes as usual */
    resolve(2);
    expect(runs).to.equal(2);
    expect(caught).to.deep.equal(["fail:1", "fail:2"]);
  });
});

describe("Computable attach/detach", () => {
  it("attaches a source on its first dependant and detaches on its last", () => {
    const src = new TestSource<number>();
    src.set(1);
    const a = src.then(value => value);
    expect(src.attaches).to.equal(1);
    expect(src.detaches).to.equal(0);

    /* A second dependant does not re-attach (already attached). */
    const b = src.then(value => value);
    expect(src.attaches).to.equal(1);

    /* Detaching one leaves it attached (b still depends on it). */
    unlink(src, a);
    expect(src.detaches).to.equal(0);

    /* Detaching the last one detaches the source. */
    unlink(src, b);
    expect(src.detaches).to.equal(1);

    /* A new dependant reattaches it. */
    src.then(value => value);
    expect(src.attaches).to.equal(2);
    expect(src.detaches).to.equal(1);
  });

  it("does not double-run a derived node on the birth 0->1 (creation already attached)", () => {
    const src = new TestSource<number>();
    src.set(2);
    let runs = 0;
    const doubled = src.then(value => {
      runs++;
      return value * 2;
    });
    /* Ran once on creation; adding the first observer must not re-attach/re-run it. */
    const values: number[] = [];
    doubled.then(value => values.push(value));
    expect(runs).to.equal(1);
    expect(values).to.deep.equal([4]);
  });

  it("recomputes from the dependency's CURRENT value after a detach/reattach", () => {
    const src = new TestSource<number>();
    src.set(1);
    let runs = 0;
    const tens = src.then(value => {
      runs++;
      return value * 10;
    });
    const seen1: number[] = [];
    const sub1 = tens.then(value => seen1.push(value));
    expect(runs).to.equal(1);
    expect(seen1).to.deep.equal([10]);

    /* Detach `tens` (its only dependant leaves) → it detaches from `src`. */
    unlink(tens, sub1);
    expect(src.detaches).to.equal(1);

    /* `src` changes while `tens` is detached — `tens` must NOT recompute. */
    src.set(5);
    expect(runs).to.equal(1);

    /* Reattach with a fresh observer: `tens` reattaches, recomputes from src=5,
     * and delivers the current value — eventually-consistent with staying attached. */
    const seen2: number[] = [];
    tens.then(value => seen2.push(value));
    expect(src.attaches).to.equal(2);
    expect(runs).to.equal(2);
    expect(seen2).to.deep.equal([50]);
  });

  it("keeps a shared dependency attached until all dependants detach, then reattaches", () => {
    const src = new TestSource<number>();
    src.set(1);
    const left = src.then(value => value + 1);
    const right = src.then(value => value + 2);
    expect(src.attaches).to.equal(1);

    /* Wire both into a consumer, then peel them off one at a time. */
    const leftObs = left.then(value => value);
    const rightObs = right.then(value => value);
    unlink(left, leftObs);
    /* `left` detached from src, but `right` keeps src attached. */
    expect(src.detaches).to.equal(0);
    unlink(right, rightObs);
    expect(src.detaches).to.equal(1);
  });

  it("re-propagates a dependency VALUE that changed while detached, on reattach", () => {
    const src = new TestSource<number>();
    src.set(1);
    let bRuns = 0;
    let cRuns = 0;
    const b = src.then(x => {
      bRuns++;
      return x * 2;
    });
    const c = b.then(x => {
      cRuns++;
      return x + 1;
    });
    const seen1: number[] = [];
    const obs = c.then(v => seen1.push(v));
    expect(seen1).to.deep.equal([3]); // src=1, b=2, c=3

    /* Disconnect the whole chain. */
    unlink(c, obs);
    expect(src.detaches).to.equal(1);

    /* src's VALUE changes while b/c are detached — they don't hear it. */
    src.set(5);
    expect(b.value).to.equal(2); // still stale (detached, unnotified)
    expect(c.value).to.equal(3);

    /* Reconnect: reattach must recompute from src's CURRENT value (5), not deliver
     * the stale 2/3. */
    const seen2: number[] = [];
    c.then(v => seen2.push(v));
    expect(b.value).to.equal(10); // 5 * 2
    expect(c.value).to.equal(11); // 10 + 1
    expect(seen2).to.deep.equal([11]);
  });

  it("reattaches bottom-up and runs each node exactly once down the chain", () => {
    const src = new TestSource<number>();
    src.set(1);
    let bRuns = 0;
    let cRuns = 0;
    const order: string[] = [];
    const b = src.then(x => {
      bRuns++;
      order.push("b");
      return x * 2;
    });
    const c = b.then(x => {
      cRuns++;
      order.push("c");
      return x + 1;
    });
    const obs = c.then(() => undefined);
    expect(bRuns).to.equal(1);
    expect(cRuns).to.equal(1);
    order.length = 0;

    /* Detach the whole chain, change src's value, then reconnect at C. */
    unlink(c, obs);
    src.set(5);
    c.then(() => undefined);

    /* Reattaching C registers C->B then B->A, reruns B, then reruns C — each node
     * exactly once, bottom-up. B settling mid-attach must NOT re-run C early (the
     * `attaching` guard suppresses it), so C is not run twice. */
    expect(bRuns).to.equal(2);
    expect(cRuns).to.equal(2);
    expect(order).to.deep.equal(["b", "c"]);
    expect(b.value).to.equal(10);
    expect(c.value).to.equal(11);
  });

  it("comes back pending (not stale-Valid) when a dependency is unsettled at reattach", () => {
    const src = new TestSource<number>();
    src.set(1);
    const b = src.then(x => x * 2);
    const c = b.then(x => x + 1);
    const obs = c.then(() => undefined);
    expect(b.state).to.equal(ComputableState.Valid);
    expect(c.state).to.equal(ComputableState.Valid);

    /* Detach the chain, then bare-invalidate src (pending; value unchanged). */
    unlink(c, obs);
    src.invalidate();

    /* Reconnect: b and c must reflect src's pending state — reattach re-derives
     * *freshness*, not just value — rather than advertise a stale Valid. */
    const seen: number[] = [];
    c.then(v => seen.push(v));
    expect(b.isSettled()).to.equal(false);
    expect(c.isSettled()).to.equal(false);
    expect(seen).to.deep.equal([]); // nothing delivered while an ancestor is pending

    /* When src settles, the chain recomputes and delivers. */
    src.set(5);
    expect(b.value).to.equal(10);
    expect(c.value).to.equal(11);
    expect(seen).to.deep.equal([11]);
  });

  it("survives a dependant detaching a sibling mid-notify (re-entrant cascade)", () => {
    const src = new TestSource<number>();
    src.set(0);
    /* `mutator` is registered on src FIRST, so it is notified before `victim`. When
     * it fires it detaches victim's observer → victim detaches from src, mutating
     * src's dependant list mid-notification. The snapshot-copy iteration must not
     * throw or skip the surviving dependant. */
    const seenMutator: number[] = [];
    const refs: { victim?: Computable<number>; victimObs?: Computable<number> } = {};
    const mutator = src.then(value => {
      if (value === 1 && refs.victim && refs.victimObs) {
        unlink(refs.victim, refs.victimObs);
      }
      return value;
    });
    mutator.then(value => seenMutator.push(value));

    const seenVictim: number[] = [];
    refs.victim = src.then(value => value);
    refs.victimObs = refs.victim.then(value => seenVictim.push(value));

    expect(() => src.set(1)).to.not.throw();
    expect(seenMutator).to.deep.equal([0, 1]); // surviving dependant keeps updating
    /* victim was detached before it recomputed, so it never delivered 1. */
    expect(seenVictim).to.deep.equal([0]);
    /* src stays attached — mutator still depends on it. */
    expect(src.detaches).to.equal(0);
  });
});
