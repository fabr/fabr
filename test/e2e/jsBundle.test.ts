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

/* `js_bundle` resolves its bundler through the `JS_BUNDLER` global as a
 * runnable (fabr's own esbuild driver by default, declared in JS.fabr), so
 * overriding the global swaps the whole driver — exercised here with a
 * project-declared stub that honors the options-manifest contract (read
 * bundle-options.json, write each entry's output under the outdir), keeping
 * the test offline (the real driver needs the npm-fetched esbuild). */
describe("e2e: js_bundle driver", () => {
  /* Reads the manifest the rule stages and emits each entry with a marker, so
   * the assertion proves the rule invoked the runnable over the staged tree. */
  const stubDriver = `const fs = require("fs"), path = require("path");
const optsArg = process.argv.find(a => a.startsWith("--options="));
const opts = JSON.parse(fs.readFileSync(optsArg.slice("--options=".length), "utf8"));
for (const entry of opts.entries) {
  const out = path.join(opts.outdir, entry.out + ".js");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "// stub-bundled\\n" + fs.readFileSync(entry.in, "utf8"));
}
`;

  /* All-JavaScript, so no tsc is configured (nor needed): the bundle compiles
   * only what requires it — TypeScript or JSX — and hands plain JS to the
   * bundler as written. */
  const project = {
    "PROJECT.fabr": [
      "plugin @fabr-build/js;",
      "js_script my_bundler { entry = ./fake-bundler.js; }",
      "JS_BUNDLER = my_bundler;",
      "js_bundle app { entry = ./main.js; }",
      "",
    ].join("\n"),
    "fake-bundler.js": stubDriver,
    "main.js": 'console.log("hello");\n',
  };

  /* A mixed tree DOES compile (TypeScript needs checking), and its plain
   * JavaScript goes in as a compile input so the `./util.js` import resolves —
   * but the compiler's copy of that file is dropped again and the ORIGINAL is
   * what reaches the bundler.
   *
   * This needs its own tsc stub rather than the shared one: the shared stub
   * copies verbatim, so the compiled and original `util.js` would be identical
   * and the assertion could not tell which survived. This one marks whatever it
   * emits, so the marker's ABSENCE is the evidence. */
  const markingTsc = `const fs = require("fs"), path = require("path");
const cfg = JSON.parse(fs.readFileSync("tsconfig.json", "utf8")).compilerOptions || {};
const rootDir = cfg.rootDir || "src", outDir = cfg.outDir || "build";
for (const name of fs.readdirSync(rootDir)) {
  const src = path.join(rootDir, name);
  const out = path.join(outDir, name.replace(/\\.tsx?$/, ".js"));
  fs.mkdirSync(outDir, { recursive: true });
  if (name.endsWith(".ts")) {
    fs.writeFileSync(out, fs.readFileSync(src, "utf8"));
    fs.writeFileSync(path.join(outDir, name.replace(/\\.ts$/, ".d.ts")), "export {};\\n");
  } else if (cfg.allowJs && /\\.jsx?$/.test(name)) {
    fs.writeFileSync(out, "COMPILED:" + fs.readFileSync(src, "utf8"));
  }
}
`;
  /* Emits the staged `util.js` as the bundle, so the test can inspect which
   * copy of it the rule staged. */
  const echoUtil = `const fs = require("fs"), path = require("path");
const opts = JSON.parse(fs.readFileSync(process.argv.find(a => a.startsWith("--options=")).slice(10), "utf8"));
for (const entry of opts.entries) {
  const out = path.join(opts.outdir, entry.out + ".js");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, fs.readFileSync("util.js", "utf8"));
}
`;

  it("stages the ORIGINAL JavaScript, not the compiler's copy, when a TS source imports it", () => {
    const mixed = {
      "PROJECT.fabr": [
        "plugin @fabr-build/js;",
        "js_script marking_tsc { entry = ./marking-tsc.js; }",
        "TSC = marking_tsc;",
        "js_script my_bundler { entry = ./echo-util.js; }",
        "JS_BUNDLER = my_bundler;",
        "js_bundle app { entry = ./main.ts; srcs = ./util.js; }",
        "",
      ].join("\n"),
      "marking-tsc.js": markingTsc,
      "echo-util.js": echoUtil,
      "main.ts": 'require("./util.js");\n',
      "util.js": 'console.log("util");\n',
    };
    const result = runFabr(mixed, ["cat", "app:main.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal('console.log("util");\n');
  });

  /* A projection over a PACKAGE is contained: the package mounts like any other
   * bundled input and the entry is located inside it, so its relative imports
   * resolve among its siblings and its self-references are ordinary bare
   * specifiers. The bundler is handed the mounted path, while the artifact keeps
   * the name the reference gave it. */
  const echoEntry = `const fs = require("fs"), path = require("path");
const opts = JSON.parse(fs.readFileSync(process.argv.find(a => a.startsWith("--options=")).slice(10), "utf8"));
for (const entry of opts.entries) {
  const out = path.join(opts.outdir, entry.out + ".js");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "ENTRY=" + entry.in + "\\n" + fs.readFileSync(entry.in, "utf8"));
}
`;

  it("locates a package entry inside its mount, keeping the projected name for the output", () => {
    const project = {
      ...STUB_TSC,
      "PROJECT.fabr": [
        "plugin @fabr-build/js;",
        STUB_TSC_CONFIG,
        "js_script my_bundler { entry = ./echo-entry.js; }",
        "JS_BUNDLER = my_bundler;",
        "js_package @scope/thing { version = 1.0.0; srcs = pkg/src:**; }",
        "js_bundle app { entry = @scope/thing:index.js; }",
        "",
      ].join("\n"),
      "echo-entry.js": echoEntry,
      "pkg/src/index.ts": 'const hello = "world";\n',
    };
    const result = runFabr(project, ["cat", "app:index.js"]);
    expect(result.status).to.equal(0);
    /* `in` is the path under the mount — not a copy restaged at the bundle root. */
    expect(result.stdout).to.contain("ENTRY=node_modules/@scope/thing/index.js");
    expect(result.stdout).to.contain('const hello = "world";');
  });

  it("fails on a literal package entry that names nothing, even alongside a good one", () => {
    /* The miss judgment belongs to the ref (which holds the written reference's
     * error), not to each locate caller: judged per-entry, a typo'd entry among
     * several used to be silently dropped and the bundle built without it. */
    const project = {
      ...STUB_TSC,
      "PROJECT.fabr": [
        "plugin @fabr-build/js;",
        STUB_TSC_CONFIG,
        "js_script my_bundler { entry = ./echo-entry.js; }",
        "JS_BUNDLER = my_bundler;",
        "js_package @scope/thing { version = 1.0.0; srcs = pkg/src:**; }",
        "js_bundle app { entry = @scope/thing:index.js @scope/thing:nope.js; }",
        "",
      ].join("\n"),
      "echo-entry.js": echoEntry,
      "pkg/src/index.ts": 'const hello = "world";\n',
    };
    const result = runFabr(project, ["cat", "app:index.js"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("Unable to resolve '@scope/thing:nope.js'");
  });

  it("runs the JS_BUNDLER runnable over the staged options manifest", () => {
    const result = runFabr(project, ["cat", "app:main.js"]);
    expect(result.stderr).to.match(/Building app/);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal('// stub-bundled\nconsole.log("hello");\n');
  });
});
