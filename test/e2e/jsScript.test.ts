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
import { HOST_NODE, runFabr, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/* A js_script defines a runnable; the generic `generate` target executes it and
 * collects output. These cases exercise that pair through the real CLI. */
describe("e2e: js_script (runnable) + generate", () => {
  it("runs a loose script and collects its output", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          "js_script gen_prog { entry = src:gen.js; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.js":
          'require("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/msg.txt", "e2e ran\\n");\n',
      },
      ["cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("e2e ran\n");
  });

  it("runs on the node NODE names, through the tree pool rather than found on PATH", () => {
    /* The harness points a js-plugin fixture's NODE at the node running this
     * suite; the program runs as that file, from its tree in the cache's pool. */
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          "js_script gen_prog { entry = src:gen.js; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.js":
          'require("fs").mkdirSync("out", { recursive: true });\n' +
          'require("fs").writeFileSync("out/node.txt", process.version + " " + process.execPath);\n',
      },
      ["cat", "gen:node.txt"]
    );
    expect(result.status, result.stderr).to.equal(0);
    const [version, execPath] = result.stdout.split(" ");
    expect(version).to.equal(process.version);
    expect(execPath, "reached through the tree pool's link").to.match(
      /[\\/](?:tree|\.fabr-tree)[\\/][0-9a-f]{64}[\\/]\.fabr-host-node$/
    );
  });

  it("runs on a program of the host NODE names, where it lies rather than through a link", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          `NODE = ${HOST_NODE};\n` +
          "js_script gen_prog { entry = src:gen.js; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.js":
          'require("fs").mkdirSync("out", { recursive: true });\n' +
          'require("fs").writeFileSync("out/node.txt", process.version + " " + process.execPath);\n',
      },
      ["cat", "gen:node.txt"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(`${process.version} ${process.execPath}`);
  });

  it("appends the run target's args to the runnable", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          "js_script gen_prog { entry = src:gen.js; }\n" +
          "generate gen { run = gen_prog Ada Lovelace; output = out:**; }\n",
        "src/gen.js":
          'require("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/msg.txt", process.argv.slice(2).join(" "));\n',
      },
      ["cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("Ada Lovelace");
  });

  it("launches the program with the target's env", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" + 'js_script greet { entry = src:greet.js; env = { GREETING = "hello there"; } }\n',
        "src/greet.js": "process.stdout.write(process.env.GREETING);\n",
      },
      ["run", "greet"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello there");
  });

  it("launches the program with its env as a generate command, the generate target's env set over it", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          "js_script greet { entry = src:greet.js; env = { GREETING = hello; WHO = script; } }\n" +
          "generate gen { run = greet > out.txt; env = { WHO = target; } }\n",
        "src/greet.js": "process.stdout.write(`${process.env.GREETING} ${process.env.WHO}`);\n",
      },
      ["cat", "gen:out.txt"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal("hello target");
  });

  it("runs a built package as the entry via its declared bin (relative imports resolve)", () => {
    /* Package-mode entry: the package joins the install and its (generated,
     * by-convention) package.json bin is the entry — launched from its
     * node_modules mount, so its relative imports resolve. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package greeter { srcs = pkgsrc:**; }\n\n" +
          "js_script greeter_prog { entry = greeter; }\n" +
          "generate greet { run = greeter_prog; output = out:**; }\n",
        /* type-free "TypeScript": the stub tsc copies these to .js verbatim */
        "pkgsrc/bin/cli.ts":
          'const { greet } = require("../util");\nrequire("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/greeting.txt", greet("Ada"));\n',
        "pkgsrc/util.ts": 'exports.greet = (name) => "hello, " + name + "!";\n',
      },
      ["-DJS_TARGET=es2020", "cat", "greet:greeting.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello, Ada!");
  });

  it("selects a built package's bin by projection on the entry (local, multi-bin)", () => {
    /* A projection on a package entry means the RUNNABLE's entry (the written
     * form's `fabr run` meaning) — here selecting one of two by-convention
     * bins of a locally built package. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package multi { srcs = pkgsrc:**; }\n\n" +
          "js_script one_prog { entry = multi:one; }\n" +
          "generate one { run = one_prog; output = out:**; }\n",
        "pkgsrc/bin/one.ts":
          'require("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/which.txt", "ran one");\n',
        "pkgsrc/bin/two.ts":
          'require("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/which.txt", "ran two");\n',
      },
      ["-DJS_TARGET=es2020", "cat", "one:which.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("ran one");
  });

  it("compiles a TypeScript entry file and runs it (commonjs)", () => {
    /* File-mode with a `.ts` entry: it is compiled through js_compile (here the
     * stub tsc, copying .ts→.js) and its emitted `.js` is launched. es2020 is
     * commonjs, so the install's package.json type lets `require` work. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_script gen_prog { entry = src:gen.ts; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.ts":
          'require("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/msg.txt", "ts ran\\n");\n',
      },
      ["-DJS_TARGET=es2020", "cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("ts ran\n");
  });

  it("runs an ESM TypeScript entry under node (module type honored)", () => {
    /* The default target (es6-esm) makes the install ESM; the staged
     * package.json `type: module` is what lets node run the emitted `.js` with
     * `import` rather than treating it as CommonJS. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_script gen_prog { entry = src:gen.ts; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.ts":
          'import { mkdirSync, writeFileSync } from "fs";\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/msg.txt", "esm ran\\n");\n',
      },
      ["cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("esm ran\n");
  });

  it("compiles source deps alongside a TypeScript entry", () => {
    /* A source (non-package) dep is a compile input: it is compiled with the
     * entry and importable as a sibling in the install. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_script gen_prog { entry = src:gen.ts; deps = src:util.ts; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.ts":
          'const { greet } = require("./util");\nrequire("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/msg.txt", greet("Ada"));\n',
        "src/util.ts": 'exports.greet = (name) => "hello, " + name + "!";\n',
      },
      ["-DJS_TARGET=es2020", "cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello, Ada!");
  });

  it("compiles TypeScript deps of a JavaScript entry", () => {
    /* The entry and its JavaScript dep are installed as written; the
     * TypeScript dep the JavaScript requires is compiled beside them. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_script gen_prog { entry = tools/gen.js; deps = Lib.js src/Names.ts; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "tools/gen.js":
          'const { greet } = require("../Lib");\nrequire("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/msg.txt", greet());\n',
        "Lib.js": 'const { NAME } = require("./src/Names");\nexports.greet = () => "hello, " + NAME + "!";\n',
        "src/Names.ts": 'exports.NAME = "Ada";\n',
      },
      ["-DJS_TARGET=es2020", "cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello, Ada!");
  });

  it("ships a non-compilable resource dep alongside a TypeScript entry", () => {
    /* A runtime data file in `deps` (a .json tsc reads but never emits) is
     * carried into the TS-entry install at the package root, next to the compiled
     * entry, so a relative require resolves. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_script gen_prog { entry = src:gen.ts; deps = data:config.json; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.ts":
          'const cfg = require("./config.json");\nrequire("fs").mkdirSync("out", { recursive: true });\nrequire("fs").writeFileSync("out/msg.txt", cfg.greeting);\n',
        "data/config.json": '{ "greeting": "hello from json" }\n',
      },
      ["-DJS_TARGET=es2020", "cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello from json");
  });

  it("fails with a clear error when entry names no file", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          "js_script gen_prog { deps = src:gen.js; entry = src:missing.js; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.js": "// present, but not the entry\n",
      },
      ["build", "gen"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("Unable to resolve 'src:missing.js'");
  });
});

describe("e2e: js_package bin convention", () => {
  it("announces bin/ executables in the generated package.json (skipping .d.ts)", () => {
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package tool { srcs = src:**; }\n",
        "src/bin/mytool.ts": 'console.log("hi");\n',
        "src/index.ts": "exports.x = 1;\n",
      },
      ["-DJS_TARGET=es2020", "cat", "tool:package.json"]
    );
    expect(result.status).to.equal(0);
    expect(JSON.parse(result.stdout).bin).to.deep.equal({ mytool: "bin/mytool.js" });
  });
});

describe("e2e: fabr run a package's bin", () => {
  it("runs a js_package via its single declared bin", () => {
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package tool { srcs = src:**; }\n",
        "src/bin/mytool.ts": 'process.stdout.write("tool:" + process.argv.slice(2).join(","));\n',
      },
      ["-DJS_TARGET=es2020", "run", "tool", "a", "b"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("tool:a,b");
  });

  it("errors clearly when a package declares no bin", () => {
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package lib { srcs = src:**; }\n",
        "src/index.ts": "exports.x = 1;\n",
      },
      ["-DJS_TARGET=es2020", "run", "lib"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("not runnable");
  });
});

describe("e2e: fabr run — selecting an entry (multi-bin)", () => {
  const project = {
    ...STUB_TSC,
    "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package multi { srcs = src:**; }\n",
    "src/bin/one.ts": 'process.stdout.write("ran one");\n',
    "src/bin/two.ts": 'process.stdout.write("ran two");\n',
  };

  it("selects a bin by its command name (package.json bin as a symlink)", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi:one"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("ran one");
  });

  it("selects an entry by its file path within the package", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi:bin/two.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("ran two");
  });

  it("errors, naming the choices, when several bins and none selected", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("'multi' has 2 candidate entries");
    expect(result.stderr).to.contain("one");
    expect(result.stderr).to.contain("two");
  });

  it("selects via a glob that matches a single file", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi:bin/o*.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("ran one");
  });

  it("defers a glob matching several files to launch, listing them", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi:bin/*.js"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("2 candidate entries");
    expect(result.stderr).to.contain("one.js");
    expect(result.stderr).to.contain("two.js");
  });

  it("reports a missing entry through the shared name-resolution path", () => {
    /* A literal selecting nothing is an unresolvable reference wherever it is
     * written — the same report as `cat pkg:missing`, not a runnable-specific
     * error. A glob is lenient, as everywhere, and reports as an empty result. */
    const literal = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi:nope"]);
    expect(literal.status).to.not.equal(0);
    expect(literal.stderr).to.contain("Unable to resolve 'multi:nope'");
    const glob = runFabr(project, ["-DJS_TARGET=es2020", "run", "multi:bin/*.mjs"]);
    expect(glob.status).to.not.equal(0);
    expect(glob.stderr).to.contain("matched no files");
  });
});

describe("e2e: fabr run", () => {
  const project = {
    "PROJECT.fabr": "plugin @fabr-build/js;\n\njs_script hello { entry = src:hello.js; }\n",
    "src/hello.js":
      'process.stdout.write("hi " + process.argv.slice(2).join(" "));\nprocess.exit(process.argv.includes("--fail") ? 7 : 0);\n',
  };

  it("runs a runnable, passing args through to stdout", () => {
    const result = runFabr(project, ["run", "hello", "Ada", "Lovelace"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hi Ada Lovelace");
  });

  it("propagates the program's exit code (and passes flags through)", () => {
    const result = runFabr(project, ["run", "hello", "--fail"]);
    expect(result.status).to.equal(7);
    expect(result.stdout).to.equal("hi --fail");
  });
});

describe("e2e: js_script under layout/pnp", () => {
  /* A program reading its packages through the table: what it resolved, and
   * what it can see of a node_modules tree, written to stdout. */
  const PROGRAM =
    'const fs = require("fs"), path = require("path");\n' +
    "const report = {\n" +
    '  greeting: require("lib").greeting,\n' +
    '  resolved: require.resolve("lib"),\n' +
    '  tree: fs.existsSync(path.join(__dirname, "node_modules")),\n' +
    "  pnp: process.versions.pnp,\n" +
    '  api: typeof require("pnpapi").resolveRequest,\n' +
    "};\n" +
    "process.stdout.write(JSON.stringify(report));\n";

  const project = (program: string, extra: Record<string, string> = {}): Record<string, string> => ({
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
      "js_script prog { entry = src:prog.js; deps = lib layout/pnp; }\n" +
      (extra["PROJECT.fabr"] ?? ""),
    "libsrc/index.ts": 'exports.greeting = "hello";\n',
    "src/prog.js": program,
    ...Object.fromEntries(Object.entries(extra).filter(([name]) => name !== "PROJECT.fabr")),
  });

  it("resolves the program's packages through a PnP table, with no node_modules tree", () => {
    const result = runFabr(project(PROGRAM), ["-DJS_TARGET=es2020", "run", "prog"]);
    expect(result.status, result.stderr).to.equal(0);
    const report = JSON.parse(result.stdout);
    expect(report.greeting).to.equal("hello");
    expect(report.resolved, "a tree in the pool").to.match(/[\\/](?:tree|\.fabr-tree)[\\/][0-9a-f]{64}[\\/]index\.js$/);
    expect(report.tree).to.equal(false);
    expect(report.pnp).to.equal("3");
    expect(report.api).to.equal("function");
  });

  it("resolves the packages of a node process the program starts through the same table", () => {
    const parent =
      'const { execFileSync } = require("child_process");\n' +
      'process.stdout.write(execFileSync(process.execPath, [require("path").join(__dirname, "child.js")]));\n';
    const result = runFabr(
      project(parent, {
        "PROJECT.fabr": "js_script parent { entry = src:prog.js; deps = lib layout/pnp src:child.js; }\n",
        "src/child.js": 'process.stdout.write(require("lib").greeting);\n',
      }),
      ["-DJS_TARGET=es2020", "run", "parent"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal("hello");
  });

  it("runs a package entry from its tree in the pool, its dependencies resolved through the table", () => {
    const result = runFabr(
      project("", {
        "PROJECT.fabr":
          "js_package greeter { srcs = greetersrc:**/*.ts; deps = lib; }\n" +
          "js_script greeter_prog { entry = greeter; deps = layout/pnp; }\n" +
          "generate greet { run = greeter_prog; output = out:**; }\n",
        "greetersrc/bin/cli.ts":
          'const fs = require("fs");\nfs.mkdirSync("out", { recursive: true });\n' +
          'fs.writeFileSync("out/greeting.txt", require("lib").greeting + " from " + (/[\\\\/](tree|\\.fabr-tree)[\\\\/][0-9a-f]{64}[\\\\/]bin$/.test(__dirname) ? "the pool" : __dirname));\n',
      }),
      ["-DJS_TARGET=es2020", "cat", "greet:greeting.txt"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal("hello from the pool");
  });

  it("runs as a serve target's tool, at its install's root", () => {
    const result = runFabr(
      project('process.stdout.write(require("lib").greeting + " " + require("fs").readFileSync("page.txt", "utf8"));\n', {
        "PROJECT.fabr": "serve site { tool = prog; files = content:**; }\n",
        "content/page.txt": "page",
      }),
      ["-DJS_TARGET=es2020", "run", "site"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal("hello page");
  });

  it("lays out packages holding native addons side by side under node_modules, where one requires the other", () => {
    /* Where the addon package lies, and what lies beside it there. */
    const program =
      'const fs = require("fs"), path = require("path");\n' +
      'const root = require("addon").root;\n' +
      "process.stdout.write(JSON.stringify({\n" +
      "  root,\n" +
      '  addon: fs.existsSync(path.join(root, "lib", "addon.node")),\n' +
      '  sibling: fs.existsSync(path.join(root, "..", "vips", "lib", "libvips.txt")),\n' +
      '  lib: require.resolve("lib"),\n' +
      "}));\n";
    const result = runFabr(
      project(program, {
        "PROJECT.fabr":
          "js_package vips { srcs = vipssrc:**/*.ts; resources = vipsres:**; }\n" +
          "js_package addon { srcs = addonsrc:**/*.ts; resources = addonres:**; deps = vips; }\n" +
          "js_script native { entry = src:prog.js; deps = addon lib layout/pnp; }\n",
        "vipssrc/index.ts": "exports.vips = true;\n",
        "vipsres/lib/libvips.txt": "vips",
        "vipsres/lib/libvips.node": "not really an addon either",
        "addonsrc/index.ts":
          'const fs = require("fs"), path = require("path");\n' +
          'let root = __dirname;\nwhile (!fs.existsSync(path.join(root, "package.json"))) root = path.dirname(root);\n' +
          "exports.root = root;\n",
        "addonres/lib/addon.node": "not really an addon",
      }),
      ["-DJS_TARGET=es2020", "run", "native"]
    );
    expect(result.status, result.stderr).to.equal(0);
    const report = JSON.parse(result.stdout);
    expect(report.root).to.match(/[\\/][0-9a-f]{64}[\\/]node_modules[\\/]addon$/);
    expect(report.addon).to.equal(true);
    expect(report.sibling).to.equal(true);
    expect(report.lib, "a package with no addon stays a tree of its own").to.match(/[\\/][0-9a-f]{64}[\\/]index\.js$/);
  });

  it("refuses to run staged inside another install, as a pipeline's stage is", () => {
    const result = runFabr(
      project('process.stdout.write("ran");\n', {
        "PROJECT.fabr": "generate piped { run = prog | prog; output = out:**; }\n",
      }),
      ["-DJS_TARGET=es2020", "build", "piped"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("A layout/pnp program runs only as a program of its own");
  });
});
