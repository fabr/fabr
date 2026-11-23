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

const { probe } = require("./lib/probe");
const path = require("path");
/* Required before the mock is written: jest hoists jest.mock above it. */
const shapes = require("./lib/shapes");
jest.mock("./lib/shapes", () => ({ area: () => "mocked area" }));

it("hoists jest.mock above an earlier require", () => {
  probe("mocks2.hoist", shapes.area(2, 3));
});

it("automocks the actual module, not its manual mock", () => {
  const auto = jest.createMockFromModule("./lib/greeter");
  probe("mocks2.automock-manual", { isMock: jest.isMockFunction(auto.greet), returns: auto.greet() === undefined ? "<undefined>" : auto.greet() });
});

it("automocks the actual module, not its factory", () => {
  const auto = jest.createMockFromModule("./lib/shapes");
  probe("mocks2.automock-factory", Object.keys(auto).sort());
});

it("resolves a mocked module to its real file", () => {
  probe("mocks2.resolve", path.relative(__dirname, require.resolve("./lib/shapes")));
});

it("isolates modules asynchronously", async () => {
  let count;
  await jest.isolateModulesAsync(async () => { count = require("./lib/counter").count; });
  probe("mocks2.isolate-async", count);
});
