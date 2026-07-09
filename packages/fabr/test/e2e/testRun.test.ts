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
import { runFabr, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/* `fabr test` end to end: compile a package's tests and run them under fabr's
 * own runner (sourced from the installed @fabr/js — no runner configuration,
 * no npm), proving both outcomes through the real CLI. The fixture asserts with
 * node:assert so it needs no downloaded assertion library; the stub tsc copies
 * the type-free test verbatim. A red run must fail the command AND render the
 * failure as a test outcome, not a build error. */
describe("e2e: fabr test (runner from @fabr/js)", () => {
  const project = (body: string): Record<string, string> => ({
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr/js;\n\n" +
      STUB_TSC_CONFIG +
      "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n",
    "src/thing.test.ts": `const assert = require("node:assert");\n${body}\n`,
  });

  it("fails the command and reports the failing test when a test fails", () => {
    const result = runFabr(
      project('describe("thing", () => { it("fails on purpose", () => { assert.equal(1, 2); }); });'),
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status).to.not.equal(0);
    /* rendered as a test outcome (name + message), not a build failure */
    expect(result.stderr).to.contain("test failed");
    expect(result.stderr).to.contain("fails on purpose");
  });

  it("passes cleanly when the tests pass", () => {
    const result = runFabr(
      project('describe("thing", () => { it("holds", () => { assert.equal(1, 1); }); });'),
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });
});
