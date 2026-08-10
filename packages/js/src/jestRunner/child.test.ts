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
import { makeJestGlobals } from "./child";

/* This very test process has the framework's globals installed (it runs under a
 * jest-flavoured runner either way), which is exactly the situation
 * makeJestGlobals reads from — a module importing `@jest/globals` while its
 * test file loads. */
describe("makeJestGlobals", () => {
  const EXPORTS = [
    "expect", "describe", "fdescribe", "xdescribe", "it", "fit", "xit", "test", "xtest",
    "beforeAll", "beforeEach", "afterAll", "afterEach",
  ];

  it("serves the full @jest/globals namespace off the global object", () => {
    const jest = { marker: true };
    const namespace = makeJestGlobals(jest);
    expect(namespace.jest).to.equal(jest);
    for (const name of EXPORTS) {
      expect(namespace[name], name).to.equal((globalThis as Record<string, unknown>)[name]);
      expect(typeof namespace[name], name).to.equal("function");
    }
  });

  it("serves nothing beyond the namespace jest declares", () => {
    expect(Object.keys(makeJestGlobals({}))).to.have.members(["jest", ...EXPORTS]);
  });

  it("fails loudly on a missing global rather than exporting undefined", () => {
    const globals = globalThis as Record<string, unknown>;
    const saved = globals.xtest;
    delete globals.xtest;
    try {
      expect(() => makeJestGlobals({})).to.throw(/'@jest\/globals' cannot serve 'xtest'/);
    } finally {
      globals.xtest = saved;
    }
  });
});
