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

/* `fabr deps` prints the dependency tree of what each name denotes. A target's
 * tree is read from what its rule says it requires, so it follows whichever
 * rule the name's configuration selects. Nothing is built, since each package
 * a target depends on is stated by its own rule. */
const PROJECT =
  "plugin @fabr-build/js;\n\n" +
  STUB_TSC_CONFIG +
  "\njs_package deps_base { srcs = base:**; }\n" +
  "js_package deps_helper { srcs = helper:**; }\n" +
  "js_package deps_lib { srcs = lib:**; deps = deps_base; }\n" +
  "js_package deps_app { srcs = app:**; tests = app:**/*.test.ts; deps = deps_lib deps_base; test_deps = deps_helper; }\n" +
  "js_script deps_tool { entry = tool/main.ts; deps = deps_lib; }\n" +
  "catalog @deps_cat { deps = deps_lib; }\n" +
  "js_package deps_viacat { srcs = viacat:**; deps = @deps_cat:deps_lib; }\n" +
  "DEPS_ALL = deps_lib deps_helper;\n" +
  "targetdef deps_bundle_type { deps = PACKAGES; }\n" +
  "rule deps_bundle_type b = inst { js_installation inst { deps = b.deps deps_helper; } }\n" +
  "deps_bundle_type deps_bundle { deps = deps_lib; }\n";
const FILES = {
  ...STUB_TSC,
  /* Type-free "TypeScript": the stub tsc copies it to .js verbatim. */
  "base/index.ts": 'exports.base = "deps e2e base";\n',
  "helper/index.ts": 'exports.helper = "deps e2e helper";\n',
  "lib/index.ts": 'exports.lib = "deps e2e lib";\n',
  "app/index.ts": 'exports.app = "deps e2e app";\n',
  "app/index.test.ts": 'it("deps e2e", () => {});\n',
  "tool/main.ts": 'process.stdout.write("deps e2e tool\\n");\n',
  "viacat/index.ts": 'exports.viacat = "deps e2e viacat";\n',
};

function deps(...names: string[]): { stdout: string; stderr: string; status: number } {
  return runFabr({ "PROJECT.fabr": PROJECT, ...FILES }, ["-DJS_TARGET=es2020", "deps", ...names]);
}

describe("e2e: fabr deps", () => {
  it("prints a target's dependency tree without building the target", () => {
    const result = deps("deps_app");
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(
      /* A build reads `test_deps` for its loose files alone, so it resolves none
       * of the packages they name. Those are the test's (see the next case). */
      ["deps_app", "deps", "├── deps_lib<JS_TARGET=es2020>", "│   └── deps_base<JS_TARGET=es2020>", "└── deps_base<JS_TARGET=es2020>", ""].join("\n")
    );
    expect(result.stderr, "nothing is compiled, the packages it depends on included").to.not.contain("Compiling");
  });

  it("asks under the configuration a name requires", () => {
    const result = deps("deps_app<BUILD_OPERATION=test>");
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(
      [
        "deps_app<BUILD_OPERATION=test>",
        "deps",
        "├── deps_lib<JS_TARGET=es2020>",
        "│   └── deps_base<JS_TARGET=es2020>",
        "└── deps_base<JS_TARGET=es2020>",
        "test_deps",
        "└── deps_helper<JS_TARGET=es2020>",
        "",
      ].join("\n")
    );
    expect(result.stderr, "no test is run").to.not.contain("Testing deps_app");
    expect(result.stderr).to.not.contain("Compiling");
  });

  it("asks a target with no build rule under the operation it has", () => {
    const result = deps("deps_tool", "deps_base");
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(
      ["deps_tool", "deps", "└── deps_lib<JS_TARGET=es2020>", "    └── deps_base<JS_TARGET=es2020>", "", "deps_base", "No dependencies", ""].join("\n")
    );
  });

  it("shows a target a rule written in .fabr builds by the target's properties and the rule", () => {
    const result = deps("deps_bundle");
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(
      [
        "deps_bundle",
        "deps",
        "└── deps_lib<JS_TARGET=es2020>",
        "    └── deps_base<JS_TARGET=es2020>",
        "required by deps_bundle_type rule",
        "└── deps_helper<JS_TARGET=es2020>",
        "",
      ].join("\n")
    );
    expect(result.stderr).to.not.contain("Compiling");
  });

  it("reads through a catalog and a global, still building nothing", () => {
    const result = deps("deps_viacat", "DEPS_ALL");
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(
      [
        "deps_viacat",
        "deps",
        "└── deps_lib<JS_TARGET=es2020>",
        "    └── deps_base<JS_TARGET=es2020>",
        "",
        "DEPS_ALL",
        "├── deps_lib<JS_TARGET=es2020>",
        "│   └── deps_base<JS_TARGET=es2020>",
        "└── deps_helper<JS_TARGET=es2020>",
        "",
      ].join("\n")
    );
    expect(result.stderr).to.not.contain("Compiling");
  });

  it("marks the versions that conflict, without failing, where a build refuses them", () => {
    /* Each line names the configuration a target is built in, so the two
     * builds of deps_base read apart on the lines as in the note. */
    const project =
      PROJECT +
      "js_package deps_lib2 { srcs = helper:**; deps = deps_base<JS_TARGET=es2022>; }\n" +
      "js_package deps_conf { srcs = app:**; deps = deps_lib deps_lib2; }\n" +
      "DEPS_CONF = deps_lib deps_lib2;\n";
    const shown = runFabr({ "PROJECT.fabr": project, ...FILES }, ["-DJS_TARGET=es2020", "deps", "deps_conf"]);
    /* A name that is no target is one unnamed section, its conflicts marked the same. */
    const global = runFabr({ "PROJECT.fabr": project, ...FILES }, ["-DJS_TARGET=es2020", "deps", "DEPS_CONF"]);
    expect(global.status, global.stderr).to.equal(0);
    expect(global.stdout).to.contain("│   └── deps_base<JS_TARGET=es2020> (!)\n");
    expect(global.stdout).to.contain("(!) conflicting in DEPS_CONF:\n  deps_base: deps_base<JS_TARGET=es2020>, deps_base<JS_TARGET=es2022>\n");
    expect(shown.status, shown.stderr).to.equal(0);
    expect(shown.stdout).to.equal(
      [
        "deps_conf",
        "deps",
        "├── deps_lib<JS_TARGET=es2020>",
        "│   └── deps_base<JS_TARGET=es2020> (!)",
        "└── deps_lib2<JS_TARGET=es2020>",
        "    └── deps_base<JS_TARGET=es2022> (!)",
        "",
        "(!) conflicting in deps_conf:",
        "  deps_base: deps_base<JS_TARGET=es2020>, deps_base<JS_TARGET=es2022>",
        "",
        "(!) - conflicting versions: refused where the target is built",
        "",
      ].join("\n")
    );
    const built = runFabr({ "PROJECT.fabr": project, ...FILES }, ["-DJS_TARGET=es2020", "build", "deps_conf"]);
    expect(built.status).to.not.equal(0);
    expect(built.stderr).to.contain("deps_base is required as 'deps_base<JS_TARGET=es2020>' and as 'deps_base<JS_TARGET=es2022>'");
  });

  it("builds through a catalog what it resolved as stated", () => {
    /* The catalog resolves `deps_lib` as its rule states it, and the consumer
     * is given its build. The two must be one package, requirements included. */
    const result = runFabr({ "PROJECT.fabr": PROJECT, ...FILES }, ["-DJS_TARGET=es2020", "build", "deps_viacat"]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.contain("Compiling deps_lib");
  });

  it("reports a package that fails to build through a catalog as that package's failure", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          PROJECT + "js_package deps_bad { srcs = bad:**; }\ncatalog @deps_badcat { deps = deps_bad; }\njs_package deps_usesbad { srcs = app:**; deps = @deps_badcat:deps_bad; }\n",
        ...FILES,
        "bad/index.ts": 'exports.bad = "deps e2e bad";\n',
        "bad/package.json": "{ not json",
      },
      ["-DJS_TARGET=es2020", "build", "deps_usesbad"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("package.json");
    expect(result.stderr).to.contain("deps_bad");
    expect(result.stderr).to.contain("required by deps_usesbad");
  });

  it("names every package between a dependency that fails to build and the one asked for", () => {
    /* The package asked for holds the whole graph and builds each package in
     * it, so the failure reaches it both along the chain and straight from the
     * package that failed. One route is reported, and it is the whole chain. */
    const result = runFabr(
      {
        "PROJECT.fabr":
          PROJECT +
          "js_package deps_bad { srcs = bad:**; }\n" +
          "js_package deps_one { srcs = lib:**; deps = deps_bad; }\n" +
          "js_package deps_two { srcs = helper:**; deps = deps_one; }\n" +
          "js_package deps_three { srcs = app:**; deps = deps_two; }\n",
        ...FILES,
        "bad/index.ts": 'exports.bad = "deps e2e bad";\n',
        "bad/package.json": "{ not json",
      },
      ["-DJS_TARGET=es2020", "build", "deps_three"]
    );
    expect(result.status).to.not.equal(0);
    const hops = [...result.stderr.matchAll(/required by (\S+(?: \S+)?)$/gm)].map(match => match[1]);
    expect(hops).to.deep.equal(["deps_one deps", "deps_two deps", "deps_three deps"]);
  });

  it("refuses a projection, which names files rather than a target", () => {
    const result = deps("deps_app:index.js");
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("'deps_app:index.js' selects files of 'deps_app'");
  });
});
