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
import { Computable } from "./Computable";
import { FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { getResultFileSet, syncFileSet, writeFileSet } from "./Staging";
import { expect } from "chai";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("getResultFileSet", () => {
  let work: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-result-test-"));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("collects a build step's dotfile outputs rather than deleting them", async () => {
    /* A step may legitimately emit dotfiles (.eslintrc, .babelrc); under `**`
     * they must be collected, not silently dropped (and, worse, deleted). */
    fs.writeFileSync(path.join(work, "index.js"), "out");
    fs.writeFileSync(path.join(work, ".eslintrc"), "{}");
    fs.mkdirSync(path.join(work, ".config"));
    fs.writeFileSync(path.join(work, ".config", "nested.json"), "{}");

    const result = await toPromise(getResultFileSet(work, "**"));

    expect(await toPromise(result.get("index.js"))).to.not.equal(undefined);
    expect(await toPromise(result.get(".eslintrc"))).to.not.equal(undefined);
    expect(await toPromise(result.get(".config/nested.json"))).to.not.equal(undefined);
    /* And the dotfile is still on disk, not deleted as a non-match. */
    expect(fs.existsSync(path.join(work, ".eslintrc"))).to.equal(true);
  });
});

describe("syncFileSet", () => {
  let work: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-sync-test-"));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function fileset(entries: Record<string, string>): FileSet {
    return new FileSet(new Map(Object.entries(entries).map(([name, content]) => [name, MemoryFile.from(content)])));
  }

  it("writes added and changed files, removes gone ones, leaves the rest untouched", async () => {
    const before = fileset({ "index.html": "v1", "old.txt": "old", "same.txt": "same" });
    await toPromise(writeFileSet(work, before));
    const untouchedIno = fs.statSync(path.join(work, "same.txt")).ino;

    const after = fileset({ "index.html": "v2", "new.txt": "new", "same.txt": "same" });
    const delta = await toPromise(syncFileSet(work, before, after));

    expect(delta).to.deep.equal({ written: 2, removed: 1 });
    expect(fs.readFileSync(path.join(work, "index.html"), "utf8")).to.equal("v2");
    expect(fs.readFileSync(path.join(work, "new.txt"), "utf8")).to.equal("new");
    expect(fs.existsSync(path.join(work, "old.txt"))).to.equal(false);
    /* The unchanged file was not rewritten (same inode). */
    expect(fs.statSync(path.join(work, "same.txt")).ino).to.equal(untouchedIno);
  });

  it("replaces a staged hardlink without writing through it", async () => {
    /* Staged files are hardlinks into the cache's blob pool: an in-place write
     * would corrupt the blob. Sync must replace the directory entry (temp +
     * rename) and leave the linked-to content untouched. */
    const blob = path.join(work, "blob");
    fs.writeFileSync(blob, "cached");
    fs.mkdirSync(path.join(work, "stage"));
    const staged = path.join(work, "stage", "data.txt");
    fs.linkSync(blob, staged);

    const before = fileset({ "data.txt": "cached" });
    const after = fileset({ "data.txt": "updated" });
    await toPromise(syncFileSet(path.join(work, "stage"), before, after));

    expect(fs.readFileSync(staged, "utf8")).to.equal("updated");
    expect(fs.readFileSync(blob, "utf8")).to.equal("cached");
    expect(fs.statSync(blob).nlink).to.equal(1);
  });

  it("prunes directories emptied by removals, but never a still-occupied one", async () => {
    const before = fileset({ "sub/dir/a.txt": "a", "sub/keep.txt": "keep" });
    await toPromise(writeFileSet(work, before));

    const after = fileset({ "sub/keep.txt": "keep" });
    const delta = await toPromise(syncFileSet(work, before, after));

    expect(delta).to.deep.equal({ written: 0, removed: 1 });
    expect(fs.existsSync(path.join(work, "sub", "dir"))).to.equal(false);
    expect(fs.readFileSync(path.join(work, "sub", "keep.txt"), "utf8")).to.equal("keep");
  });

  it("is a no-op on an identical set", async () => {
    const before = fileset({ "index.html": "v1" });
    await toPromise(writeFileSet(work, before));
    const ino = fs.statSync(path.join(work, "index.html")).ino;

    const delta = await toPromise(syncFileSet(work, before, fileset({ "index.html": "v1" })));

    expect(delta).to.deep.equal({ written: 0, removed: 0 });
    expect(fs.statSync(path.join(work, "index.html")).ino).to.equal(ino);
  });
});
