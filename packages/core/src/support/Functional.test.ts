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

import { expect } from "chai";
import { Computable } from "../core/Computable";
import { mapComputable, select } from "./Functional";

describe("select", () => {
  it("maps and drops undefined results in one pass", () => {
    expect(select([1, 2, 3, 4], n => (n % 2 === 0 ? n * 10 : undefined))).to.deep.equal([20, 40]);
  });

  it("keeps a defined falsy result (only undefined is dropped)", () => {
    expect(select([1, 2, 3], n => (n === 2 ? undefined : 0))).to.deep.equal([0, 0]);
  });

  it("still runs a side effect on the selected-out path", () => {
    const seen: number[] = [];
    const kept = select([1, 2, 3], n => {
      if (n === 2) {
        seen.push(n);
        return undefined;
      }
      return n;
    });
    expect(kept).to.deep.equal([1, 3]);
    expect(seen).to.deep.equal([2]);
  });

  it("accepts any iterable", () => {
    expect(select(new Set(["a", "bb", "ccc"]), s => (s.length > 1 ? s.toUpperCase() : undefined))).to.deep.equal(["BB", "CCC"]);
  });
});

describe("mapComputable", () => {
  const toPromise = <T>(computable: Computable<T>): Promise<T> => new Promise((resolve, reject) => computable.then(resolve, reject));
  /** An operation its test settles by hand. */
  const deferred = <T>(): { result: Computable<T>; resolve: (value: T) => void; reject: (err: Error) => void } => {
    let resolve!: (value: T) => void;
    let reject!: (err: Error) => void;
    const result = Computable.from<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { result, resolve, reject };
  };

  it("yields the results in item order, whatever order they settle in", async () => {
    const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
    const mapped = toPromise(mapComputable(pending, item => item.result));
    pending[2].resolve("c");
    pending[0].resolve("a");
    pending[1].resolve("b");
    expect(await mapped).to.deep.equal(["a", "b", "c"]);
  });

  it("takes plain values as well as sources, and an empty list", async () => {
    expect(await toPromise(mapComputable([1, 2, 3], (n, index) => (n === 2 ? Computable.resolve(n * 10) : n + index)))).to.deep.equal([1, 20, 5]);
    expect(await toPromise(mapComputable([], () => 1))).to.deep.equal([]);
  });

  it("takes any iterable, reading it as the operations start", async () => {
    const read: number[] = [];
    function* numbers(): Generator<number> {
      for (let n = 0; n < 3; n++) {
        read.push(n);
        yield n;
      }
    }
    const gate = deferred<number>();
    const mapped = toPromise(mapComputable(numbers(), n => (n === 0 ? gate.result : n * 2), 1));
    expect(read).to.deep.equal([0]);
    gate.resolve(100);
    expect(await mapped).to.deep.equal([100, 2, 4]);
    expect(await toPromise(mapComputable(new Set(["a", "b"]), text => text.toUpperCase()))).to.deep.equal(["A", "B"]);
  });

  it("starts an item only when its turn comes, never more than the cap at once", async () => {
    const pending = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const mapped = toPromise(
      mapComputable(
        pending,
        (item, index) => {
          started.push(index);
          return item.result;
        },
        2
      )
    );
    expect(started).to.deep.equal([0, 1]);
    pending[1].resolve(1);
    expect(started).to.deep.equal([0, 1, 2]);
    pending[0].resolve(0);
    pending[2].resolve(2);
    expect(started).to.deep.equal([0, 1, 2, 3, 4]);
    pending[3].resolve(3);
    pending[4].resolve(4);
    expect(await mapped).to.deep.equal([0, 1, 2, 3, 4]);
  });

  it("maps a list far longer than a call can take arguments", async () => {
    const items = Array.from({ length: 300000 }, (_, index) => index);
    const mapped = await toPromise(mapComputable(items, n => (n % 2 === 0 ? n : Computable.resolve(n))));
    expect(mapped.length).to.equal(items.length);
    expect(mapped[299999]).to.equal(299999);
  });

  it("starts nothing after a failure, and rejects with the first error once the rest settle", async () => {
    const pending = Array.from({ length: 4 }, () => deferred<number>());
    const started: number[] = [];
    let settled = false;
    const mapped = toPromise(
      mapComputable(
        pending,
        (item, index) => {
          started.push(index);
          return item.result;
        },
        2
      )
    ).then(
      () => undefined,
      (err: Error) => {
        settled = true;
        return err;
      }
    );
    pending[1].reject(new Error("first"));
    await Promise.resolve();
    expect(started).to.deep.equal([0, 1]);
    expect(settled).to.equal(false);
    pending[0].reject(new Error("second"));
    expect((await mapped)?.message).to.equal("first");
  });

  it("turns a throw from the operation into the rejection", async () => {
    const failure = await toPromise(
      mapComputable([1, 2], n => {
        if (n === 2) {
          throw new Error("thrown");
        }
        return n;
      })
    ).then(
      () => undefined,
      (err: Error) => err
    );
    expect(failure?.message).to.equal("thrown");
  });
});
