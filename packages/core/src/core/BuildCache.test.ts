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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BuildCache } from "./BuildCache";
import { Computable } from "./Computable";
import { FileSet } from "./FileSet";
import { hashString } from "./FSWrapper";
import { MemoryFile } from "./MemoryFS";
import { expect } from "chai";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("BuildCache", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-buildcache-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists in-memory files into the cache directory", async () => {
    const cache = new BuildCache(root);
    const files = await toPromise(
      cache.getOrCreate("test manifest", () =>
        Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"name":"test"}')]])))
      )
    );
    const file = await toPromise(files.get("meta.json"));
    expect(file).to.not.equal(undefined);
    const abspath = file!.getAbsPath();
    expect(abspath).to.not.equal(undefined);
    expect(abspath!.startsWith(root)).to.equal(true);
    expect(fs.readFileSync(abspath!, "utf8")).to.equal('{"name":"test"}');
  });

  it("pre-cleans debris and removes partial entries on failure", async () => {
    const cache = new BuildCache(root);
    const targetDir = path.join(root, hashString("failing manifest"));
    /* Simulate a crashed earlier attempt: entry content but no manifest */
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "leftover.txt"), "stale");

    let failure: Error | undefined;
    try {
      await toPromise(cache.getOrCreate("failing manifest", () => Computable.reject(new Error("boom"))));
    } catch (err) {
      failure = err as Error;
    }
    expect(failure?.message).to.equal("boom");
    /* The partial entry was removed on failure */
    expect(fs.existsSync(targetDir)).to.equal(false);

    /* A retry over fresh debris pre-cleans and succeeds */
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "leftover.txt"), "stale");
    const files = await toPromise(
      cache.getOrCreate("failing manifest", () =>
        Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"ok":true}')]])))
      )
    );
    expect(await toPromise(files.readFile("meta.json"))).to.equal('{"ok":true}');
    expect(fs.existsSync(path.join(targetDir, "leftover.txt"))).to.equal(false);
  });

  it("returns the cached result without re-running the build", async () => {
    const cache = new BuildCache(root);
    await toPromise(
      cache.getOrCreate("test manifest", () =>
        Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"name":"test"}')]])))
      )
    );

    /* A separate BuildCache instance sees the persisted entry and never calls create */
    const reopened = new BuildCache(root);
    const files = await toPromise(
      reopened.getOrCreate("test manifest", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    const content = await toPromise(files.readFile("meta.json"));
    expect(content).to.equal('{"name":"test"}');
    /* A fully-cached run built nothing */
    expect(reopened.getBuildCount()).to.equal(0);
  });
});
