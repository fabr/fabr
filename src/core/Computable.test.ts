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

import { Computable } from "./Computable";
import { MultiError } from "./MultiError";

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
    expect(values).toStrictEqual([7]);
    /* Changed value propagates */
    resolve(10);
    expect(values).toStrictEqual([7, 14]);

    /* Same value doesn't cause child updates */
    resolve(10);
    expect(values).toStrictEqual([7, 14]);
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
    expect(values).toStrictEqual([8]);
    resolve(4);
    expect(values).toStrictEqual([8, 10]);
  });

  it("propagates errors to dependent computables", () => {
    const errors: string[] = [];
    const c = Computable.reject<number>(new Error("boom"));
    c.then(value => value + 1).catch(err => errors.push(err.message));
    expect(errors).toStrictEqual(["boom"]);
  });

  it("catch passes valid values through", () => {
    const values: number[] = [];
    Computable.resolve(5)
      .catch(() => -1)
      .then(value => values.push(value));
    expect(values).toStrictEqual([5]);
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
    expect(values).toStrictEqual(["err:bad"]);
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
    expect(values).toStrictEqual(["err:bad", "ok:7"]);
  });

  it("aggregates multiple distinct errors into a MultiError", () => {
    const errors: Error[] = [];
    const a = Computable.reject<number>(new Error("a"));
    const b = Computable.reject<number>(new Error("b"));
    Computable.forAll([a, b], (x, y) => x + y).catch(err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MultiError);
    expect((errors[0] as MultiError).errors.map(err => err.message)).toStrictEqual(["a", "b"]);
  });

  it("dedupes the same error arriving via multiple paths", () => {
    const errors: Error[] = [];
    const root = Computable.reject<number>(new Error("root"));
    const left = root.then(value => value + 1);
    const right = root.then(value => value * 2);
    Computable.forAll([left, right], (l, r) => l + r).catch(err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("root");
    expect(errors[0]).not.toBeInstanceOf(MultiError);
  });

  it("coerces thrown non-Error values to Error", () => {
    const errors: Error[] = [];
    Computable.resolve(1)
      .then(() => {
        throw "plain string";
      })
      .catch(err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe("plain string");
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
    expect(values).toStrictEqual([2]);
    expect(runs).toBe(1);

    /* Revalidate with the same value: nothing recomputes */
    src.invalidate();
    resolve(1);
    expect(runs).toBe(1);
    expect(values).toStrictEqual([2]);

    /* An actual change recomputes as usual */
    resolve(3);
    expect(runs).toBe(2);
    expect(values).toStrictEqual([2, 6]);
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
    expect(caught).toStrictEqual(["fail:1"]);
    expect(runs).toBe(1);

    /* Revalidate with the same value: nothing recomputes, the error state is retained */
    src.invalidate();
    resolve(1);
    expect(runs).toBe(1);
    expect(caught).toStrictEqual(["fail:1"]);

    /* An actual change recomputes as usual */
    resolve(2);
    expect(runs).toBe(2);
    expect(caught).toStrictEqual(["fail:1", "fail:2"]);
  });
});
