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
import { select } from "./Functional";

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
