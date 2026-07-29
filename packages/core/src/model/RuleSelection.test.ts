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
import { LogFormatter, LogLevel } from "../support/Log";
import { toBuildModel } from "./Sema";
import { Constraints } from "./Constraints";
import { expect } from "chai";

const wildcardRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const testRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const specificTestRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const defaultRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);
const overrideRule = (): Computable<FileSet> => Computable.resolve(EMPTY_FILESET);

/* Rule selection is a BuildModel responsibility: its rule tables are indexed
 * from the contribution set (a rule with no `type` is a default/all-types rule).
 * No declarations are needed to exercise selection, so the model is built over an
 * empty file set. */
const logger = new LogFormatter(LogLevel.Info, () => undefined);
const model = toBuildModel([], logger, [
  {
    rules: [
      { type: "reg_test", constraints: {}, evaluate: wildcardRule },
      { type: "reg_test", constraints: { BUILD_OPERATION: "test" }, evaluate: testRule },
      /* A type with only operation-specific rules (no {} catch-all), so an
       * operation it doesn't cover falls through to the default rule. */
      { type: "reg_specific", constraints: { BUILD_OPERATION: "test" }, evaluate: specificTestRule },
      /* A type-specific rule matching the same operation as the default rule, to
       * prove the type-specific one is preferred. */
      { type: "reg_override", constraints: { BUILD_OPERATION: "reg_default" }, evaluate: overrideRule },
      { constraints: { BUILD_OPERATION: "reg_default" }, evaluate: defaultRule },
    ],
  },
]);

describe("BuildModel rule selection", () => {
  it("selects the most specific matching rule", () => {
    expect(model.getTargetRule("reg_test", Constraints.of({}))?.evaluate).to.equal(wildcardRule);
    expect(model.getTargetRule("reg_test", Constraints.of({ BUILD_OPERATION: "build" }))?.evaluate).to.equal(wildcardRule);
    expect(model.getTargetRule("reg_test", Constraints.of({ BUILD_OPERATION: "test" }))?.evaluate).to.equal(testRule);
    /* Unrelated constraints don't disturb selection */
    expect(model.getTargetRule("reg_test", Constraints.of({ BUILD_OPERATION: "test", arch: "armv7" }))?.evaluate).to.equal(testRule);
  });

  it("returns undefined when no rule matches", () => {
    expect(model.getTargetRule("no_such_type", Constraints.of({}))).to.equal(undefined);
  });

  it("falls back to a default rule for any type when no type-specific rule matches", () => {
    /* A type with no rules at all: the default rule applies */
    expect(model.getTargetRule("some_other_type", Constraints.of({ BUILD_OPERATION: "reg_default" }))?.evaluate).to.equal(defaultRule);
    /* A type that HAS rules, but none matching this operation: still falls back */
    expect(model.getTargetRule("reg_specific", Constraints.of({ BUILD_OPERATION: "reg_default" }))?.evaluate).to.equal(defaultRule);
  });

  it("lets a type's own {} wildcard shadow the default rule", () => {
    /* reg_test's {} rule is type-specific, so it matches every operation and the
     * default is never reached — the type dimension dominates. */
    expect(model.getTargetRule("reg_test", Constraints.of({ BUILD_OPERATION: "reg_default" }))?.evaluate).to.equal(wildcardRule);
  });

  it("prefers a type-specific rule over a default rule matching the same operation", () => {
    expect(model.getTargetRule("reg_override", Constraints.of({ BUILD_OPERATION: "reg_default" }))?.evaluate).to.equal(overrideRule);
  });

  it("errors on an ambiguous (equally-specific) rule tie rather than picking first-registered", () => {
    const tied = toBuildModel([], logger, [
      {
        rules: [
          { type: "amb", constraints: { BUILD_OPERATION: "test" }, evaluate: testRule },
          { type: "amb", constraints: { arch: "armv7" }, evaluate: specificTestRule },
        ],
      },
    ]);
    /* Both rules have one constraint and both match, so neither is more specific. */
    expect(() => tied.getTargetRule("amb", Constraints.of({ BUILD_OPERATION: "test", arch: "armv7" }))).to.throw(/Ambiguous 'amb' rule selection/);
    /* But a config satisfying only one of them selects cleanly. */
    expect(tied.getTargetRule("amb", Constraints.of({ BUILD_OPERATION: "test" }))?.evaluate).to.equal(testRule);
  });
});

describe("BuildModel repository registration", () => {
  const provider = (): never => {
    throw new Error("unused");
  };
  it("rejects a duplicate repository type across contributions", () => {
    expect(() =>
      toBuildModel([], logger, [
        { repositories: [{ type: "dup", provider }] },
        { repositories: [{ type: "dup", provider }] },
      ])
    ).to.throw(/Duplicate repository type 'dup'/);
  });
});
