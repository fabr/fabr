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

/* `JS_TARGET=<level>-dual` ships both module formats of a package in one tree: the
 * CommonJS format keeps `.js`/`.d.ts` (so `type`, `main` and `types` describe it
 * without qualification) and the ES-module format is emitted as `.mjs`/`.d.mts`
 * beside it, the two told apart by the generated `exports` map's conditions. */
describe("e2e: dual js_package", () => {
  const base = {
    ...STUB_TSC,
    "src/index.ts": "export const x = 1;\n",
    "src/server.ts": "export const y = 2;\n",
    "src/bin/tool.ts": "console.log('tool');\n",
    "styles.css": ".a { color: red; }\n",
  };
  const projectWith = (properties: string): Record<string, string> => ({
    ...base,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + `\njs_package thing { srcs = src:**/*.ts; ${properties} }\n`,
  });

  const dual = (properties: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } =>
    runFabr(projectWith(properties), ["-DJS_TARGET=es2020-dual", ...args]);

  it("ships both formats in one tree, assets once", () => {
    const listed = dual("resources = styles.css; exports = src:index.ts src:server.ts;", "ls", "thing");
    expect(listed.status).to.equal(0);
    const files = listed.stdout.split("\n").filter(Boolean);
    for (const both of ["index.js", "index.d.ts", "index.mjs", "index.d.mts", "server.js", "server.mjs"]) {
      expect(files, both).to.contain(both);
    }
    /* The whole point of the flat layout: a non-JS asset ships ONCE and both
     * formats name it identically, where a subdirectory fork would have left the
     * ES-module format's relative reference resolving outside its own tree.
     * Matched by suffix, not equality — a second copy would be at a DIFFERENT
     * path (`esm/styles.css`), which is exactly what an equality test misses,
     * and a same-path duplicate could never appear in a name-keyed FileSet. */
    expect(files.filter(name => name.endsWith("styles.css"))).to.have.length(1);
  });

  it("publishes the two formats as nested export conditions", () => {
    const result = dual("exports = src:index.ts src:server.ts;", "cat", "thing:package.json");
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg.exports["."]).to.deep.equal({
      import: { types: "./index.d.mts", default: "./index.mjs" },
      require: { types: "./index.d.ts", default: "./index.js" },
    });
    /* The legacy surface stays the CommonJS format, whole and unqualified — which
     * is what a consumer that cannot read the map falls back to. */
    expect(pkg.type).to.equal("commonjs");
    expect(pkg.main).to.equal("index.js");
    expect(pkg.types).to.equal("index.d.ts");
  });

  it("gives a bin one format only", () => {
    /* A bin is the package as a PROGRAM — launched by node, never imported — so
     * there is no condition to select on and no second copy to ship. */
    const result = dual("exports = src:index.ts;", "cat", "thing:package.json");
    expect(result.status).to.equal(0);
    expect(JSON.parse(result.stdout).bin).to.deep.equal({ tool: "bin/tool.js" });
    const files = dual("exports = src:index.ts;", "ls", "thing").stdout.split("\n");
    expect(files).to.contain("bin/tool.js");
    expect(files).to.not.contain("bin/tool.mjs");
  });

  it("publishes an exhaustive map when nothing is declared", () => {
    /* Dual is set through JS_TARGET, normally project-wide, so flipping it must
     * not demand an `exports` declaration in every package first. The map is
     * generated exhaustively instead — everything that resolved before still
     * resolves, now with a format attached. */
    const result = dual("resources = styles.css;", "cat", "thing:package.json");
    expect(result.status, result.stderr).to.equal(0);
    const exports = JSON.parse(result.stdout).exports;
    expect(exports["."]).to.deep.equal({
      import: { types: "./index.d.mts", default: "./index.mjs" },
      require: { types: "./index.d.ts", default: "./index.js" },
    });
    /* One wildcard per subpath shape a consumer writes: extensionless as
     * CommonJS resolution finds it, `.js` as an ES-module consumer must, `.mjs`
     * for the file's own name. `server.ts` needs no key of its own — the
     * wildcards answer all three for it. */
    const patternFormats = {
      import: { types: "./*.d.mts", default: "./*.mjs" },
      require: { types: "./*.d.ts", default: "./*.js" },
    };
    expect(exports["./*"]).to.deep.equal(patternFormats);
    expect(exports["./*.js"]).to.deep.equal(patternFormats);
    expect(exports["./*.mjs"]).to.deep.equal(patternFormats);
    expect(Object.keys(exports)).to.not.contain("./server");
    /* An undeclared package narrows nothing, assets included — and an asset
     * needs an explicit key, a wildcard being unable to answer it. */
    expect(exports["./styles.css"]).to.equal("./styles.css");
  });

  it("narrows to the declared entry points when there are any", () => {
    const result = dual("exports = src:index.ts;", "cat", "thing:package.json");
    expect(result.status).to.equal(0);
    expect(Object.keys(JSON.parse(result.stdout).exports)).to.deep.equal([".", "./package.json"]);
  });

  it("bundles under a dual ambient target", () => {
    /* A bundle is a single artifact, so `dual` reads as its sole format — for the
     * bundle's own compile of loose sources as much as for what it asks its
     * inputs for. Without that, an ambient `dual` reaches js_compile, which
     * cannot emit two module systems from one compile. */
    const stubBundler = `const fs = require("fs"), path = require("path");
const optsArg = process.argv.find(a => a.startsWith("--options="));
const opts = JSON.parse(fs.readFileSync(optsArg.slice("--options=".length), "utf8"));
for (const entry of opts.entries) {
  const out = path.join(opts.outdir, entry.out + ".js");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "// bundled\\n" + fs.readFileSync(entry.in, "utf8"));
}
`;
    const project = {
      ...STUB_TSC,
      "fake-bundler.js": stubBundler,
      "src/main.ts": "export const main = 1;\n",
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_script my_bundler { entry = ./fake-bundler.js; }\n" +
        "JS_BUNDLER = my_bundler;\n" +
        "js_bundle app { entry = src:main.ts; }\n",
    };
    const result = runFabr(project, ["-DJS_TARGET=es2020-dual", "cat", "app:main.js"]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.contain("// bundled");
  });

  it("leaves a single-format build exactly as it was", () => {
    const result = runFabr(projectWith("exports = src:index.ts;"), ["-DJS_TARGET=es2020", "ls", "thing"]);
    expect(result.status).to.equal(0);
    const files = result.stdout.split("\n");
    expect(files).to.contain("index.js");
    expect(files.filter(name => name.endsWith(".mjs"))).to.have.length(0);
  });
});
