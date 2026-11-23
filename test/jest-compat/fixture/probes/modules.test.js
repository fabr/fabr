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
const path = require("path");

it("resolves a package's browser build", () => {
  probe("modules.conditions", { resolved: path.relative(path.dirname(require.resolve("uuid/package.json")), require.resolve("uuid")), v4: typeof require("uuid").v4 });
});

it("isolates and resets modules", () => {
  const first = require("./lib/counter");
  first.count++;
  let isolated;
  jest.isolateModules(() => { isolated = require("./lib/counter").count; });
  jest.resetModules();
  const fresh = require("./lib/counter").count;
  probe("modules.registry", { same: require("./lib/counter") === first, isolated, fresh });
});

it("mocks with a factory and requires the actual", () => {
  jest.doMock("./lib/counter", () => ({ count: 99 }));
  const mocked = require("./lib/counter").count;
  const actual = jest.requireActual("./lib/counter").count;
  jest.dontMock("./lib/counter");
  probe("modules.domock", { mocked, actual });
});

it("automocks a module", () => {
  const auto = jest.createMockFromModule("./lib/counter");
  probe("modules.automock", { keys: Object.keys(auto).sort(), fn: jest.isMockFunction(auto.increment) });
});

it("spies and replaces", () => {
  const obj = { get value() { return 1; }, method: () => "real" };
  const getter = jest.spyOn(obj, "value", "get").mockReturnValue(2);
  const method = jest.spyOn(obj, "method").mockReturnValue("fake");
  const replaced = jest.replaceProperty(process.env, "PROBE_VAR", "set");
  probe("modules.spies", { getter: obj.value, method: obj.method(), env: process.env.PROBE_VAR });
  getter.mockRestore(); method.mockRestore(); replaced.restore();
});

it("lists the jest object's API", () => {
  probe("modules.jest-api", Object.keys(jest).sort());
});

it("lists the test globals", () => {
  const names = ["describe", "fdescribe", "xdescribe", "it", "fit", "xit", "test", "xtest", "expect", "beforeAll", "beforeEach", "afterAll", "afterEach", "pending", "fail", "spyOn", "jasmine"];
  probe("modules.test-globals", Object.fromEntries(names.map(n => [n, typeof globalThis[n]])));
  probe("modules.test-members", { each: typeof test.each, concurrent: typeof test.concurrent, failing: typeof test.failing, todo: typeof test.todo, onlyEach: typeof test.only.each, describeEach: typeof describe.each });
  probe("modules.expect-api", Object.keys(expect).sort());
});

it("matches an inline snapshot", () => {
  expect({ a: 1 }).toMatchInlineSnapshot(`
{
  "a": 1,
}
`);
});

it("knows its own file", () => {
  probe("modules.self", { filename: path.basename(__filename), dirname: path.basename(__dirname), testPath: path.basename(expect.getState().testPath || ""), currentTestName: expect.getState().currentTestName });
});
