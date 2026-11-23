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

const { probe, attempt } = require("./lib/probe");
jest.mock("./lib/greeter");
jest.mock("virtual-thing", () => ({ virtual: true }), { virtual: true });
const greeter = require("./lib/greeter");
const uuid = require("uuid");

it("uses a manual mock beside the module", () => {
  probe("mocks.adjacent", greeter.greet());
});

it("uses a root manual mock of a package without being told", () => {
  probe("mocks.root", typeof uuid.v4 === "function" ? uuid.v4() : uuid);
});

it("resolves a virtual mock", () => {
  probe("mocks.virtual", require("virtual-thing"));
});

it("requires a mock and sets one", () => {
  jest.setMock("./lib/counter", { count: 7 });
  probe("mocks.set", { setMock: require("./lib/counter").count, requireMock: attempt(() => jest.requireMock("./lib/greeter").greet()) });
});

it("automocks a module's functions and classes", () => {
  const auto = jest.createMockFromModule("./lib/shapes");
  probe("mocks.shapes", {
    keys: Object.keys(auto).sort(), fn: jest.isMockFunction(auto.area), cls: jest.isMockFunction(auto.Square),
    method: auto.Square && jest.isMockFunction(auto.Square.prototype.size), value: auto.UNIT, nested: auto.nested && jest.isMockFunction(auto.nested.deep),
    arrowFn: jest.isMockFunction(auto.arrow), getter: (() => { try { return auto.computed; } catch (e) { return "threw"; } })(),
  });
});

it("reports mock call details", () => {
  const fn = jest.fn((a, b) => a + b).mockName("adder");
  fn(1, 2);
  probe("mocks.fn", { name: fn.getMockName(), calls: fn.mock.calls, results: fn.mock.results, contexts: fn.mock.contexts.length, lastCall: fn.mock.lastCall });
});
