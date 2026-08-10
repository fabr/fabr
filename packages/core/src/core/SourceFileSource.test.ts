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
import { WatchController } from "./WatchController";
import { ComputableSource } from "./Computable";
import { hashString } from "./FSWrapper";
import { MemoryFile } from "./MemoryFS";
import { SourceFileSource } from "./SourceFileSource";
import { IResolvedWriteBack } from "./WriteBack";
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
    cache = new BuildCache(cacheRoot, { log: () => undefined });
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

  it("treats a directory as absent, not an EISDIR error", async () => {
    /* A watch event can surface a directory the tree gained (a served tool's own
     * cache/output dirs): the blob-backing ingest reads bytes, so it must map
     * EISDIR to 'absent' exactly as the base does — not throw into the watcher. */
    fs.mkdirSync(path.join(sourceRoot, "subdir"));
    const src = new SourceFileSource(sourceRoot, cache);
    expect(await toPromise(src.ingest("subdir"))).to.equal(undefined);
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
  describe("applyWriteBack", () => {
    /** A source rooted at the project directory — the write goes through the object
     * that owns the tree, which is what lets it recognize its own echo. */
    const src = (root: string): SourceFileSource => new SourceFileSource(root, cache);
    const candidate = (content: string, destination: string): IResolvedWriteBack => ({ file: MemoryFile.from(content), destination });
  
    /* Nothing here asks whether the bytes differ: an unchanged record is never
     * offered in the first place (see snapshotWriteBacks), so every candidate
     * reaching a source is a real change. */
    it("writes a candidate and reports where it landed", async () => {
      const dest = path.join(sourceRoot, "a.snap");
      fs.writeFileSync(dest, "old");
      expect(await src(sourceRoot).applyWriteBack([candidate("new", dest)])).to.deep.equal([dest]);
      expect(fs.readFileSync(dest, "utf8")).to.equal("new");
    });
  
    it("creates a record that did not exist, directory and all", async () => {
      const dest = path.join(sourceRoot, "src/__snapshots__/a.snap");
      await src(sourceRoot).applyWriteBack([candidate("fresh", dest)]);
      expect(fs.readFileSync(dest, "utf8")).to.equal("fresh");
    });
  
    it("replaces the file rather than writing through it", async () => {
      /* A destination may be hardlinked into the content store (it was staged as
       * an input), and writing through the link would corrupt the shared blob.
       * Replacement leaves the other link — here, a stand-in for the blob —
       * holding the original bytes. */
      const dest = path.join(sourceRoot, "a.snap");
      const blob = path.join(sourceRoot, "blob");
      fs.writeFileSync(blob, "old");
      fs.linkSync(blob, dest);
      await src(sourceRoot).applyWriteBack([candidate("new", dest)]);
      expect(fs.readFileSync(dest, "utf8")).to.equal("new");
      expect(fs.readFileSync(blob, "utf8")).to.equal("old");
    });
  
    it("refuses a destination outside the project", async () => {
      const project = path.join(sourceRoot, "project");
      fs.mkdirSync(project);
      const outside = path.join(sourceRoot, "escaped.snap");
      /* Refused before any I/O, so this throws rather than rejecting. */
      let refusal: Error | undefined;
      try {
        await src(project).applyWriteBack([candidate("x", outside)]);
      } catch (err) {
        refusal = err as Error;
      }
      expect(refusal?.message).to.contain("outside the project directory");
      expect(fs.existsSync(outside)).to.equal(false);
    });
  });

  describe("its own writes, under watch", () => {
    /** A source whose `armFlush` is observable — the one thing a refuted
     * expectation does. */
    const watched = (): { src: SourceFileSource; arms: number } => {
      const controller = new WatchController(10);
      let arms = 0;
      controller.armFlush = (): void => {
        arms += 1;
      };
      return { src: new SourceFileSource(sourceRoot, cache, controller), get arms() { return arms; } };
    };

    const candidate = (content: string, destination: string): IResolvedWriteBack => ({ file: MemoryFile.from(content), destination });

    it("treats a write-back's own destination as expected, so it arms nothing", async () => {
      /* Not destructured: `arms` is a live count, and pulling it out here would
       * read it before anything had happened. */
      const w = watched();
      const src = w.src;
      const dest = path.join(sourceRoot, "a.snap");
      await src.applyWriteBack([candidate("recorded", dest)]);
      /* The watch event for this path must not become a rebuild — its only
       * outcome would be to write the identical bytes again. */
      expect(src["isExpectedChange"]("a.snap")).to.equal(true);
      /* Re-reading confirms the content, leaving the expectation standing (a
       * filesystem may report the same change twice). `ingest` directly rather
       * than `get`: it is where the hash is computed and so where confirmation
       * happens, and it does not register a live query. */
      await toPromise(src.ingest("a.snap"));
      expect(src["isExpectedChange"]("a.snap")).to.equal(true);
      expect(w.arms).to.equal(0);
    });

    it("expects the paths a write only incidentally disturbs", async () => {
      /* A write is not one event: it renames from a temp sibling and may have
       * had to create the directory. Recognizing only the destination would
       * leave the other two arming a rebuild. */
      const src = watched().src;
      await src.applyWriteBack([candidate("recorded", path.join(sourceRoot, "src/__snapshots__/a.snap"))]);
      expect(src["isExpectedChange"]("src/__snapshots__"), "the directory it created").to.equal(true);
      expect(src["isExpectedChange"](`src/__snapshots__/a.snap.fabr-writeback-${process.pid}`), "the temp sibling").to.equal(true);
    });

    it("refutes the expectation and arms when the file turns out to hold something else", async () => {
      /* Somebody edited the record between the write and the event. The change
       * was recorded as dirty by the deferred notify; this is what gives it a
       * reason to be applied. */
      const w = watched();
      const src = w.src;
      const dest = path.join(sourceRoot, "a.snap");
      await src.applyWriteBack([candidate("recorded", dest)]);
      fs.writeFileSync(dest, "edited by hand");
      await toPromise(src.ingest("a.snap"));
      expect(src["isExpectedChange"]("a.snap")).to.equal(false);
      expect(w.arms).to.equal(1);
    });

    it("leaves a path it never wrote alone", async () => {
      const src = watched().src;
      expect(src["isExpectedChange"]("untouched.txt")).to.equal(false);
    });

    it("treats DELETING a written-back file as somebody else's change", async () => {
      /* The confirm-by-content backstop lives in ingest, which never runs for
       * a removal (there is nothing left to read) — so the judgment itself
       * must refute, or the deletion is deferred forever and no rebuild picks
       * it up until an unrelated edit. */
      const src = watched().src;
      const dest = path.join(sourceRoot, "a.snap");
      await src.applyWriteBack([candidate("recorded", dest)]);
      expect(src["isExpectedChange"]("a.snap", true), "the removal is not ours").to.equal(false);
      /* And the stale expectation is dropped, so a recreation is judged afresh. */
      expect(src["isExpectedChange"]("a.snap")).to.equal(false);
    });

    it("still owns the temp sibling's disappearance (the rename consumes it)", async () => {
      const src = watched().src;
      await src.applyWriteBack([candidate("recorded", path.join(sourceRoot, "a.snap"))]);
      expect(src["isExpectedChange"](`a.snap.fabr-writeback-${process.pid}`, true)).to.equal(true);
    });

    it("refutes a directory removal covering written-back content", async () => {
      /* `rm -rf __snapshots__` is ONE delete event naming the directory, with
       * no per-child deletes — the subtree scan is what catches the records
       * beneath it. */
      const src = watched().src;
      await src.applyWriteBack([candidate("recorded", path.join(sourceRoot, "src/__snapshots__/a.snap"))]);
      expect(src["isExpectedChange"]("src/__snapshots__", true)).to.equal(false);
      expect(src["isExpectedChange"]("src/__snapshots__/a.snap")).to.equal(false);
    });
  });
});
