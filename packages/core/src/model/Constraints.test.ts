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
import { BUILD_OPERATION, Constraints, COVERAGE, HOST, shownConstraints, TARGET } from "./Constraints";
import { hostTriple } from "../support/Platform";

describe("shownConstraints", () => {
  const other = "riscv64-unknown-linux-gnu";

  it("leaves out the ambient keys", () => {
    const constraints = Constraints.of({ [BUILD_OPERATION]: "run", BUILD_TYPE: "release" });
    expect(shownConstraints(constraints)).to.deep.equal([["BUILD_TYPE", "release"]]);
  });

  it("leaves out a TARGET that is the host, as running a tool pins it", () => {
    expect(shownConstraints(Constraints.of({ [TARGET]: hostTriple() }))).to.deep.equal([]);
  });

  it("takes a HOST constraint as the host, and shows it, since it overrides the machine's", () => {
    expect(shownConstraints(Constraints.of({ [HOST]: other, [TARGET]: other }))).to.deep.equal([[HOST, other]]);
  });

  it("shows a TARGET other than the host — a cross build is a choice", () => {
    expect(shownConstraints(Constraints.of({ [TARGET]: other }))).to.deep.equal([[TARGET, other]]);
  });

  it("leaves out COVERAGE off, as running a tool pins it, and shows it on", () => {
    expect(shownConstraints(Constraints.of({ [COVERAGE]: "off" }))).to.deep.equal([]);
    expect(shownConstraints(Constraints.of({ [COVERAGE]: "on" }))).to.deep.equal([[COVERAGE, "on"]]);
  });
});
