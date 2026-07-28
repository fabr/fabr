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

describe("validateTarget (MAP properties)", () => {
  const def = "targetdef m { defines = MAP; srcs = FILES; }\n";

  it("accepts a well-formed MAP block", () => {
    const errors = validationErrors(def + "m t { defines = { DEBUG = false; process.env.X = ${Y}; } }\n");
    expect(errors).to.deep.equal([]);
  });

  it("accepts a bare reference value for a MAP property (resolved at read time)", () => {
    /* `defines = foo;` references another block-valued property; Validate doesn't
     * resolve it (an unknown reference is a resolution-time error). */
    const errors = validationErrors(def + "m t { defines = foo; }\n");
    expect(errors).to.deep.equal([]);
  });

  it("rejects a block value for a non-MAP property", () => {
    const errors = validationErrors(def + "m t { srcs = { a = b; } }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/a `\{ ... \}` block is only valid for a MAP property/);
  });

  it("rejects duplicate keys within a block", () => {
    const errors = validationErrors(def + "m t { defines = { A = 1; A = 2; } }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/duplicate map key 'A'/);
  });

  it("rejects a rename facet on a map value", () => {
    const errors = validationErrors(def + "m t { defines = { A = x -> y; } }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/a map value cannot carry a rename/);
  });

  it("accepts nested blocks and lists of blocks (sub-maps / arrays of maps)", () => {
    const errors = validationErrors(
      def + "m t { defines = { repository = { type = git; url = u; }; maintainers = { name = a; } { name = b; }; }; }\n"
    );
    expect(errors).to.deep.equal([]);
  });

  it("rejects mixing strings and blocks in one entry", () => {
    const errors = validationErrors(def + "m t { defines = { A = x { B = c; }; }; }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/either strings or maps, not a mix/);
  });

  it("rejects a list of blocks at the top level of a MAP property", () => {
    const errors = validationErrors(def + "m t { defines = { A = 1; } { B = 2; }; }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/a MAP property takes a single `\{ ... \}` block/);
  });

  it("rejects mixing a block with references at the top level", () => {
    const errors = validationErrors(def + "m t { defines = base { A = 1; }; }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/single `\{ ... \}` block or bare reference\(s\), not a mix/);
  });

  it("rejects duplicate keys within a nested block", () => {
    const errors = validationErrors(def + "m t { defines = { A = { B = 1; B = 2; }; }; }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/duplicate map key 'B'/);
  });

  it("rejects a command (pipeline) inside a map block", () => {
    const errors = validationErrors(def + "m t { defines = { A = a | b; }; }\n");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/a command .*is not valid in a map block/);
  });
});

describe("validateProperty (global / schema-less properties)", () => {
  it("validates a global map block's internals (duplicate key)", () => {
    const errors = validationErrors("meta = { A = 1; A = 2; };");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/duplicate map key 'A'/);
  });

  it("accepts a well-formed global map block", () => {
    expect(validationErrors("meta = { A = 1; B = 2; };")).to.deep.equal([]);
  });

  it("validates a default property's map block too", () => {
    const errors = validationErrors("default meta = { A = 1; A = 2; };");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/duplicate map key 'A'/);
  });

  it("does not statically reject a command in a standalone property (the chase)", () => {
    /* A pipeline defined in a standalone property is legit until it lands in a
     * non-COMMAND slot — a resolution-time backstop, not a static error. */
    expect(validationErrors("shared = a | b;")).to.deep.equal([]);
  });
});
