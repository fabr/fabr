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
import { runFabr } from "./harness";

/* `fabr list-properties`: the model-query verb that prints the global
 * configuration surface — config properties and `flag` switches — without
 * building anything. It is the properties/flags counterpart to list-targetdefs
 * (which lists target types); neither is a buildable target. */
describe("e2e: list-properties", () => {
  it("lists config properties with their defaults, and flags", () => {
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-build/js;\n" }, ["list-properties"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.match(/BUILD_TYPE\s+= debug/);
    expect(result.stdout).to.match(/JS_TARGET\s+=/);
    expect(result.stdout).to.match(/Flags:/);
    expect(result.stdout).to.contain("ts/nostrict");
  });

  it("--json emits properties (value, location, description) and flags, by source", () => {
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-build/js;\n" }, ["list-properties", "--json"]);
    expect(result.status).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).to.deep.equal(["flags", "properties"]);

    const buildType = parsed.properties.find((p: { name: string }) => p.name === "BUILD_TYPE");
    expect(buildType).to.include({ value: "debug" });
    expect(buildType.location).to.match(/STD\.fabr/); /* core */
    expect(buildType.description).to.match(/Build type/);
    const jsTarget = parsed.properties.find((p: { name: string }) => p.name === "JS_TARGET");
    expect(jsTarget.location).to.match(/JS\.fabr/); /* plugin */

    const nostrict = parsed.flags.find((f: { name: string }) => f.name === "ts/nostrict");
    expect(nostrict.description).to.match(/strict mode off/);
    expect(nostrict.location).to.match(/JS\.fabr/);
  });

  it("without a plugin, lists only the core config", () => {
    const result = runFabr({ "PROJECT.fabr": "# empty\n" }, ["list-properties", "--json"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.properties.map((p: { name: string }) => p.name)).to.include("BUILD_TYPE");
    expect(parsed.properties.map((p: { name: string }) => p.name)).to.not.include("JS_TARGET");
    expect(parsed.flags).to.deep.equal([]);
  });
});

/* `fabr list-all`: the union of list-targetdefs + list-properties in one JSON
 * document, for a single tooling consumer (docs generation). */
describe("e2e: list-all", () => {
  it("emits the whole vocabulary — targetdefs, properties, flags, and provided targets — as one document", () => {
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-build/js;\n" }, ["list-all"]);
    expect(result.status).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).to.deep.equal(["flags", "properties", "targetdefs", "targets"]);
    expect(parsed.targetdefs.map((t: { name: string }) => t.name)).to.include.members(["script", "js_package"]);
    expect(parsed.properties.map((p: { name: string }) => p.name)).to.include("JS_TARGET");
    expect(parsed.flags.map((f: { name: string }) => f.name)).to.include("ts/nostrict");
    /* Provided targets include declared repository instances (not buildable,
     * so absent from list-targets) with the decl's written properties. */
    const npm = parsed.targets.find((t: { name: string }) => t.name === "@npm");
    expect(npm.type).to.equal("npm_repository");
    expect(npm.description).to.match(/public/);
    expect(npm.properties).to.deep.include({ name: "access", value: "public" });
  });
});
