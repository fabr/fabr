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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { coreVersionError, hostCoreResolver, implementationLoader, resolvePackageFrom, toPluginLibs } from "./Plugin";
import { INameValue, syntheticValue } from "./AST";
import { parseName } from "./Parser";
import { EMPTY_FILESET } from "../core/FileSet";
import { StringReader } from "../support/StringReader";
import { Computable } from "../core/Computable";

/* A name of no significance to either test runner's module resolution — jest
 * maps `@fabr-build/core` itself by name, so the resolution rules are exercised
 * through a package it doesn't intercept. */
const SHARED = "@test/shared";

/** Write a resolvable package under `root`, and @return its directory. */
function writePackage(root: string, name: string): string {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};");
  return dir;
}

describe("plugin package resolution", () => {
  let dir: string;

  beforeEach(() => {
    /* Realpath up front: on darwin os.tmpdir() is itself symlinked, and every
     * resolution below is compared as a realpath. */
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-plugin-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a copy hoisted above the consumer", () => {
    const consumer = writePackage(dir, "@test/plugin");
    const shared = writePackage(dir, SHARED);
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(path.join(shared, "index.js"));
  });

  it("finds a consumer's own nested copy in preference to a hoisted one", () => {
    const consumer = writePackage(dir, "@test/plugin");
    writePackage(dir, SHARED);
    const nested = writePackage(consumer, SHARED);
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(path.join(nested, "index.js"));
  });

  it("reads a symlinked copy as the one package it points at", () => {
    const consumer = writePackage(dir, "@test/plugin");
    const real = writePackage(path.join(dir, "elsewhere"), SHARED);
    const link = path.join(dir, "node_modules", ...SHARED.split("/"));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, "dir");
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(path.join(real, "index.js"));
  });

  it("resolves nothing when there is no copy to find", () => {
    const consumer = writePackage(dir, "@test/plugin");
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(undefined);
  });
});

describe("the host's core, for plugins", () => {
  const HOST = "/host/node_modules/@fabr-build/core/index.js";

  it("answers a request for core with the host's copy, and passes every other on", () => {
    const asked: string[] = [];
    const resolve = hostCoreResolver(HOST);
    const next = (specifier: string): { url: string } => {
      asked.push(specifier);
      return { url: `file:///elsewhere/${specifier}` };
    };
    const context = { conditions: [], importAttributes: {}, parentURL: undefined };
    expect(resolve("@fabr-build/core", context, next)).to.deep.equal({ url: "file://" + HOST, format: "commonjs", shortCircuit: true });
    expect(resolve("sax", context, next)).to.deep.equal({ url: "file:///elsewhere/sax" });
    expect(asked).to.deep.equal(["sax"]);
  });

  it("refuses a plugin whose declared range for core excludes the host's version", () => {
    const err = coreVersionError("@test/plugin", "0.3.1", "0.4.0");
    expect(err?.message).to.equal("Plugin '@test/plugin' requires @fabr-build/core 0.3.1, but this fabr's is 0.4.0");
    expect(coreVersionError("@test/plugin", "^0.3.0", "0.3.4")).to.equal(undefined);
  });

  it("accepts a plugin or host that states no version", () => {
    expect(coreVersionError("@test/plugin", undefined, "0.4.0")).to.equal(undefined);
    expect(coreVersionError("@test/plugin", "0.3.1", undefined)).to.equal(undefined);
  });
});

describe("implementations a declaration names", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-implementation-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a package `name` exporting `rules/*` from `lib/`, and @return its manifest. */
  function writeExporting(name: string): string {
    const root = path.join(dir, "node_modules", ...name.split("/"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    const manifest = path.join(root, "package.json");
    fs.writeFileSync(manifest, JSON.stringify({ name, exports: { "./rules/*": "./lib/*.js" } }));
    fs.writeFileSync(path.join(root, "lib", "Thing.js"), "exports.default = { from: __filename };");
    fs.writeFileSync(path.join(root, "lib", "Bare.js"), "exports.other = 1;");
    return manifest;
  }

  const reference = (written: string): INameValue => syntheticValue(parseName(written), { fs: EMPTY_FILESET, file: "TEST.fabr", reader: new StringReader(written) }, 0, written.length);

  /** @return a package's `package.json` as a plugin's that is in hand. */
  const inHand = (manifest: string) => (): Computable<string> => Computable.resolve(manifest);

  it("loads an entry through the package's own exports, under the name the project uses for it", async () => {
    const manifest = writeExporting("@test/plugin");
    const load = implementationLoader(new Map([["@test/alias", inHand(manifest)]]));
    expect(await load(reference("@test/alias:rules/Thing"))).to.deep.equal({ from: path.join(path.dirname(manifest), "lib", "Thing.js") });
  });

  it("refuses a package the project does not use, and an entry with no default export", async () => {
    const load = implementationLoader(new Map([["@test/plugin", inHand(writeExporting("@test/plugin"))]]));
    const failure = (written: string): Computable<string> =>
      load(reference(written)).then(
        () => "loaded",
        (err: Error) => err.message
      );
    expect(await failure("@test/other:rules/Thing")).to.match(/'@test\/other' is neither @fabr-build\/core nor a plugin this project uses/);
    expect(await failure("@test/plugin:rules/Bare")).to.match(/'@test\/plugin:rules\/Bare' has no default export/);
  });
});

describe("a plugin's package.json", () => {
  it("lists its .fabr files as a path or a list of them", () => {
    expect(toPluginLibs({ libs: "lib/JS.fabr" })).to.deep.equal(["lib/JS.fabr"]);
    expect(toPluginLibs({ libs: ["lib/A.fabr", "lib/B.fabr"] })).to.deep.equal(["lib/A.fabr", "lib/B.fabr"]);
    expect(toPluginLibs({})).to.deep.equal([]);
  });

  it("refuses libs that are not paths", () => {
    expect(() => toPluginLibs({ libs: [1] })).to.throw(/"@fabr-build\/plugin".libs is not a path or a list of them/);
    expect(() => toPluginLibs("lib/JS.fabr")).to.throw();
  });
});
