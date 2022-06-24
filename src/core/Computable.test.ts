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

describe("Computable", () => {
  it("Simple", () => {
    const values: number[] = [];
    let resolve: (value: number) => void = () => {};
    const c = Computable.from<number>((res, rej) => {
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
    const c = Computable.from<number>((res, rej) => {
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
});
