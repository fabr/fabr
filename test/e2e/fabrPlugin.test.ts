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

/* A plugin a project builds itself: a `fabr_plugin` over a `js_package` of its
 * code. The stub compiler copies sources verbatim, so the rule module is
 * written as the CommonJS it is built as. */
const GREETING_RULE = `const core = require("@fabr-build/core");
exports.default = {
  evaluate: context =>
    context.getProperty("text").then(text => new core.FileSet(new Map([["greeting.txt", core.MemoryFile.from(String(text) + "\\n")]]))),
};
`;

/** A project using the plugin `greeter` it builds, with `extra` appended to its PROJECT.fabr. */
function project(extra = ""): Record<string, string> {
  return {
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\nplugin greeter;\n\n" +
      STUB_TSC_CONFIG +
      "JS_TARGET = es2020;\n" +
      "js_package greeter_code { srcs = plugin/src:**/*.ts; exports = plugin/src:rules/*.ts; }\n" +
      "fabr_plugin greeter { srcs = greeter_code; libs = plugin/lib/GREET.fabr; }\n" +
      "greeting hello { text = Hello; }\n" +
      "notes = notes.txt;\n" +
      extra,
    "plugin/src/rules/Greeting.ts": GREETING_RULE,
    "plugin/lib/GREET.fabr": "targetdef greeting {\n  text = STRING;\n}\n\nrule greeting g = greeter:rules/Greeting;\n",
    "notes.txt": "notes\n",
  };
}

describe("e2e: a plugin built in the project", () => {
  it("builds the plugin's code when its rule is first used, and builds a target with it", () => {
    const result = runFabr(project(), ["cat", "hello:greeting.txt"]);
    expect(result.stderr).to.not.match(/^error/m);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("Hello\n");
  });

  it("builds nothing of the plugin where nothing uses its rules", () => {
    const result = runFabr(project(), ["cat", "notes"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("notes\n");
    expect(result.stderr).to.not.contain("greeter_code");
  });

  it("packages the plugin as its code with its .fabr files, its package.json naming it a plugin", () => {
    const listed = runFabr(project(), ["ls", "greeter"]);
    expect(listed.status).to.equal(0);
    expect(listed.stdout.split("\n")).to.include.members(["plugin/lib/GREET.fabr", "rules/Greeting.js", "package.json"]);
    const manifest = JSON.parse(runFabr(project(), ["cat", "greeter:package.json"]).stdout);
    expect(manifest.name).to.equal("greeter");
    expect(manifest["@fabr-build/plugin"]).to.deep.equal({ libs: ["plugin/lib/GREET.fabr"] });
  });

  it("uses an installed plugin by a name the project gives it, its rules naming it as itself", () => {
    const files = {
      ...STUB_TSC,
      "PROJECT.fabr":
        "@boot = @fabr-home:@fabr-build;\nplugin @boot/js;\n\n" + STUB_TSC_CONFIG + "js_package lib { srcs = src:**/*.ts; }\n",
      "src/index.ts": "exports.x = 1;\n",
    };
    const result = runFabr(files, ["ls", "lib"]);
    expect(result.stderr).to.not.match(/^error/m);
    expect(result.status).to.equal(0);
    expect(result.stdout.split("\n")).to.include("index.js");
  });

  it("uses an installed plugin named through @fabr-home", () => {
    const files = {
      ...STUB_TSC,
      "PROJECT.fabr": "plugin @fabr-home:@fabr-build/js;\n\n" + STUB_TSC_CONFIG + "js_package lib { srcs = src:**/*.ts; }\n",
      "src/index.ts": "exports.x = 1;\n",
    };
    const result = runFabr(files, ["ls", "lib"]);
    expect(result.stderr).to.not.match(/^error/m);
    expect(result.status).to.equal(0);
    expect(result.stdout.split("\n")).to.include("index.js");
  });

  it("refuses two uses of one plugin under different names", () => {
    const files = { "PROJECT.fabr": "@boot = @fabr-home:@fabr-build;\nplugin @boot/js;\nplugin @fabr-build/js;\n", "notes.txt": "x\n" };
    const result = runFabr(files, ["cat", "notes.txt"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/Plugin '@fabr-build\/js' is a second plugin named '@fabr-build\/js'/);
  });

  it("refuses an installed package its package.json does not mark a plugin", () => {
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-build/js-tools;\n", "notes.txt": "x\n" }, ["cat", "notes.txt"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/Package '@fabr-build\/js-tools' is not a fabr plugin: its package.json has no "@fabr-build\/plugin"/);
  });

  it("reports why a plugin's code failed to build where its rule is used", () => {
    const files = project();
    files["PROJECT.fabr"] = files["PROJECT.fabr"].replace("js_package greeter_code {", "js_package greeter_code { deps = no_such_dep;");
    const result = runFabr(files, ["cat", "hello:greeting.txt"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/no_such_dep/);
  });

  it("refuses a plugin name that is a scope rather than a package", () => {
    const result = runFabr({ "PROJECT.fabr": "plugin @fabr-home:@fabr-build;\n", "notes.txt": "x\n" }, ["cat", "notes.txt"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/Plugin '@fabr-home:@fabr-build' names no package/);
  });

  it("reports libs that name no file at the plugin's declaration of them", () => {
    const files = project();
    delete files["plugin/lib/GREET.fabr"];
    const result = runFabr(files, ["cat", "hello:greeting.txt"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/Included file not found: plugin\/lib\/GREET\.fabr/);
  });
});
