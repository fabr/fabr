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

import { Computable, ComputableHandle, ComputableSource, ComputableState } from "./Computable";
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
    let reject: (err: Error) => void = () => {};
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

  it("once settles on the first outcome, dropping later resolves", () => {
    const values: string[] = [];
    Computable.fromOnce<number>((resolve, reject) => {
      resolve(1);
      resolve(2);
      reject(new Error("late"));
    })
      .then(
        value => "ok:" + value,
        err => "err:" + err.message
      )
      .then(value => values.push(value));
    expect(values).to.deep.equal(["ok:1"]);
  });

  it("once keeps a rejection even when a trailing resolve arrives", () => {
    /* The spawn-failure shape: 'error' rejects, then 'close' would resolve. */
    const values: string[] = [];
    Computable.fromOnce<number>((resolve, reject) => {
      reject(new Error("ENOENT"));
      resolve(-2);
    })
      .then(
        value => "ok:" + value,
        err => "err:" + err.message
      )
      .then(value => values.push(value));
    expect(values).to.deep.equal(["err:ENOENT"]);
  });

  it("recovers when a dependency re-resolves after an error", () => {
    const values: string[] = [];
    let resolve: (value: number) => void = () => {};
    let reject: (err: Error) => void = () => {};
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

  it("rejects when a from() executor throws synchronously (like new Promise)", () => {
    const errors: Error[] = [];
    Computable.from<number>(() => {
      throw new Error("setup failed");
    }).catch(err => errors.push(err));
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.equal("setup failed");
  });

  it("coerces a non-Error thrown by a from() executor", () => {
    const errors: Error[] = [];
    Computable.from<number>(() => {
      throw "plain string";
    }).catch(err => errors.push(err));
    expect(errors).to.have.length(1);
    expect(errors[0]).to.be.an.instanceOf(Error);
    expect(errors[0].message).to.equal("plain string");
  });

  it("keeps a from() resolve that precedes a later executor throw (throw dropped)", () => {
    const values: number[] = [];
    const errors: Error[] = [];
    const c = Computable.from<number>(res => {
      res(7);
      throw new Error("too late");
    });
    c.then(v => values.push(v), err => errors.push(err));
    expect(values).to.deep.equal([7]);
    expect(errors).to.have.length(0);
    expect(c.state).to.equal(ComputableState.Valid);
  });

  it("rejects when a once() executor throws synchronously", () => {
    const errors: Error[] = [];
    Computable.fromOnce<number>(() => {
      throw new Error("once setup failed");
    }).catch(err => errors.push(err));
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.equal("once setup failed");
  });

  it("keeps a once() resolve that precedes a later executor throw", () => {
    const values: number[] = [];
    const errors: Error[] = [];
    Computable.fromOnce<number>(res => {
      res(3);
      throw new Error("too late");
    }).then(v => values.push(v), err => errors.push(err));
    expect(values).to.deep.equal([3]);
    expect(errors).to.have.length(0);
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

  it("crosses a resolveTo binding with the maybe-invalid frontier (no glitch)", () => {
    let resolve: (value: number) => void = () => {};
    const src = Computable.from<number>(res => {
      resolve = res;
    });
    resolve(1);

    /* A diamond over `src`: one arm direct, the other reaching `src` through a
     * resolveTo binding (a node whose fn *returns* an inner computable). Both
     * arms feed the same consumer. */
    const direct = src.then(v => v);
    const inner = src.then(v => v * 10);
    const bound = Computable.resolve(0).then(() => inner);
    let runs = 0;
    const values: number[] = [];
    const consumer = Computable.forAll([direct, bound], (a, b) => {
      runs++;
      return a + b;
    });
    consumer.then(v => values.push(v));
    expect(values).to.deep.equal([11]);
    expect(runs).to.equal(1);

    /* One coherent change to src updates both arms. The maybe-invalid frontier
     * must cross the resolveTo binding so the consumer waits for the bound arm
     * too — it recomputes exactly once, never transiently with the new `direct`
     * and the stale `bound` (which would surface an interim 2 + 10 = 12). */
    resolve(2);
    expect(values).to.deep.equal([11, 22]);
    expect(runs).to.equal(2);
  });

  it("crosses the binding when the inner re-settles directly (no prior invalidate)", () => {
    let resolve: (value: number) => void = () => {};
    const inner = Computable.from<number>(res => {
      resolve = res;
    });
    /* `sibling` is registered on `inner` FIRST, so a re-settle notifies it before
     * the binding; both arms feed the same consumer. */
    const sibling = inner.then(v => v + 1);
    const bound = Computable.resolve(0).then(() => inner);
    const pairs: string[] = [];
    Computable.forAll([sibling, bound], (a, b) => {
      pairs.push(`${a},${b}`);
    });
    resolve(1);
    expect(pairs).to.deep.equal(["2,1"]);

    /* A direct re-settle — no invalidate wave first, the from() re-resolve
     * pattern — reaches the binding as a hard invalidate rather than a
     * markMaybeInvalid. The binding must still unsettle its outer, or the
     * consumer runs against the fresh `sibling` and the stale `bound`
     * (surfacing an interim 6,1). */
    resolve(5);
    expect(pairs).to.deep.equal(["2,1", "6,5"]);
  });

  it("supersedes a pending binding when a from() cell re-resolves with a plain value", () => {
    /* The executor resolves first with a pending inner, then with a plain value —
     * legal for from() (it may fire more than once). The plain-value settle must
     * detach the stale binding; otherwise the inner's later settle forwards
     * through it and clobbers the current value with the superseded result. */
    let innerResolve: (value: number) => void = () => {};
    const inner = Computable.from<number>(res => {
      innerResolve = res;
    });
    let resolve: (value: number | Computable<number>) => void = () => {};
    const cell = Computable.from<number>(res => {
      resolve = res;
    });
    const seen: number[] = [];
    cell.then(v => seen.push(v));
    resolve(inner);
    resolve(42);
    expect(seen).to.deep.equal([42]);
    innerResolve(100);
    expect(seen).to.deep.equal([42]);
    expect(cell.value).to.equal(42);
  });

  it("supersedes a pending binding when a from() cell rejects", () => {
    /* Same supersede rule on the reject arm: an executor that resolves with a
     * pending inner and then rejects must not have the inner's later settle
     * overwrite the error. */
    let innerResolve: (value: number) => void = () => {};
    const inner = Computable.from<number>(res => {
      innerResolve = res;
    });
    let resolve: (value: number | Computable<number>) => void = () => {};
    let reject: (err: Error) => void = () => {};
    const cell = Computable.from<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const outcomes: string[] = [];
    cell.then(
      v => outcomes.push(`value:${v}`),
      err => outcomes.push(`error:${err.message}`)
    );
    resolve(inner);
    reject(new Error("boom"));
    expect(outcomes).to.deep.equal(["error:boom"]);
    innerResolve(100);
    expect(outcomes).to.deep.equal(["error:boom"]);
    expect(cell.state).to.equal(ComputableState.Error);
  });

  it("revalidates through a binding without recomputation when the inner is unchanged", () => {
    let resolve: (value: number) => void = () => {};
    const src = Computable.from<number>(res => {
      resolve = res;
    });
    resolve(1);
    let innerRuns = 0;
    const inner = src.then(v => {
      innerRuns++;
      return v * 10;
    });
    const bound = Computable.resolve(0).then(() => inner);
    let consumerRuns = 0;
    const seen: number[] = [];
    bound.then(v => {
      consumerRuns++;
      seen.push(v);
    });
    expect(seen).to.deep.equal([10]);

    /* Revalidate with the same value: the wave crosses the binding as revalidate,
     * settling the whole chain back without running anything. */
    src.invalidate();
    resolve(1);
    expect(innerRuns).to.equal(1);
    expect(consumerRuns).to.equal(1);

    /* An actual change recomputes as usual. */
    resolve(2);
    expect(seen).to.deep.equal([10, 20]);
    expect(consumerRuns).to.equal(2);
  });

  it("ignores a stale async result when the inputs changed while it was in flight", () => {
    /* The watch-mode hazard: a node whose fn returned a still-pending inner (an
     * action running tsc) is re-invalidated by a newer batch before that inner
     * settles. It must re-run against the new input and drop the stale inner's
     * eventual settle — never flip to Valid with the superseded value. */
    let resolveInput: (value: number) => void = () => {};
    const input = Computable.from<number>(res => {
      resolveInput = res;
    });
    resolveInput(1);

    /* Each run returns a fresh, manually-resolved inner (an async computation). */
    const inners: Array<(value: number) => void> = [];
    let runs = 0;
    const node = input.then(() => {
      runs++;
      return Computable.from<number>(res => inners.push(res));
    });
    const values: number[] = [];
    node.then(v => values.push(v));

    expect(runs).to.equal(1); // ran once, pending on inner0 — not yet settled
    expect(values).to.deep.equal([]);

    /* Input changes while inner0 is still in flight: the node re-runs (inner1). */
    resolveInput(2);
    expect(runs).to.equal(2);

    /* The stale inner0 finally resolves — it was superseded, so it's ignored. */
    inners[0](100);
    expect(values).to.deep.equal([]);

    /* The fresh inner1 resolves — that's the value that settles. */
    inners[1](200);
    expect(values).to.deep.equal([200]);
  });

  it("holds an in-flight child's settle while the parent's own input is invalidated (no stale transient)", () => {
    /* The interleaving: parent runs (child C1 in flight), parent's input is
     * invalidated while C1 runs, then C1 finishes. C1 was computed from the
     * now-stale input generation, so it must NOT settle through: the parent's
     * settled-ness is the conjunction of its own inputs and its binding, and the
     * input side is unsettled. The held value is not lost — the input's re-settle
     * re-runs the parent, whose fresh child delivers coherently. (The two-phase
     * flush pattern — invalidate followed synchronously by settle — sheds C1 via
     * the re-run instead; see "ignores a stale async result…".) */
    const input = new TestSource<number>();
    const children: Array<(value: number) => void> = [];
    let runs = 0;
    const parent = input.then(() => {
      runs++;
      return Computable.from<number>(res => children.push(res));
    });
    const values: number[] = [];
    parent.then(v => values.push(v));
    input.set(1);
    expect(runs).to.equal(1);
    expect(values).to.deep.equal([]); // C1 in flight, parent not yet settled

    input.invalidate(); // bare — marks the input stale; the parent doesn't re-run yet
    expect(runs).to.equal(1);
    children[0](100); // stale C1 finishes — held: the input side is unsettled
    expect(values).to.deep.equal([]);

    /* The input's re-settle re-runs the parent; the fresh child's value lands. */
    input.set(2);
    expect(runs).to.equal(2);
    children[1](200);
    expect(values).to.deep.equal([200]);
  });

  it("finally runs its side effect on either outcome and passes the result through", () => {
    let resolve: (value: number) => void = () => {};
    const src = Computable.from<number>(res => {
      resolve = res;
    });
    let calls = 0;
    const values: number[] = [];
    src.finally(() => calls++).then(v => values.push(v));
    resolve(5);
    expect(calls).to.equal(1);
    expect(values).to.deep.equal([5]);

    /* Persistent: a re-settlement runs the side effect again. */
    resolve(6);
    expect(calls).to.equal(2);
    expect(values).to.deep.equal([5, 6]);

    /* The error path runs the side effect and rethrows the original error. */
    const caught: string[] = [];
    Computable.reject<number>(new Error("boom"))
      .finally(() => calls++)
      .catch(err => caught.push(err.message));
    expect(calls).to.equal(3);
    expect(caught).to.deep.equal(["boom"]);
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
     * exactly once, bottom-up. B settling mid-attach must NOT re-run C early
     * (maybeRecompute's Detached guard suppresses it), so C is not run twice. */
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

  it("releases the superseded inner subgraph when a re-run binds elsewhere", () => {
    const srcA = new TestSource<number>();
    const srcB = new TestSource<number>();
    srcA.set(1);
    srcB.set(2);
    let resolve: (value: number) => void = () => {};
    const sel = Computable.from<number>(res => {
      resolve = res;
    });
    /* Fresh-per-run factory: each run builds a new inner chain over the selected source. */
    const outer = sel.then(which => (which === 0 ? srcA : srcB).then(v => v * 10));
    const seen: number[] = [];
    outer.then(v => seen.push(v));

    resolve(0);
    expect(seen).to.deep.equal([10]);
    expect(srcA.attaches).to.equal(1);
    expect(srcB.attaches).to.equal(0); // untouched until selected

    /* Re-running the outer supersedes the old binding: the srcA chain unwinds
     * (its subscription released) and the srcB chain attaches. */
    resolve(1);
    expect(seen).to.deep.equal([10, 20]);
    expect(srcA.detaches).to.equal(1);
    expect(srcB.attaches).to.equal(1);

    /* The released source no longer propagates into the outer. */
    srcA.set(7);
    expect(seen).to.deep.equal([10, 20]);
  });

  it("releases the inner through the binding when the outer itself detaches", () => {
    const src = new TestSource<number>();
    src.set(3);
    const inner = src.then(v => v * 2);
    const outer = Computable.resolve(0).then(() => inner);
    const obs = outer.then(v => v);
    expect(outer.value).to.equal(6);
    expect(src.attaches).to.equal(1);

    /* The outer's last dependant leaves: unbind must release the binding, so the
     * inner chain (and the source's subscription) unwinds with it. */
    unlink(outer, obs);
    expect(src.detaches).to.equal(1);

    /* A fresh observer re-runs the outer, which re-binds and re-acquires the
     * source, recomputing from its current value. */
    src.set(5);
    const seen: number[] = [];
    outer.then(v => seen.push(v));
    expect(src.attaches).to.equal(2);
    expect(seen).to.deep.equal([10]);
  });

  /* The enforced settle-while-attached invariant: a raw source whose async work
   * completes after its detach must have that completion *dropped* at the base —
   * a subclass needs no guard of its own. The probe deliberately has none (unlike
   * TestSource, which models buffer semantics): it calls settle/revalidate
   * unconditionally, as a naive source subclass would. */
  class UnguardedSource extends ComputableSource<number> {
    public trySettle(value: number): void {
      this.settle(ComputableState.Valid, value);
    }
    public tryRevalidate(): void {
      this.revalidate();
    }
  }

  it("drops a settle landing on a detached node, so a re-demand still reattaches", () => {
    const probe = new UnguardedSource();
    const dep = probe.then(v => v);
    unlink(probe, dep); /* last dependant leaves mid-flight */
    expect(probe.state).to.equal(ComputableState.Detached);

    probe.trySettle(42); /* the superseded async completion lands late */
    /* Not flipped to Valid: stranding it Valid-while-detached would make
     * addDependant's Detached check never fire — never reattached, permanently
     * stale (the TreeQuery watch brick). */
    expect(probe.state).to.equal(ComputableState.Detached);
    expect(probe.value).to.equal(undefined);

    /* Re-demand reattaches (pending), and a fresh attached settle delivers. */
    const seen: number[] = [];
    probe.then(v => seen.push(v));
    expect(probe.state).to.equal(ComputableState.Unresolved);
    probe.trySettle(7);
    expect(seen).to.deep.equal([7]);
  });

  it("drops a revalidate landing on a detached node (would mint a Valid from nothing)", () => {
    const probe = new UnguardedSource();
    const dep = probe.then(v => v);
    unlink(probe, dep);
    probe.tryRevalidate();
    expect(probe.state).to.equal(ComputableState.Detached);
  });

  it("never lets a consumer observe mixed generations across a resolveTo binding (diamond)", () => {
    /* Diamond: both consumer arms derive from src. armB's value changes with src
     * and recomputes first (created first → earlier in src's dependants order);
     * gate depends on src but re-settles UNCHANGED, putting outer on the
     * return-from-maybe path; outer's fn resolves to inner (a binding), and inner
     * — still recomputing at that moment — carries the old generation. Without
     * the conjunction gate, outer revalidates Valid-stale from the gate side
     * alone and the consumer runs once with (old outer, new armB). */
    let setSrc!: (v: number) => void;
    const src = Computable.from<number>(res => {
      setSrc = res;
    });
    setSrc(1);
    const armB = src.then(v => v);
    const gate = src.then(() => "constant");
    const inner = src.then(v => v * 10);
    const outer = gate.then(() => inner);

    const seen: string[] = [];
    Computable.forAll([outer, armB], (o, b) => {
      seen.push(`outer=${o} armB=${b}`);
      return 0;
    });

    setSrc(2);
    /* No mixed-generation interim ("outer=10 armB=2") — one coherent update. */
    expect(seen).to.deep.equal(["outer=10 armB=1", "outer=20 armB=2"]);
  });

  it("holds a binding's forwarded settle until the outer's own deps are settled (converse)", () => {
    /* The other direction: the INNER side lands first while the outer's own dep
     * is still unsettled. The forwarded settle must be held — the outer settling
     * would expose a new-generation value beside its stale own-dep side — and
     * then delivered when the own-dep side re-settles (unchanged → the
     * maybe-branch adopts the binding's result, including a CHANGED inner value
     * a plain revalidate would have discarded). */
    let setA!: (v: number) => void;
    const srcA = Computable.from<number>(res => {
      setA = res;
    });
    let setB!: (v: number) => void;
    const srcB = Computable.from<number>(res => {
      setB = res;
    });
    setA(1);
    setB(1);
    const gate = srcA.then(() => "constant");
    const inner = srcB.then(v => v * 10);
    const outer = gate.then(() => inner);
    const values: number[] = [];
    outer.then(v => values.push(v));
    expect(values).to.deep.equal([10]);

    srcA.invalidate(); /* the own-dep side goes stale/pending */
    setB(2); /* the inner side lands a NEW value: forwarded settle must hold */
    expect(values).to.deep.equal([10]);
    expect(outer.isSettled()).to.equal(false);

    /* Own-dep side re-settles unchanged: the outer adopts the binding's held
     * result — the new inner value, not a revalidation of the stale 10. */
    setA(1);
    expect(values).to.deep.equal([10, 20]);
  });

  it("from/fromOnce cells are in the graph from birth (pending, not Detached)", () => {
    /* Their executor is eager (runs in the factory) — they are producer-driven,
     * never demand-deferred — so they must not sit Detached while pending: the
     * settle guard would drop their own resolve. */
    expect(Computable.from<number>(() => undefined).state).to.equal(ComputableState.Unresolved);
    expect(Computable.fromOnce<number>(() => undefined).state).to.equal(ComputableState.Unresolved);
    /* And a resolve arriving with zero dependants still lands (fire-and-forget). */
    let resolve!: (v: number) => void;
    const cell = Computable.from<number>(res => {
      resolve = res;
    });
    resolve(9);
    expect(cell.state).to.equal(ComputableState.Valid);
    expect(cell.value).to.equal(9);
  });
});

/** Drain the microtask queue so the deferred terminal-error check runs. */
const drain = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

describe("ComputableHandle", () => {
  let reported: Error[];
  beforeEach(() => {
    reported = [];
    ComputableSource.onUnhandledError = err => reported.push(err);
  });
  afterEach(() => {
    ComputableSource.onUnhandledError = undefined;
  });

  it("holds a seated chain attached, and unwinds it on release", () => {
    const leaf = new TestSource<number>();
    leaf.set(1);
    const seen: number[] = [];
    const mid = leaf.then(v => v + 1);
    const handle = new ComputableHandle<void>();
    handle.seat(
      mid.then(v => {
        seen.push(v);
      })
    );
    expect(seen).to.deep.equal([2]);
    expect(leaf.detaches).to.equal(0);
    /* The handle is the ONLY hold on the chain, so withdrawing it unwinds the whole
     * thing — the mid node detaches, and with it the leaf it was holding. */
    handle.release();
    expect(mid.state).to.equal(ComputableState.Detached);
    expect(leaf.detaches).to.equal(1);
  });

  it("supersedes on reseat: the previously held chain is released", () => {
    const a = new TestSource<number>();
    const b = new TestSource<number>();
    a.set(1);
    b.set(2);
    const seen: number[] = [];
    const record = (source: TestSource<number>): Computable<void> =>
      source.then(v => {
        seen.push(v);
      });
    const handle = new ComputableHandle<void>();
    handle.seat(record(a));
    expect(a.attaches).to.equal(1);
    expect(seen).to.deep.equal([1]);
    handle.seat(record(b));
    expect(a.detaches).to.equal(1);
    expect(b.attaches).to.equal(1);
    expect(seen).to.deep.equal([1, 2]);
  });

  it("releases idempotently", () => {
    const leaf = new TestSource<number>();
    leaf.set(1);
    const handle = new ComputableHandle<number>();
    handle.seat(leaf);
    handle.release();
    handle.release();
    expect(leaf.detaches).to.equal(1);
  });

  it("does not re-run a seated effect when a re-settle changed nothing", () => {
    const leaf = new TestSource<number>();
    leaf.set(1);
    const seen: boolean[] = [];
    const mapped = leaf.then(v => v > 0);
    new ComputableHandle<void>().seat(
      mapped.then(v => {
        seen.push(v);
      })
    );
    expect(seen).to.deep.equal([true]);
    /* Nothing special to the handle: a maybe-invalid wave resolving back to the same value
     * revalidates the chain rather than re-running it, and a re-settle whose value is
     * unchanged notifies without invalidating. Both leave the effect alone. */
    leaf.invalidate();
    leaf.set(1);
    expect(seen).to.deep.equal([true]);
    leaf.invalidate();
    leaf.set(5);
    expect(seen).to.deep.equal([true]);
  });

  it("a superseded chain delivers nothing further", () => {
    const leaf = new TestSource<number>();
    const seen: number[] = [];
    const handle = new ComputableHandle<void>();
    handle.seat(
      leaf.then(v => {
        seen.push(v);
      })
    );
    handle.seat(Computable.resolve(undefined));
    /* Out of the graph, not merely unread: the orphaned chain's leaf cannot settle at all
     * now (settle is inert while detached), so a late arrival is discarded. */
    leaf.set(1);
    expect(seen).to.deep.equal([]);
    expect(leaf.detaches).to.equal(1);
  });

  it("does not mask a seated chain's unhandled error", async () => {
    /* Seating gives the chain a dependant, but a sink reads nothing — so the error is
     * still going nowhere and must still be reported. */
    new ComputableHandle<number>().seat(Computable.reject<number>(new Error("boom")).then(v => v + 1));
    await drain();
    expect(reported.map(err => err.message)).to.deep.equal(["boom"]);
  });

  it("stays quiet when the seated chain handles its own error", async () => {
    new ComputableHandle<number>().seat(Computable.reject<number>(new Error("boom")).catch(() => 0));
    await drain();
    expect(reported).to.deep.equal([]);
  });

  it("reports a throw from a seated effect without corrupting the node that settled", async () => {
    const leaf = new TestSource<number>();
    new ComputableHandle<void>().seat(
      leaf.then(() => {
        throw new Error("effect blew up");
      })
    );
    leaf.set(1);
    /* The throw became the tail's own rejection, so it never reached the leaf's settle. */
    expect(leaf.state).to.equal(ComputableState.Valid);
    expect(leaf.value).to.equal(1);
    await drain();
    expect(reported.map(err => err.message)).to.deep.equal(["effect blew up"]);
  });
});

describe("Computable.once", () => {
  let reported: Error[];
  beforeEach(() => {
    reported = [];
    ComputableSource.onUnhandledError = err => reported.push(err);
  });
  afterEach(() => {
    ComputableSource.onUnhandledError = undefined;
  });

  it("consumes an already-settled chain and unwinds it", () => {
    const leaf = new TestSource<number>();
    leaf.set(1);
    const mid = leaf.then(v => v + 1);
    const seen: number[] = [];
    mid.once(v => seen.push(v));
    expect(seen).to.deep.equal([2]);
    expect(mid.state).to.equal(ComputableState.Detached);
    expect(leaf.detaches).to.equal(1);
  });

  it("consumes a chain that settles later, and unwinds it then", () => {
    const leaf = new TestSource<number>();
    const mid = leaf.then(v => v + 1);
    const seen: number[] = [];
    mid.once(v => seen.push(v));
    expect(seen).to.deep.equal([]);
    expect(leaf.detaches).to.equal(0);
    leaf.set(1);
    expect(seen).to.deep.equal([2]);
    expect(mid.state).to.equal(ComputableState.Detached);
    expect(leaf.detaches).to.equal(1);
  });

  it("delivers exactly once even when the effect re-settles the source", () => {
    const leaf = new TestSource<number>();
    leaf.set(1);
    const seen: number[] = [];
    /* The already-settled path consumes during the tail's construction, before there is
     * an edge to withdraw — so a re-entrant settle here can still reach an attached
     * tail, and only the consumed flag stops it delivering twice. */
    leaf.once(v => {
      seen.push(v);
      leaf.set(2);
    });
    expect(seen).to.deep.equal([1]);
    leaf.set(3);
    expect(seen).to.deep.equal([1]);
  });

  it("routes an error to its handler and unwinds", async () => {
    const errors: string[] = [];
    const mid = Computable.reject<number>(new Error("boom")).then(v => v + 1);
    mid.once(
      () => errors.push("value"),
      err => errors.push(err.message)
    );
    expect(errors).to.deep.equal(["boom"]);
    expect(mid.state).to.equal(ComputableState.Detached);
    await drain();
    expect(reported).to.deep.equal([]); /* handled, so never reported as stranded */
  });

  it("surfaces an error with no handler, exactly once", async () => {
    const mid = Computable.reject<number>(new Error("boom")).then(v => v + 1);
    mid.once(() => undefined);
    await drain();
    expect(reported.map(err => err.message)).to.deep.equal(["boom"]);
  });
});

describe("Computable unhandled-error surface", () => {
  const flush = drain;

  let reported: Error[];
  beforeEach(() => {
    reported = [];
    ComputableSource.onUnhandledError = err => reported.push(err);
  });
  afterEach(() => {
    ComputableSource.onUnhandledError = undefined;
  });

  it("reports an eager fire-and-forget tail whose upstream fails", async () => {
    const boom = new Error("boom");
    Computable.reject<number>(boom).then(v => v + 1); /* one-arg tail, no catch, no dependant */
    await flush();
    expect(reported).to.deep.equal([boom]);
  });

  it("does not report a tail whose handler attaches synchronously afterwards", async () => {
    const c = Computable.reject<number>(new Error("boom")).then(v => v + 1);
    c.catch(() => 0); /* handler on the next line — within the deferral window */
    await flush();
    expect(reported).to.deep.equal([]);
  });

  it("does not report when the error is absorbed by a two-arg then", async () => {
    Computable.reject<number>(new Error("boom")).then(
      v => v,
      () => 0
    );
    await flush();
    expect(reported).to.deep.equal([]);
  });

  it("does not report an explicit reject() constant — a deliberate value, not lost work", async () => {
    Computable.reject<number>(new Error("boom")); /* never consumed, but never computed either */
    await flush();
    expect(reported).to.deep.equal([]);
  });

  it("does not report a binding node's forwarded error (its outer observes it)", async () => {
    /* `fn` returns a rejected source: the outer flatMaps through a binding, which
     * settles Error but forwards to its outer — only the outer (a real terminal
     * tail) should count, and here it too is caught, so nothing is reported. */
    const outer = Computable.resolve(1).then(() => Computable.reject<number>(new Error("boom")));
    outer.catch(() => 0);
    await flush();
    expect(reported).to.deep.equal([]);
  });

  it("reports each stranded tail exactly once (no duplicates across a shared upstream)", async () => {
    const boom = new Error("boom");
    const src = Computable.reject<number>(boom);
    src.then(v => v + 1); /* two independent fire-and-forget tails over one failed source */
    src.then(v => v + 2);
    await flush();
    expect(reported).to.deep.equal([boom, boom]); /* one per tail, none doubled */
  });
});
