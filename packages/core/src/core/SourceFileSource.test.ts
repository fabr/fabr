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
import { ComputableSource } from "./Computable";
import { hashString } from "./FSWrapper";
import { SourceFileSource } from "./SourceFileSource";
import { expect } from "chai";

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("SourceFileSource", () => {
  let sourceRoot: string;
  let cacheRoot: string;
  let cache: BuildCache;

  beforeEach(() => {
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-src-test-"));
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-src-cache-"));
    cache = new BuildCache(cacheRoot);
  });

  afterEach(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("refuses to read a name outside the source tree", async () => {
    const src = new SourceFileSource(sourceRoot, cache);
    const rejectionOf = (computable: ComputableSource<unknown>): Promise<Error | undefined> =>
      toPromise(computable).then(
        () => undefined,
        err => err as Error
      );

    /* Rejected on the name, before any read — the file needn't exist. */
    const relative = await rejectionOf(src.get("../outside.txt"));
    expect(relative?.message).to.match(/outside the source tree/);

    /* An out-of-tree absolute is refused too; an in-tree absolute still resolves. */
    const absolute = await rejectionOf(src.get(path.join(sourceRoot, "..", "outside.txt")));
    expect(absolute?.message).to.match(/outside the source tree/);

    fs.writeFileSync(path.join(sourceRoot, "inside.txt"), "ok");
    const file = await toPromise(src.get(path.join(sourceRoot, "inside.txt")));
    expect(file?.hash).to.equal(hashString("ok"));
  });

  it("treats a vanished file as absent without throwing synchronously", async () => {
    const src = new SourceFileSource(sourceRoot, cache);
    /* The old statSync ran synchronously at the top of ingest, throwing straight
     * into the watcher callback for a file gone mid-event; ingest must instead
     * return a Computable that resolves to 'absent'. */
    const computable = src.ingest("gone.txt");
    expect(await toPromise(computable)).to.equal(undefined);
  });

  it("serves source content from an immutable blob, keeping the source path as its display name", async () => {
    const filePath = path.join(sourceRoot, "a.txt");
    fs.writeFileSync(filePath, "original");
    const src = new SourceFileSource(sourceRoot, cache);

    const file = (await toPromise(src.get("a.txt")))!;
    /* Content and identity resolve to the blob; the display name stays on source */
    expect(file.getDisplayName()).to.equal(filePath);
    expect(file.getAbsPath()!.startsWith(path.join(cacheRoot, "blob"))).to.equal(true);
    expect(file.hash).to.equal(hashString("original"));
    expect((await toPromise(file.getBuffer())).toString()).to.equal("original");
  });

  it("compiles the frozen snapshot, not a later edit — closing the hash/stage race", async () => {
    const filePath = path.join(sourceRoot, "a.txt");
    fs.writeFileSync(filePath, "v1");
    const src = new SourceFileSource(sourceRoot, cache);

    const file = (await toPromise(src.get("a.txt")))!;
    const hashV1 = hashString("v1");
    expect(file.hash).to.equal(hashV1);

    /* Mutate the source on disk *after* it was ingested (the race window). */
    fs.writeFileSync(filePath, "v2-changed-and-longer");

    /* The file still reads its frozen snapshot, and its hash still names exactly
     * those bytes — so the manifest key can never disagree with what is staged. */
    expect((await toPromise(file.getBuffer())).toString()).to.equal("v1");
    expect(file.hash).to.equal(hashV1);
  });
});
