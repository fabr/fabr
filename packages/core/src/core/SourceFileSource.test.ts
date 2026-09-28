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
import { Computable, ComputableSource } from "./Computable";
import { hashString } from "./FSWrapper";
import { MemoryFile } from "./MemoryFS";
import { parseSourceIndex } from "./Manifest";
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
      /* The temp name is the writer's own (pid + counter) — learn it from the
       * record rather than reconstructing it. */
      const temp = [...src["expected"].keys()].find(name => name.startsWith("src/__snapshots__/a.snap.fabr-writeback-"));
      expect(temp, "the temp sibling is recorded").to.not.equal(undefined);
      expect(src["isExpectedChange"](temp!), "the temp sibling").to.equal(true);
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
      /* The temp name is the writer's own business (pid + counter); ownership
       * rides on what the write ANNOUNCED, so learn the name from the record
       * rather than reconstructing it. */
      const temp = [...src["expected"].keys()].find(name => name.startsWith("a.snap.fabr-writeback-"));
      expect(temp, "the temp sibling is recorded").to.not.equal(undefined);
      expect(src["isExpectedChange"](temp!, true)).to.equal(true);
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

describe("SourceFileSource index trust", () => {
  let sourceRoot: string;
  let cacheRoot: string;

  beforeEach(() => {
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-srcidx-src-"));
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-srcidx-cache-"));
  });

  afterEach(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  /** A source file with its mtime floored to a whole second, which round-trips
   * exactly through every utimes/stat conversion (sub-ms fractions do not, and
   * a test that re-sets a stat-derived mtime needs the round-trip exact). */
  function writeAged(name: string, content: string, ageMs = 10_000): string {
    const file = path.join(sourceRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const at = new Date(Math.floor((Date.now() - ageMs) / 1000) * 1000);
    fs.utimesSync(file, at, at);
    return file;
  }

  function newSource(): SourceFileSource {
    return new SourceFileSource(sourceRoot, new BuildCache(cacheRoot, { log: () => undefined }));
  }

  /** The one record under projects/, as a path. */
  function recordPath(): string | undefined {
    const projects = path.join(cacheRoot, "projects");
    if (!fs.existsSync(projects)) {
      return undefined;
    }
    const owners = fs.readdirSync(projects);
    return owners.length === 0 ? undefined : path.join(projects, owners[0], "sources");
  }

  async function ingestAndPersist(source: SourceFileSource, ...names: string[]): Promise<(string | undefined)[]> {
    const hashes: (string | undefined)[] = [];
    for (const name of names) {
      hashes.push((await toPromise(source.ingest(name)))?.hash);
    }
    await toPromise(source.persistIndex());
    return hashes;
  }

  it("serves a stat-matching VERIFIED row without re-reading (proven by poisoning)", async () => {
    writeAged("src/a.ts", "export const a = 1;\n");
    /* Two runs: the first records the row unverified, the second's agreeing
     * capture verifies it. */
    const [realHash] = await ingestAndPersist(newSource(), "src/a.ts");
    await ingestAndPersist(newSource(), "src/a.ts");

    /* Swap the recorded hash for one naming different pool content. A trusting
     * read must surface the poison; a re-hashing read cannot. */
    const bogus = Buffer.from("poisoned content");
    const bogusHash = hashString(bogus);
    fs.mkdirSync(path.join(cacheRoot, "blob"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "blob", bogusHash), bogus);
    const record = recordPath()!;
    fs.writeFileSync(record, fs.readFileSync(record, "utf8").replace(realHash!, bogusHash));

    const trusted = await toPromise(newSource().ingest("src/a.ts"));
    expect(trusted!.hash).to.equal(bogusHash);
    expect(await toPromise(trusted!.readString())).to.equal("poisoned content");
  });

  it("a stat mismatch defeats a poisoned row (the determinism property)", async () => {
    writeAged("src/a.ts", "export const a = 1;\n");
    const [realHash] = await ingestAndPersist(newSource(), "src/a.ts");
    await ingestAndPersist(newSource(), "src/a.ts");

    const bogus = Buffer.from("poisoned content");
    const bogusHash = hashString(bogus);
    fs.writeFileSync(path.join(cacheRoot, "blob", bogusHash), bogus);
    const record = recordPath()!;
    fs.writeFileSync(record, fs.readFileSync(record, "utf8").replace(realHash!, bogusHash));

    /* Any stat change — here the mtime — must void the row. */
    const moved = new Date(Date.now() - 5000);
    fs.utimesSync(path.join(sourceRoot, "src/a.ts"), moved, moved);
    const reread = await toPromise(newSource().ingest("src/a.ts"));
    expect(reread!.hash).to.equal(realHash);
  });

  it("records a first capture unverified; a second run's agreement verifies it", async () => {
    writeAged("a.ts", "a\n");
    await ingestAndPersist(newSource(), "a.ts");
    expect(parseSourceIndex(fs.readFileSync(recordPath()!, "utf8"))!.rows.get("a.ts")!.verified).to.equal(false);

    await ingestAndPersist(newSource(), "a.ts");
    expect(parseSourceIndex(fs.readFileSync(recordPath()!, "utf8"))!.rows.get("a.ts")!.verified).to.equal(true);
  });

  it("re-hashes an unverified row on a stat match, catching a same-tick overwrite", async () => {
    /* The poison case verification exists for: a second write landing in the
     * same filesystem-timestamp tick as the hashed one, invisible to the
     * stat. No clock takes part in catching it. */
    const file = writeAged("a.ts", "one\n");
    const recorded = fs.statSync(file).mtime;
    const [firstHash] = await ingestAndPersist(newSource(), "a.ts");

    /* Same size, same mtime — only the bytes differ. */
    fs.writeFileSync(file, "two\n");
    fs.utimesSync(file, recorded, recorded);
    const reread = await toPromise(newSource().ingest("a.ts"));
    expect(reread!.hash).to.not.equal(firstHash);
    expect(await toPromise(reread!.readString()), "the overwrite is served, not the stale row").to.equal("two\n");
  });

  it("a swept blob falls back to the full path and restores it", async () => {
    writeAged("src/a.ts", "export const a = 1;\n");
    const source = newSource();
    const first = await toPromise(source.ingest("src/a.ts"));
    await toPromise(source.persistIndex());

    fs.rmSync(first!.getAbsPath()!, { force: true });
    const reingested = await toPromise(newSource().ingest("src/a.ts"));
    expect(reingested!.hash).to.equal(first!.hash);
    expect(fs.existsSync(first!.getAbsPath()!)).to.equal(true);
  });

  it("drops a consulted row whose file is gone, carries the unconsulted rest", async () => {
    writeAged("a.ts", "a\n");
    writeAged("b.ts", "b\n");
    await ingestAndPersist(newSource(), "a.ts", "b.ts");

    fs.rmSync(path.join(sourceRoot, "a.ts"));
    const next = newSource();
    expect(await toPromise(next.ingest("a.ts"))).to.equal(undefined);
    await toPromise(next.persistIndex());

    const parsed = parseSourceIndex(fs.readFileSync(recordPath()!, "utf8"))!;
    expect(parsed.rows.has("a.ts")).to.equal(false);
    expect(parsed.rows.has("b.ts")).to.equal(true);
  });

  it("serializes an index write behind a still-running one", async () => {
    writeAged("a.ts", "a\n");
    writeAged("b.ts", "b\n");
    const cache = new BuildCache(cacheRoot, { log: () => undefined });
    const source = new SourceFileSource(sourceRoot, cache);
    const real = cache.writeSourceIndex.bind(cache);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let calls = 0;
    cache.writeSourceIndex = (rootPath, rows) => {
      const n = ++calls;
      events.push(`start ${n}`);
      if (n === 1) {
        return Computable.from<boolean>(resolve => {
          releaseFirst = () => {
            events.push("end 1");
            resolve(true);
          };
        });
      }
      return real(rootPath, rows).then(wrote => {
        events.push(`end ${n}`);
        return wrote;
      });
    };

    await toPromise(source.ingest("a.ts"));
    source.persistIndex();
    await toPromise(source.ingest("b.ts"));
    const second = source.persistIndex();
    /* The second write must not begin while the first is still in flight — an
     * overlapping write's rename could land last and regress the index. */
    expect(events).to.deep.equal(["start 1"]);
    releaseFirst();
    await toPromise(second);
    expect(events).to.deep.equal(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("an unchanged run writes nothing (change-gated persist)", async () => {
    writeAged("a.ts", "a\n");
    await ingestAndPersist(newSource(), "a.ts");
    /* The second run verifies the row, which IS a change; from the third on
     * there is nothing left to learn. */
    await ingestAndPersist(newSource(), "a.ts");
    const before = fs.statSync(recordPath()!).mtimeMs;

    await ingestAndPersist(newSource(), "a.ts");
    expect(fs.statSync(recordPath()!).mtimeMs).to.equal(before);
  });

  it("confirms write-back expectations on the trusted path too", async () => {
    /* Same length, different bytes: the write-back below must leave a stat the
     * recorded row still matches once the mtime is restored. Two runs, so the
     * row is VERIFIED and the trusted path is the one taken. */
    writeAged("a.snap", "aaaaaaaa");
    await ingestAndPersist(newSource(), "a.snap");
    await ingestAndPersist(newSource(), "a.snap");
    const row = parseSourceIndex(fs.readFileSync(recordPath()!, "utf8"))!.rows.get("a.snap")!;

    const controller = new WatchController(10);
    let arms = 0;
    controller.armFlush = (): void => {
      arms += 1;
    };
    const src = new SourceFileSource(sourceRoot, new BuildCache(cacheRoot, { log: () => undefined }), controller);
    const dest = path.join(sourceRoot, "a.snap");
    await src.applyWriteBack([{ file: MemoryFile.from("bbbbbbbb"), destination: dest }]);
    /* Forge the recorded stat back onto the edited file, so the row trusts. */
    fs.utimesSync(dest, new Date(row.mtimeMs), new Date(row.mtimeMs));

    const served = await toPromise(src.ingest("a.snap"));
    /* The trusted path served the recorded content... */
    expect(served!.hash).to.equal(row.hash);
    /* ...and still judged the expectation: recorded ≠ written-back, so the
     * expectation is refuted and the flush armed. */
    expect(src["isExpectedChange"]("a.snap")).to.equal(false);
    expect(arms).to.equal(1);
  });
});
