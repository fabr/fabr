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
import { closestMatch } from "./Suggest";

describe("closestMatch", () => {
  it("finds a near-exact slip", () => {
    expect(closestMatch("mytargt", ["other", "mytarget", "misc"])).to.equal("mytarget");
    expect(closestMatch("BULD_TYPE", ["BUILD_TYPE", "JS_TARGET"])).to.equal("BUILD_TYPE");
  });

  it("matches case-insensitively", () => {
    expect(closestMatch("build_type", ["BUILD_TYPE"])).to.equal("BUILD_TYPE");
  });

  it("returns nothing when no candidate is plausibly a typo", () => {
    expect(closestMatch("frobnicate", ["BUILD_TYPE", "JS_TARGET"])).to.equal(undefined);
    /* Short names only tolerate one edit. */
    expect(closestMatch("abc", ["xyz"])).to.equal(undefined);
    expect(closestMatch("abc", ["abd"])).to.equal("abd");
  });

  it("prefers the closer candidate, breaking ties by order", () => {
    expect(closestMatch("tool", ["toole", "toolz"])).to.equal("toole");
    expect(closestMatch("toolbox", ["toolbo", "toolboxy"])).to.equal("toolbo");
  });
});
