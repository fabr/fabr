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
import { EMPTY_FILESET } from "../core/FileSet";
import { LogFormatter, LogLevel } from "../support/Log";
import { parseBuildString } from "./Parser";
import { toBuildModel } from "./Sema";

/* Targetdef schema validation (Validate.validateTarget) runs during model build
 * (NamespaceBuilder.resolve), logging a diagnostic per violation. Each case here
 * builds a model from source and asserts exactly the diagnostics produced — the
 * focus is the interaction of a `* = TYPE` wildcard entry with named properties. */
function validationErrors(source: string): string[] {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", source, logger)], logger, []);
  return errors;
}

describe("validateTarget (targetdef schema)", () => {
  it("a wildcard-only targetdef admits any key, named or reference", () => {
    /* `* = FILES` types every member; nothing is 'unrecognized'. */
    const errors = validationErrors(
      "targetdef sync { * = FILES; }\n" + "sync s { anything = a; @npm:pkg:1.0 = b; }\n"
    );
    expect(errors).to.deep.equal([]);
  });

  it("a wildcard coexists with named properties (both admitted)", () => {
    /* A named `registry` alongside `*`: the named key and an arbitrary reference
     * key both pass — named-first, wildcard-as-fallback admission. */
    const errors = validationErrors(
      "targetdef sync { registry = STRING; * = FILES; }\n" + "sync s { registry = r; @npm:pkg:1.0 = b; }\n"
    );
    expect(errors).to.deep.equal([]);
  });

  it("a REQUIRED named property is still enforced when a wildcard is present", () => {
    /* The wildcard admits extra keys but does not satisfy a REQUIRED named one. */
    const errors = validationErrors(
      "targetdef sync { registry = STRING REQUIRED; * = FILES; }\n" + "sync s { @npm:pkg:1.0 = b; }\n"
    );
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/Missing required property 'registry'/);
  });

  it("still detects a duplicate named property alongside a wildcard", () => {
    const errors = validationErrors(
      "targetdef sync { registry = STRING; * = FILES; }\n" + "sync s { registry = a; registry = b; }\n"
    );
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/Duplicate property 'registry'/);
  });

  it("types a named property by its own schema, not the wildcard", () => {
    /* `out` is REWRITE, `*` is FILES. A bare glob value is illegal for REWRITE but
     * fine for FILES — so an error proves `out` is typed by its named entry
     * (named-first `?? wildcard`), while a wildcard member accepts the same glob. */
    const errors = validationErrors(
      "targetdef mix { out = REWRITE; * = FILES; }\n" + "mix m { out = *.js; member = *.js; }\n"
    );
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/bare REWRITE value must be a literal constant/);
  });

  it("a wildcard cannot express 'at least one member' (* = REQUIRED is a no-op)", () => {
    /* Documents the known asymmetry: the required check skips the `*` key, so a
     * member-less target of a `* = REQUIRED` type passes. */
    const errors = validationErrors("targetdef sync { * = FILES REQUIRED; }\n" + "sync empty { }\n");
    expect(errors).to.deep.equal([]);
  });
});
