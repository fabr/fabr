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

import { Computable, ComputableSource, ComputableState } from "./Computable";
import { computableWorkList, WorkListItem } from "./WorkList";
import { expect } from "chai";

type Item = WorkListItem<string, string>;

/** A controllable step universe: each key's step is a re-resolvable node, so a
 * later `set`/`fail` for the same key models a watch-mode re-settlement. */
class TestGraph {
  public readonly calls: string[] = [];
  private readonly resolvers = new Map<string, (item: Item) => void>();
  private readonly rejectors = new Map<string, (err: unknown) => void>();

  public readonly step = (key: string): Computable<Item> => {
    this.calls.push(key);
    return Computable.from<Item>((resolve, reject) => {
      this.resolvers.set(key, resolve);
      this.rejectors.set(key, reject);
    });
  };

  public set(key: string, next: string[], value: string): void {
    const resolve = this.resolvers.get(key);
    if (!resolve) {
      throw new Error(`step for '${key}' was never demanded`);
    }
    resolve({ value, next });
  }

  public fail(key: string, message: string): void {
    const reject = this.rejectors.get(key);
    if (!reject) {
      throw new Error(`step for '${key}' was never demanded`);
    }
    reject(new Error(message));
  }
}

/** A raw external step source (per the FS-watch-leaf pattern): only settles while
 * attached, re-reads its backing value on reattach, and counts the lifecycle. */
class StepSource extends ComputableSource<Item> {
  public attaches = 0;
  public detaches = 0;
  private current: Item | undefined;

  public set(item: Item): void {
    this.current = item;
    if (this.state !== ComputableState.Detached) {
      this.settle(ComputableState.Valid, item);
    }
  }

  protected override attach(): void {
    super.attach();
    this.attaches++;
    if (this.current !== undefined) {
      this.settle(ComputableState.Valid, this.current);
    }
  }

  protected override detach(): void {
    super.detach();
    this.detaches++;
  }
}

function observe(result: Computable<Map<string, string>>): Map<string, string>[] {
  const snapshots: Map<string, string>[] = [];
  result.then(map => snapshots.push(map));
  return snapshots;
}

describe("computableWorkList", () => {
  it("computes the closure of a DAG in discovery order, visiting shared keys once", () => {
    const g = new TestGraph();
    const result = computableWorkList(["a"], g.step);
    const snapshots = observe(result);

    expect(result.isSettled()).to.equal(false);
    g.set("a", ["b", "c"], "A");
    g.set("b", ["d"], "B");
    expect(result.isSettled()).to.equal(false); // frontier (c, then d) still pending
    g.set("c", ["d"], "C");
    g.set("d", [], "D");

    expect(snapshots).to.have.length(1);
    expect([...snapshots[0]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
      ["d", "D"],
    ]);
    expect(g.calls).to.deep.equal(["a", "b", "c", "d"]);
  });

  it("terminates on cycles and self-references", () => {
    const g = new TestGraph();
    const snapshots = observe(computableWorkList(["a"], g.step));
    g.set("a", ["b"], "A");
    g.set("b", ["a", "b"], "B");

    expect(snapshots).to.have.length(1);
    expect([...snapshots[0]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
    ]);
    expect(g.calls).to.deep.equal(["a", "b"]);
  });

  it("handles empty and duplicate seeds", () => {
    const empty = computableWorkList<string, string>([], key => Computable.reject(new Error(`unexpected ${key}`)));
    expect(empty.isSettled()).to.equal(true);
    expect(empty.value).to.deep.equal(new Map());

    const g = new TestGraph();
    const snapshots = observe(computableWorkList(["a", "a"], g.step));
    g.set("a", ["a"], "A");
    expect(g.calls).to.deep.equal(["a"]);
    expect([...snapshots[0]]).to.deep.equal([["a", "A"]]);
  });

  it("rejects on a step failure and recovers when it re-resolves", () => {
    const g = new TestGraph();
    const result = computableWorkList(["a"], g.step);
    const errors: string[] = [];
    const snapshots: Map<string, string>[] = [];
    result.then(
      map => snapshots.push(map),
      err => errors.push(err.message)
    );

    g.set("a", ["b"], "A");
    g.fail("b", "boom");
    expect(errors).to.deep.equal(["boom"]);
    expect(snapshots).to.have.length(0);

    g.set("b", [], "B");
    expect(snapshots).to.have.length(1);
    expect([...snapshots[0]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
    ]);
  });

  it("rejects when the step function itself throws", () => {
    const errors: string[] = [];
    const g = new TestGraph();
    const result = computableWorkList(["a"], key => {
      if (key === "b") {
        throw new Error("no step for b");
      }
      return g.step(key);
    });
    result.catch(err => errors.push(err.message));
    g.set("a", ["b"], "A");
    expect(errors).to.deep.equal(["no step for b"]);
  });

  it("recomputes the map when a step's value re-resolves, without re-stepping", () => {
    const g = new TestGraph();
    const snapshots = observe(computableWorkList(["a"], g.step));
    g.set("a", ["b"], "A1");
    g.set("b", [], "B1");
    expect(snapshots).to.have.length(1);

    g.set("a", ["b"], "A2");
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([
      ["a", "A2"],
      ["b", "B1"],
    ]);
    expect(g.calls).to.deep.equal(["a", "b"]);
  });

  it("discovers new keys when a re-resolved step grows its next set", () => {
    const g = new TestGraph();
    const result = computableWorkList(["a"], g.step);
    const snapshots = observe(result);
    g.set("a", [], "A");
    expect([...snapshots[0]]).to.deep.equal([["a", "A"]]);

    g.set("a", ["b"], "A");
    expect(g.calls).to.deep.equal(["a", "b"]);
    expect(result.isSettled()).to.equal(false); // b pending again
    g.set("b", [], "B");
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
    ]);
  });

  it("drops keys that become unreachable, detaching their idle step nodes", () => {
    const sources = new Map<string, StepSource>([
      ["a", new StepSource()],
      ["b", new StepSource()],
    ]);
    sources.get("a")?.set({ value: "A", next: ["b"] });
    sources.get("b")?.set({ value: "B", next: [] });
    const step = (key: string): StepSource => {
      const source = sources.get(key);
      if (source === undefined) {
        throw new Error(`no source for ${key}`);
      }
      return source;
    };
    const snapshots = observe(computableWorkList(["a"], step));
    expect([...snapshots[0]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
    ]);

    /* a's edges re-resolve without b: b leaves the result and its source,
     * no longer demanded by anything, detaches. */
    sources.get("a")?.set({ value: "A", next: [] });
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([["a", "A"]]);
    expect(sources.get("b")?.detaches).to.equal(1);

    /* b's backing value changes while unreachable — silently (detached). */
    sources.get("b")?.set({ value: "B2", next: [] });
    expect(snapshots).to.have.length(2);

    /* Rediscovery reattaches the memoized node, which re-reads the CURRENT
     * backing value — not the stale one from before it was dropped. */
    sources.get("a")?.set({ value: "A", next: ["b"] });
    expect(snapshots).to.have.length(3);
    expect([...snapshots[2]]).to.deep.equal([
      ["a", "A"],
      ["b", "B2"],
    ]);
    expect(sources.get("b")?.attaches).to.equal(2);
  });

  it("drops the whole tail of a chain when an upstream edge is deleted", () => {
    const g = new TestGraph();
    const snapshots = observe(computableWorkList(["a"], g.step));
    g.set("a", ["b"], "A");
    g.set("b", ["c"], "B");
    g.set("c", [], "C");
    expect(snapshots).to.have.length(1);
    expect([...snapshots[0]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ]);

    g.set("a", [], "A");
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([["a", "A"]]);
    expect(g.calls).to.deep.equal(["a", "b", "c"]);
  });

  it("keeps a diamond's shared key when one arm is dropped", () => {
    const sources = new Map<string, StepSource>();
    const calls: string[] = [];
    for (const [key, item] of [
      ["a", { value: "A", next: ["b", "c"] }],
      ["b", { value: "B", next: ["d"] }],
      ["c", { value: "C", next: ["d"] }],
      ["d", { value: "D", next: [] }],
    ] as [string, Item][]) {
      const source = new StepSource();
      source.set(item);
      sources.set(key, source);
    }
    const step = (key: string): StepSource => {
      calls.push(key);
      const source = sources.get(key);
      if (source === undefined) {
        throw new Error(`no source for ${key}`);
      }
      return source;
    };
    const snapshots = observe(computableWorkList(["a"], step));
    expect([...snapshots[0]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
      ["d", "D"],
    ]);

    /* Drop the a → b arm: d stays reachable via c, now discovered after it. */
    sources.get("a")?.set({ value: "A", next: ["c"] });
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([
      ["a", "A"],
      ["c", "C"],
      ["d", "D"],
    ]);
    expect(calls).to.deep.equal(["a", "b", "c", "d"]); // never re-stepped

    /* b is fully released; d — still reachable — ends attached (the recompute may
     * transiently release and re-demand it, re-reading its current state). */
    const b = sources.get("b");
    const d = sources.get("d");
    expect(b?.detaches).to.equal(b?.attaches);
    expect(d?.attaches).to.equal((d?.detaches ?? 0) + 1);
  });

  it("drops a cycle that becomes unreachable from the seeds", () => {
    const g = new TestGraph();
    const snapshots = observe(computableWorkList(["a"], g.step));
    g.set("a", ["b"], "A");
    g.set("b", ["c"], "B");
    g.set("c", ["b"], "C");
    expect(snapshots).to.have.length(1);

    /* The b ↔ c cycle keeps referencing itself, but nothing reaches it: it must
     * drop — reachability is recomputed from the seeds, not reference-counted. */
    g.set("a", [], "A");
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([["a", "A"]]);
  });

  it("recomputes through a cycle when one of its edges re-resolves", () => {
    const g = new TestGraph();
    const snapshots = observe(computableWorkList(["a"], g.step));
    g.set("a", ["b"], "A");
    g.set("b", ["a"], "B");
    expect(snapshots).to.have.length(1);

    /* Break the cycle and point b at a new key instead. */
    g.set("b", ["c"], "B");
    g.set("c", [], "C");
    expect(snapshots).to.have.length(2);
    expect([...snapshots[1]]).to.deep.equal([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ]);
    expect(g.calls).to.deep.equal(["a", "b", "c"]);
  });
});
