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
import { ConflictError } from "./Errors";
import { CANONICAL, FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { Name, NameBuilder } from "./Name";
import { getResultFileSet, syncFileSet, writeFileSet } from "./Staging";
import { expect } from "chai";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** Build a `selector -> template` rename Name from bare glob/literal segments,
 * bypassing the parser (a core test can't reach the model layer). Each segment
 * is `{lit}` (literal text) or `{glob}` (a `*`/`**` wildcard). */
type Seg = { lit?: string; glob?: string };
function renameName(selector: Seg[], template: Seg[]): Name {
  const build = (segs: Seg[]): Name => {
    const b = new NameBuilder();
    for (const s of segs) {
      if (s.glob !== undefined) {
        b.appendGlobMetachars(s.glob);
      } else {
        b.appendLiteralString(s.lit ?? "");
      }
    }
    return b.name();
  };
  return build(selector).withRenameTo(build(template));
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

  it("collects under a subdir and names results relative to it (string dir:glob)", async () => {
    /* The plain-string path (the exec/test-report callers) is unchanged by the
     * projection unification: `dir:glob` selects under dir, names relative to it. */
    fs.mkdirSync(path.join(work, "site"));
    fs.writeFileSync(path.join(work, "site", "index.html"), "page");
    fs.writeFileSync(path.join(work, "stray.html"), "outside");

    const result = await toPromise(getResultFileSet(work, "site:*.html"));

    expect([...result].map(([name]) => name)).to.deep.equal(["index.html"]);
    /* A file outside the selected dir is dropped (deleted), not collected. */
    expect(fs.existsSync(path.join(work, "stray.html"))).to.equal(false);
  });

  it("applies an output rename projection, renaming collected files", async () => {
    fs.writeFileSync(path.join(work, "foo.md"), "F");
    fs.writeFileSync(path.join(work, "bar.md"), "B");
    fs.writeFileSync(path.join(work, "skip.txt"), "S");

    /* `*.md -> out/*.md` */
    const output = renameName([{ glob: "*" }, { lit: ".md" }], [{ lit: "out/" }, { glob: "*" }, { lit: ".md" }]);
    const result = await toPromise(getResultFileSet(work, output));

    expect([...result].map(([name]) => name).sort()).to.deep.equal(["out/bar.md", "out/foo.md"]);
    expect(await toPromise(result.readFile("out/foo.md"))).to.equal("F");
    /* An unselected file is dropped (deleted), same as a non-matching glob. */
    expect(fs.existsSync(path.join(work, "skip.txt"))).to.equal(false);
  });

  it("reports a rename that collapses two files onto one name as a conflict", async () => {
    fs.writeFileSync(path.join(work, "a.txt"), "A");
    fs.writeFileSync(path.join(work, "b.txt"), "B");

    /* `*.txt -> dup.txt` — a constant target every match lands on. */
    const output = renameName([{ glob: "*" }, { lit: ".txt" }], [{ lit: "dup.txt" }]);

    await toPromise(getResultFileSet(work, output)).then(
      () => expect.fail("expected a ConflictError"),
      err => expect(err).to.be.instanceOf(ConflictError)
    );
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

  it("writes new files into a directory whose old occupants are all removed", async () => {
    /* Content-hashed outputs (e.g. pagefind's index shards) fill a directory with
     * one generation of names, then replace them with a wholly different set in
     * the same directory. The removals must not prune the directory out from under
     * the concurrent writes landing new files into it (renames were failing ENOENT
     * on the vanished parent, and the leftover temps then collided EEXIST). */
    const before = fileset({ "idx/old_a.dat": "a", "idx/old_b.dat": "b", "idx/old_c.dat": "c" });
    await toPromise(writeFileSet(work, before));

    const after = fileset({ "idx/new_a.dat": "x", "idx/new_b.dat": "y", "idx/new_c.dat": "z" });
    const delta = await toPromise(syncFileSet(work, before, after));

    expect(delta).to.deep.equal({ written: 3, removed: 3 });
    expect(fs.existsSync(path.join(work, "idx", "old_a.dat"))).to.equal(false);
    expect(fs.readFileSync(path.join(work, "idx", "new_a.dat"), "utf8")).to.equal("x");
    expect(fs.readFileSync(path.join(work, "idx", "new_c.dat"), "utf8")).to.equal("z");
    /* No temp siblings left behind. */
    expect(fs.readdirSync(path.join(work, "idx")).some(n => n.includes(".fabr-sync-"))).to.equal(false);
  });

  it("runs cleanly a second time in the same process (no temp-name collision)", async () => {
    /* Two syncs in one process must not reuse temp names — a regression guard for
     * the per-call counter reset that let a leftover temp poison later syncs. */
    const v1 = fileset({ "a.txt": "1" });
    await toPromise(writeFileSet(work, v1));
    await toPromise(syncFileSet(work, v1, fileset({ "a.txt": "2" })));
    const delta = await toPromise(syncFileSet(work, fileset({ "a.txt": "2" }), fileset({ "a.txt": "3" })));

    expect(delta).to.deep.equal({ written: 1, removed: 0 });
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).to.equal("3");
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

describe("staging containment backstop", () => {
  /* FileSet canonicalization makes an escaping name unconstructible through the
   * normal path, so these deliberately violate the invariant via the CANONICAL
   * trust marker — the backstop must hold even against a buggy trusted producer
   * (staging is where a violated invariant becomes filesystem damage). */
  let work: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-contain-test-"));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function escapingSet(name: string): FileSet {
    return new FileSet(new Map([[name, MemoryFile.from("evil")]]), undefined, CANONICAL);
  }

  it("writeFileSet refuses a name resolving outside the target dir", () => {
    expect(() => writeFileSet(path.join(work, "stage"), escapingSet("../escape.txt"))).to.throw(/outside the staging directory/);
    expect(fs.existsSync(path.join(work, "escape.txt"))).to.equal(false);
  });

  it("syncFileSet refuses an escaping write and an escaping removal", () => {
    const stage = path.join(work, "stage");
    fs.mkdirSync(stage);
    expect(() => syncFileSet(stage, new FileSet(new Map()), escapingSet("../escape.txt"))).to.throw(/outside the staging directory/);
    expect(() => syncFileSet(stage, escapingSet("../victim.txt"), new FileSet(new Map()))).to.throw(/outside the staging directory/);
  });
});
