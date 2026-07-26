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

  it("runs the JS_BUNDLER runnable over the staged options manifest", () => {
    const result = runFabr(project, ["cat", "app:main.js"]);
    expect(result.stderr).to.match(/Building app/);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal('// stub-bundled\nconsole.log("hello");\n');
  });
});
