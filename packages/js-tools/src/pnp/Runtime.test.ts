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

/* The runtime in real node processes, over a table staged as fabr stages one:
 * the install's table naming trees through the pool's link beside it, one
 * package at a virtual location. Run from the compiled runtime, beside this
 * test where it runs compiled or in the package's build where it runs from
 * its TypeScript source. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IPnpSerializedState } from "./PnPState";

const RUNTIME = [path.join(__dirname, "Runtime.js"), path.join(__dirname, "../../build/pnp/Runtime.js")].find(file =>
  fs.existsSync(file)
)!;

/** The virtual location the table gives `wired`, over its tree. */
const VIRTUAL = "../.fabr-tree/__virtual__/0123abcd/0/wired/";

const TABLE: IPnpSerializedState = {
  __info: [],
  dependencyTreeRoots: [],
  enableTopLevelFallback: true,
  ignorePatternData: null,
  fallbackExclusionList: [],
  fallbackPool: [],
  packageRegistryData: [
    [
      null,
      [
        [
          null,
          {
            packageLocation: "./",
            packageDependencies: [
              ["plain", "p"],
              ["wired", "w"],
            ],
            linkType: "SOFT",
          },
        ],
      ],
    ],
    ["plain", [["p", { packageLocation: "../.fabr-tree/plain/", packageDependencies: [["plain", "p"]], linkType: "HARD" }]]],
    [
      "wired",
      [
        [
          "w",
          {
            packageLocation: VIRTUAL,
            packageDependencies: [
              ["wired", "w"],
              ["plain", "p"],
            ],
            linkType: "HARD",
          },
        ],
      ],
    ],
  ],
};

describe("installPnpRuntime", () => {
  let root: string;
  let work: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pnp-runtime-")));
    work = path.join(root, "work");
    const pool = path.join(root, "pool");
    for (const [name, files] of Object.entries({
      plain: { "package.json": '{"name":"plain"}', "index.js": "module.exports = 'plain';\n" },
      wired: {
        "package.json": '{"name":"wired"}',
        "index.js": "module.exports = { plain: require('plain'), dir: __dirname, file: __filename };\n",
        "data.txt": "own data",
      },
    })) {
      fs.mkdirSync(path.join(pool, name), { recursive: true });
      for (const [file, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(pool, name, file), text);
      }
    }
    fs.mkdirSync(work);
    fs.symlinkSync(pool, path.join(root, ".fabr-tree"), "dir");
    fs.writeFileSync(path.join(work, ".pnp.data.json"), JSON.stringify(TABLE));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Run `main` (CommonJS, or an ES module with `esm`) in `work` with the
   * runtime installed, and parse what it writes. */
  function run(main: string, esm = false): Record<string, unknown> {
    const name = esm ? "main.mjs" : "main.js";
    fs.writeFileSync(path.join(work, name), main);
    const preload = `require(${JSON.stringify(RUNTIME)}).installPnpRuntime(${JSON.stringify(path.join(work, ".pnp.data.json"))});`;
    fs.writeFileSync(path.join(work, "preload.cjs"), preload);
    const result = spawnSync(process.execPath, ["--require", "./preload.cjs", name], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  it("installs once per table, however often it is asked", () => {
    const out = run(
      "const { Module } = require('module');\n" +
        "const before = Module._resolveFilename;\n" +
        `require(${JSON.stringify(RUNTIME)}).installPnpRuntime(${JSON.stringify(path.join(work, ".pnp.data.json"))});\n` +
        "process.stdout.write(JSON.stringify({ same: Module._resolveFilename === before, plain: require('plain') }));"
    );
    assert.deepEqual(out, { same: true, plain: "plain" });
  });

  it("installs from a preload beside the table, for the node processes the process starts too", () => {
    fs.writeFileSync(path.join(work, ".fabr-pnp.cjs"), `require(${JSON.stringify(RUNTIME)}).installFromPreload(__filename);\n`);
    fs.writeFileSync(path.join(work, "child.js"), "process.stdout.write(require('plain'));\n");
    fs.writeFileSync(
      path.join(work, "main.js"),
      "const { execFileSync } = require('child_process');\n" +
        "process.stdout.write(JSON.stringify({ child: execFileSync(process.execPath, [require('path').join(__dirname, 'child.js')]).toString() }));"
    );
    const result = spawnSync(process.execPath, ["--require", "./.fabr-pnp.cjs", "main.js"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { child: "plain" });
  });

  it("answers through the table installed most recently, and passes only its preload on", () => {
    /* Table B declares `plain` nowhere; A, whose preload B's process
     * inherits, gives it to `wired`. B's program must not resolve what only A
     * declares. */
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    const wiredAlone: IPnpSerializedState = {
      ...TABLE,
      packageRegistryData: TABLE.packageRegistryData.map(([name, rows]) =>
        name === "wired"
          ? [name, rows.map(([reference, info]) => [reference, { ...info, packageDependencies: [["wired", "w"]] }])]
          : name === null
            ? [name, rows.map(([reference, info]) => [reference, { ...info, packageDependencies: [["wired", "w"]] }])]
            : [name, rows]
      ) as IPnpSerializedState["packageRegistryData"],
    };
    fs.writeFileSync(path.join(other, ".pnp.data.json"), JSON.stringify(wiredAlone));
    for (const dir of [work, other]) {
      fs.writeFileSync(path.join(dir, ".fabr-pnp.cjs"), `require(${JSON.stringify(RUNTIME)}).installFromPreload(__filename);\n`);
    }
    fs.writeFileSync(
      path.join(other, "main.js"),
      "let wired;\ntry { wired = require('wired').plain; } catch (err) { wired = err.message; }\n" +
        "process.stdout.write(JSON.stringify({ wired, options: process.env.NODE_OPTIONS }));"
    );
    const inherited = `--require ${JSON.stringify(path.join(work, ".fabr-pnp.cjs"))}`;
    const result = spawnSync(process.execPath, ["--require", "./.fabr-pnp.cjs", "main.js"], {
      cwd: other,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: inherited },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout) as { wired: string; options: string };
    assert.match(out.wired, /wired tried to access plain/);
    assert.equal(out.options, `--require ${JSON.stringify(path.join(other, ".fabr-pnp.cjs"))}`);
  });

  it("answers require and require.resolve through the table", () => {
    const out = run(
      "process.stdout.write(JSON.stringify({ plain: require('plain'), resolved: require.resolve('plain'), wired: require('wired').plain }));"
    );
    assert.equal(out.plain, "plain");
    assert.equal(out.resolved, path.join(root, "pool", "plain", "index.js"));
    assert.equal(out.wired, "plain");
  });

  it("lets a package at a virtual location read its own files through fs, and keeps its realpath virtual", () => {
    const out = run(
      "const fs = require('fs'), path = require('path');\n" +
        "const { dir, file } = require('wired');\n" +
        "(async () => process.stdout.write(JSON.stringify({\n" +
        "  dir,\n" +
        "  sync: fs.readFileSync(path.join(dir, 'data.txt'), 'utf8'),\n" +
        "  promised: await fs.promises.readFile(path.join(dir, 'data.txt'), 'utf8'),\n" +
        "  callback: await new Promise(done => fs.readFile(path.join(dir, 'data.txt'), 'utf8', (e, t) => done(e ? e.message : t))),\n" +
        "  exists: fs.existsSync(path.join(dir, 'data.txt')),\n" +
        "  missing: fs.existsSync(path.join(dir, 'missing.txt')),\n" +
        "  listed: fs.readdirSync(dir).sort(),\n" +
        "  real: fs.realpathSync(file),\n" +
        "  realNative: fs.realpathSync.native(file),\n" +
        "  realPromised: await fs.promises.realpath(file),\n" +
        "})))();\n"
    );
    const virtual = path.join(work, VIRTUAL);
    assert.equal(out.dir, virtual.replace(/[\\/]$/, ""));
    assert.equal(out.sync, "own data");
    assert.equal(out.promised, "own data");
    assert.equal(out.callback, "own data");
    assert.equal(out.exists, true);
    assert.equal(out.missing, false);
    assert.deepEqual(out.listed, ["data.txt", "index.js", "package.json"]);
    /* The part before the virtual segment is resolved; the rest kept. */
    const realVirtual = path.join(root, "pool", "__virtual__", "0123abcd", "0", "wired", "index.js");
    assert.equal(out.real, realVirtual);
    assert.equal(out.realNative, realVirtual);
    assert.equal(out.realPromised, realVirtual);
  });

  it("gives an ES module's named fs imports the patched functions", () => {
    const out = run(
      "import { readFileSync } from 'node:fs';\n" +
        "import { createRequire } from 'node:module';\n" +
        "const { dir } = createRequire(import.meta.url)('wired');\n" +
        "process.stdout.write(JSON.stringify({ text: readFileSync(dir + '/data.txt', 'utf8') }));\n",
      true
    );
    assert.equal(out.text, "own data");
  });

  it("answers pnpapi with the table's resolver, from require and import, and sets process.versions.pnp", () => {
    const out = run(
      "const api = require('pnpapi');\n" +
        "import('pnpapi').then(imported => process.stdout.write(JSON.stringify({\n" +
        "  pnp: process.versions.pnp,\n" +
        "  resolved: api.resolveRequest('plain', __filename),\n" +
        "  same: imported.default === api,\n" +
        "})));\n"
    );
    assert.equal(out.pnp, "3");
    assert.equal(out.resolved, path.join(work, "../.fabr-tree/plain/index.js"));
    assert.equal(out.same, true);
  });
});
