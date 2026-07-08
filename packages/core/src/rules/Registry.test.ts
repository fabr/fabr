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
import { getTargetRule, registerDefaultRule, registerRule } from "./Registry";
import { expect } from "chai";

const wildcardRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const testRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const specificTestRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const defaultRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const overrideRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);

registerRule("reg_test", {}, wildcardRule);
registerRule("reg_test", { BUILD_OPERATION: "test" }, testRule);
/* A type with only operation-specific rules (no {} catch-all), so an operation
 * it doesn't cover falls through to the default rule. */
registerRule("reg_specific", { BUILD_OPERATION: "test" }, specificTestRule);
/* A type-specific rule matching the same operation as the default rule below,
 * to prove the type-specific one is preferred. */
registerRule("reg_override", { BUILD_OPERATION: "reg_default" }, overrideRule);
registerDefaultRule({ BUILD_OPERATION: "reg_default" }, defaultRule);

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

  it("falls back to a default rule for any type when no type-specific rule matches", () => {
    /* A type with no rules at all: the default rule applies */
    expect(getTargetRule("some_other_type", { BUILD_OPERATION: "reg_default" })?.evaluate).to.equal(defaultRule);
    /* A type that HAS rules, but none matching this operation: still falls back */
    expect(getTargetRule("reg_specific", { BUILD_OPERATION: "reg_default" })?.evaluate).to.equal(defaultRule);
  });

  it("lets a type's own {} wildcard shadow the default rule", () => {
    /* reg_test's {} rule is type-specific, so it matches every operation and the
     * default is never reached — the type dimension dominates. */
    expect(getTargetRule("reg_test", { BUILD_OPERATION: "reg_default" })?.evaluate).to.equal(wildcardRule);
  });

  it("prefers a type-specific rule over a default rule matching the same operation", () => {
    expect(getTargetRule("reg_override", { BUILD_OPERATION: "reg_default" })?.evaluate).to.equal(overrideRule);
  });
});
