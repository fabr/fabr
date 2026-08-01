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
import { duplicateCoreError, resolvePackageFrom } from "./Plugin";

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

describe("plugin core-sharing check", () => {
  const HOST = "/host/node_modules/@fabr-build/core/index.js";
  const OTHER = "/plugin/node_modules/@fabr-build/core/index.js";

  it("reports a plugin that would load a core other than the host's", () => {
    const err = duplicateCoreError("@test/plugin", HOST, OTHER);
    expect(err?.message).to.match(/would load its own copy of @fabr-build\/core/);
    /* Both named, so the report says which copies actually collided. */
    expect(err?.message).to.contain(HOST);
    expect(err?.message).to.contain(OTHER);
    expect(err?.message).to.contain("@test/plugin");
  });

  it("accepts a plugin resolving the host's own core", () => {
    expect(duplicateCoreError("@test/plugin", HOST, HOST)).to.equal(undefined);
  });

  it("accepts a side that resolves no core at all", () => {
    expect(duplicateCoreError("@test/plugin", HOST, undefined)).to.equal(undefined);
    expect(duplicateCoreError("@test/plugin", undefined, OTHER)).to.equal(undefined);
  });
});
