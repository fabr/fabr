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

import { expect } from "chai";
import { Computable } from "../core/Computable";
import { MemoryCache } from "./MemoryCache";

describe("MemoryCache", () => {
  it("makes each key's computation once", () => {
    const memo = new MemoryCache<string, number>();
    let made = 0;
    const make = (): Computable<number> => Computable.resolve(++made);
    expect(memo.getOrCreate("a", make)).to.equal(memo.getOrCreate("a", make));
    memo.getOrCreate("b", make);
    expect(made).to.equal(2);
  });

  it("forgets a computation that failed, so the next ask makes it again", () => {
    const memo = new MemoryCache<string, number>();
    const failed = memo.getOrCreate("a", () => Computable.reject(new Error("dropped")));
    failed.catch(() => undefined);
    const retried = memo.getOrCreate("a", () => Computable.resolve(1));
    expect(retried).to.not.equal(failed);
    expect(retried.value).to.equal(1);
  });
});
