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
import { BuildCache } from "./BuildCache";
import { ComputableSource } from "./Computable";
import { IFile } from "./FileSet";
import { hashString } from "./FSWrapper";
import { IndexedFileSource } from "./IndexedFileSource";
import { WatchController } from "./WatchController";

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("IndexedFileSource, read in place", () => {
  let dir: string;
  let cacheRoot: string;
  let cache: BuildCache;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-host-")));
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-host-cache-"));
    cache = new BuildCache(cacheRoot, { log: () => undefined });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  /** Make a source over `/` reading in place, watching what its queries cover. */
  const inPlace = (controller?: WatchController): IndexedFileSource =>
    new IndexedFileSource("/", cache, { read: "in-place", watch: "queried" }, controller);

  const hashAt = (source: IndexedFileSource, location: string): Promise<string | undefined> =>
    toPromise(source.get(location)).then((file: IFile | undefined) => file?.hash);

  it("reads a file by its absolute path, following a link to what it names", async () => {
    fs.writeFileSync(path.join(dir, "tool"), "one");
    fs.symlinkSync("tool", path.join(dir, "alias"));
    const source = inPlace();
    expect(await hashAt(source, path.join(dir, "alias"))).to.equal(hashString("one"));
    expect(await hashAt(source, path.join(dir, "missing"))).to.equal(undefined);
    expect(await hashAt(source, dir)).to.equal(undefined);
  });

  it("serves a verified row on a stat match, without hashing", async () => {
    const tool = path.join(dir, "tool");
    fs.writeFileSync(tool, "one");
    const when = new Date(2026, 0, 1);
    fs.utimesSync(tool, when, when);
    const first = inPlace();
    await hashAt(first, tool);
    await toPromise(first.persistIndex());
    /* A second hashing that agrees verifies the row. */
    const second = inPlace();
    await hashAt(second, tool);
    await toPromise(second.persistIndex());
    /* Same size, same mtime, different bytes: only a served row answers "one". */
    fs.writeFileSync(tool, "two");
    fs.utimesSync(tool, when, when);
    expect(await hashAt(inPlace(), tool)).to.equal(hashString("one"));
    /* A stat that moves is hashed again. */
    fs.writeFileSync(tool, "three");
    expect(await hashAt(inPlace(), tool)).to.equal(hashString("three"));
  });

  it("hashes an unverified row again", async () => {
    const tool = path.join(dir, "tool");
    fs.writeFileSync(tool, "one");
    const when = new Date(2026, 0, 1);
    fs.utimesSync(tool, when, when);
    const first = inPlace();
    await hashAt(first, tool);
    await toPromise(first.persistIndex());
    fs.writeFileSync(tool, "two");
    fs.utimesSync(tool, when, when);
    expect(await hashAt(inPlace(), tool)).to.equal(hashString("two"));
  });

  it("copies nothing into the blob pool", async () => {
    fs.writeFileSync(path.join(dir, "tool"), "big");
    const file = await toPromise(inPlace().get(path.join(dir, "tool")));
    expect(file?.getAbsPath()).to.equal(path.join(dir, "tool"));
    expect(cache.presentBlob(hashString("big"))).to.equal(undefined);
  });

  it("watches only the directory a file it reads lies in", async () => {
    fs.writeFileSync(path.join(dir, "tool"), "one");
    const controller = new WatchController(10);
    const source = inPlace(controller);
    try {
      await hashAt(source, path.join(dir, "tool"));
      expect([...source["subscriptions"].keys()]).to.deep.equal([dir.substring(1)]);
    } finally {
      await controller.close();
    }
  });
});
