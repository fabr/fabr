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

import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { getTargetRule, registerRule } from "./Registry";
import { expect } from "chai";

const wildcardRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const testRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);

registerRule("reg_test", {}, wildcardRule);
registerRule("reg_test", { BUILD_OPERATION: "test" }, testRule);

describe("Registry", () => {
  it("selects the most specific matching rule", () => {
    expect(getTargetRule("reg_test", {})?.evaluate).to.equal(wildcardRule);
    expect(getTargetRule("reg_test", { BUILD_OPERATION: "build" })?.evaluate).to.equal(wildcardRule);
    expect(getTargetRule("reg_test", { BUILD_OPERATION: "test" })?.evaluate).to.equal(testRule);
    /* Unrelated constraints don't disturb selection */
    expect(getTargetRule("reg_test", { BUILD_OPERATION: "test", arch: "armv7" })?.evaluate).to.equal(testRule);
  });

  it("returns undefined when no rule matches", () => {
    expect(getTargetRule("no_such_type", {})).to.equal(undefined);
  });
});
