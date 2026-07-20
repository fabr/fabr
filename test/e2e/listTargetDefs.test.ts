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

/* `fabr list-targetdefs`: the model-query verb that prints the build vocabulary
 * (target types, their supported operations, their properties) without building
 * anything. Its whole point is that it reflects the *loaded* model — core plus
 * the project's active plugins — so the fixtures assert that plugin-contributed
 * types appear and that a type's operations come from its registered rules. */
describe("e2e: list-targetdefs", () => {
  it("lists core target types with their operations and properties", () => {
    /* No plugins declared, so only core's STD.fabr vocabulary is present. */
    const result = runFabr({ "PROJECT.fabr": "# empty\n" }, ["list-targetdefs"]);
    expect(result.status).to.equal(0);
    /* Operations come from the registered rules: script/serve are run-only,
     * generate is build-only, sync is build (dry-run artifacts) plus a files
     * view, and flag carries a wildcard-operation rule. */
    expect(result.stdout).to.match(/^script \[run\]$/m);
    expect(result.stdout).to.match(/^serve \[run\]$/m);
    expect(result.stdout).to.match(/^generate \[build\]$/m);
    expect(result.stdout).to.match(/^flag \[\*\]$/m);
    expect(result.stdout).to.match(/^sync \[build, files\]$/m);
    /* A property line renders name + (REQUIRED) type as written in the def. */
    expect(result.stdout).to.match(/entry\s+REQUIRED FILES/);
    /* A pure repository type has no build rules, so no operations bracket. */
    expect(result.stdout).to.match(/^catalog$/m);
    /* Nothing was built. */
    expect(result.stderr).not.to.match(/Building/);
  });

  it("includes plugin-contributed types, with operations from their rules", () => {
    /* Declaring the js plugin brings its target types into the model; a filter
     * argument narrows the listing to just the named type. js_package is
     * built/tested/run, so all three operations show — the key property that
     * this is derived from live rule registration, not a static list. */
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-build/js;\n" }, ["list-targetdefs", "js_package"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.match(/^js_package \[build, run, test\]$/m);
    expect(result.stdout).to.match(/metadata\s+MAP/);
    /* The filter excludes every other type. */
    expect(result.stdout).not.to.match(/^script/m);
  });

  it("under -l attributes each type to its contributing lib file", () => {
    /* The location is where the type is defined — core's STD.fabr for a core
     * type, the js plugin's JS.fabr for a plugin type — so `-l` doubles as
     * "which contribution supplied this". */
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-build/js;\n" }, ["list-targetdefs", "-l", "js_package", "script"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.match(/^js_package \[build, run, test\]\s+\S*JS\.fabr:\d+:\d+$/m);
    expect(result.stdout).to.match(/^script \[run\]\s+\S*STD\.fabr:\d+:\d+$/m);
  });

  it("--json emits structured data: operations, descriptions, property schema", () => {
    const result = runFabr({ "PROJECT.fabr": "# empty\n" }, ["list-targetdefs", "--json", "script"]);
    expect(result.status).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.targetdefs).to.have.lengthOf(1);
    const def = parsed.targetdefs[0];
    expect(def.name).to.equal("script");
    expect(def.operations).to.deep.equal(["run"]);
    /* The doc-comment prose is carried through, marker-stripped. */
    expect(def.description).to.match(/^Define a runnable plain shell script/);
    /* Property schema: type, required flag, and (absent here) description. */
    const entry = def.properties.find((p: { name: string }) => p.name === "entry");
    expect(entry).to.deep.include({ type: "FILES", required: true });
    const deps = def.properties.find((p: { name: string }) => p.name === "deps");
    expect(deps).to.deep.include({ required: false });
  });

  it("errors on an unknown target type rather than exiting empty", () => {
    const result = runFabr({ "PROJECT.fabr": "# empty\n" }, ["list-targetdefs", "nonesuch"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/No such target type: nonesuch/);
  });
});
