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
import { Computable, ComputableSource, ComputableState } from "./Computable";
import { FSFileSource, TreeQuery } from "./FSFileSource";
import { Name } from "./Name";
import { expect } from "chai";

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/* `removeDependant` is protected structural plumbing; reach it here to drive the
 * detach lifecycle directly — production tears edges down via the cascade, never
 * an outside call (mirrors Computable.test.ts's `unlink`). */
function unlink<P, D>(source: ComputableSource<P>, dependant: ComputableSource<D>): void {
  (source as unknown as { removeDependant(d: ComputableSource<D>): void }).removeDependant(dependant);
}

/** The shape TreeQuery's injectable enumerator resolves to. */
type EnumResult = { names: string[]; project: (rel: string) => string | undefined };

describe("FSFileSource.ingest", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats a file that has vanished as absent, not an error", async () => {
    const src = new FSFileSource(root);
    /* No sync throw at the call site, and the ingest resolves to 'absent' rather
     * than rejecting — a file vanishing mid-event (the editor save-rename dance)
     * must not crash the watcher callback nor sink the whole re-settle batch. */
    const result = await toPromise(src.ingest("gone.txt"));
    expect(result).to.equal(undefined);
  });

  it("ingests an existing file", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hi");
    const src = new FSFileSource(root);
    const file = await toPromise(src.ingest("a.txt"));
    expect(file?.name).to.equal("a.txt");
  });

  it("treats a directory as absent, not an error", async () => {
    /* A not-yet-existing directory reference matches the path itself; when that
     * path materializes as a directory its own event ingests here — a directory
     * is not a file, so it must be absent rather than an EISDIR hard error. */
    fs.mkdirSync(path.join(root, "adir"));
    const src = new FSFileSource(root);
    const result = await toPromise(src.ingest("adir"));
    expect(result).to.equal(undefined);
  });
});

/* The enumeration window: a TreeQuery's subscription is live from the moment it
 * registers, but enumeration is async — events landing in that gap must be
 * buffered and replayed, not dropped. Driven deterministically with an injected
 * enumeration the test resolves by hand (no real watcher / timing). */
describe("FSFileSource enumeration window (TreeQuery)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-win-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A TreeQuery whose enumeration this test resolves manually. `resolveEnum`
   * drives the *latest* attach's enumeration; `resolvers` holds one resolver per
   * attach in order (so a test can land a stale enumeration after a reattach). */
  function windowedQuery(name: string): {
    query: TreeQuery;
    resolveEnum: (v: EnumResult) => void;
    resolvers: ((v: EnumResult) => void)[];
  } {
    const src = new FSFileSource(root);
    let resolveEnum!: (v: EnumResult) => void;
    const resolvers: ((v: EnumResult) => void)[] = [];
    const enumerator = (): Computable<EnumResult> =>
      Computable.from<EnumResult>(resolve => {
        resolveEnum = resolve;
        resolvers.push(resolve);
      });
    const query = new TreeQuery(src, root, Name.fromLiteral(name), "", enumerator);
    /* Wrap, not capture: `resolveEnum` is only assigned once the query attaches
     * (in toPromise below), which is after this returns. */
    return { query, resolveEnum: (v: EnumResult) => resolveEnum(v), resolvers };
  }

  it("replays a create that arrived during the window (not dropped)", async () => {
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "new.ts"), "x");
    const { query, resolveEnum } = windowedQuery("dir");

    const settled = toPromise(query); /* attaches → enumeration now pending */
    query.applyEvent("dir/new.ts", false); /* lands mid-window → buffered */
    /* Enumeration completes seeing nothing (a snapshot from before the create);
     * the buffered event is what fills the set. */
    resolveEnum({ names: [], project: rel => rel });

    const fileSet = await settled;
    expect([...fileSet].map(([name]) => name)).to.include("dir/new.ts");
  });

  it("replays a delete from the window (a stale enumeration cannot resurrect it)", async () => {
    /* The file is on disk so the stale enumeration lists it (and ingest succeeds);
     * the buffered delete from the window must still win. */
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "gone.ts"), "x");
    const { query, resolveEnum } = windowedQuery("dir");

    const settled = toPromise(query);
    query.applyEvent("dir/gone.ts", true); /* deleted mid-window → buffered */
    resolveEnum({ names: ["dir/gone.ts"], project: rel => rel }); /* stale snapshot still lists it */

    const fileSet = await settled;
    expect([...fileSet].map(([name]) => name)).to.not.include("dir/gone.ts");
  });

  it("a not-yet-existing directory reference claims a later child file (not the literal matcher)", async () => {
    /* 'watchdir' does not exist when enumerated, so its type (file vs directory)
     * is unknown; the projection must accept both, so a later watchdir/child.ts
     * is claimed and fills the set. With the old literal-only matcher the child
     * was dropped and the set never filled. */
    const src = new FSFileSource(root);
    const query = src.find(Name.fromLiteral("watchdir")) as TreeQuery;
    const initial = await toPromise(query);
    expect([...initial]).to.deep.equal([]); /* nothing there yet */

    fs.mkdirSync(path.join(root, "watchdir"));
    fs.writeFileSync(path.join(root, "watchdir", "child.ts"), "x");
    /* The event is claimed (true); the old literal-only matcher dropped it (false). */
    expect(query.applyEvent("watchdir/child.ts", false)).to.equal(true);
  });

  it("discards an enumeration landing after detach, and reattaches (not permanently bricked)", async () => {
    /* A superseded watch evaluation orphans its subgraph: the last dependant
     * leaves while enumeration is in flight. When the result lands the node is
     * Detached — it must NOT settle (a source settles only while attached).
     * Settling here would strand it Valid, so addDependant's Detached check never
     * fires and a later re-demand never reattaches — permanently stale. */
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "old.ts"), "x");
    fs.writeFileSync(path.join(root, "dir", "new.ts"), "x");
    const { query, resolvers } = windowedQuery("dir");

    const dep = query.then(() => undefined); /* attach: enumeration #1 pending */
    expect(query.state).to.not.equal(ComputableState.Detached);
    unlink(query, dep); /* last dependant leaves → detach mid-enumeration */
    expect(query.state).to.equal(ComputableState.Detached);

    resolvers[0]({ names: ["dir/old.ts"], project: rel => rel }); /* stale result lands */
    /* Let its whole async settle (ingest + build) run to completion: without the
     * guard it would flip the detached node to Valid here. It must stay Detached. */
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(query.state).to.equal(ComputableState.Detached);

    /* Re-demand: it reattaches and a FRESH enumeration settles the current tree —
     * the proof it wasn't bricked. With the bug, the node is Valid (not Detached),
     * so addDependant never reattaches: the new dependant is served the stale set
     * (and no enumeration #2 is even started). */
    const settled = toPromise(query);
    resolvers[1]({ names: ["dir/new.ts"], project: rel => rel });
    const fileSet = await settled;
    expect([...fileSet].map(([n]) => n)).to.deep.equal(["dir/new.ts"]);
  });

  it("a reattach supersedes an in-flight enumeration (no interleave on shared state)", async () => {
    /* detach → immediate reattach starts enumeration #2 while #1 is still in
     * flight. When #1 lands the node is attached (not Detached), so only the
     * attach-generation guard rejects it; without it, #1 would mutate the shared
     * file/projection state under #2 and its stale file would leak into the set. */
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "stale.ts"), "x");
    fs.writeFileSync(path.join(root, "dir", "second.ts"), "x");
    const { query, resolvers } = windowedQuery("dir");

    const dep = query.then(() => undefined); /* attach #1: enumeration #1 pending */
    unlink(query, dep); /* detach */
    const settled = toPromise(query); /* reattach: attach #2, enumeration #2 pending */
    expect(query.state).to.not.equal(ComputableState.Detached);

    /* The stale #1 enumeration lands now — attached, so the generation guard (not
     * the Detached check) must reject it. */
    resolvers[0]({ names: ["dir/stale.ts"], project: rel => rel });
    await Promise.resolve();
    /* #2 completes and is the only contributor to the settled set. */
    resolvers[1]({ names: ["dir/second.ts"], project: rel => rel });
    const fileSet = await settled;
    expect([...fileSet].map(([n]) => n)).to.deep.equal(["dir/second.ts"]);
  });
});

/* Resolving a `-> tmpl` rename against the real tree: a single file renames, a
 * bare directory reference renames its whole subtree structure-preservingly (the
 * `dir -> out` ≡ `dir/** -> out/**` alias), and a leading `./` on the reference
 * doesn't defeat the rename. */
describe("FSFileSource rename resolution", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-ren-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const resolved = async (name: Name): Promise<string[]> => {
    const set = await toPromise(new FSFileSource(root).find(name));
    return [...set].map(([n]) => n).sort();
  };

  it("renames a single file, with or without a leading ./ on the reference", async () => {
    fs.writeFileSync(path.join(root, "single.txt"), "x");
    const to = Name.fromLiteral("renamed.txt");
    expect(await resolved(Name.fromLiteral("single.txt").withRenameTo(to))).to.deep.equal(["renamed.txt"]);
    /* The regression: picomatch strips a leading `./` from the rename pattern but
     * not the input, so a `./single.txt` name used to match nothing. */
    expect(await resolved(Name.fromLiteral("./single.txt").withRenameTo(to))).to.deep.equal(["renamed.txt"]);
  });

  it("expands a bare directory rename to a structure-preserving subtree rename", async () => {
    fs.mkdirSync(path.join(root, "stuff", "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "stuff", "one.txt"), "a");
    fs.writeFileSync(path.join(root, "stuff", "sub", "two.txt"), "b");
    /* `stuff -> out` behaves as `stuff/** -> out/**`: every file keeps its path
     * under the new root, at every depth. */
    const dir = Name.fromLiteral("stuff").withRenameTo(Name.fromLiteral("out"));
    expect(await resolved(dir)).to.deep.equal(["out/one.txt", "out/sub/two.txt"]);
  });
});

describe("FSFileSource symlink enumeration", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-link-"));
    fs.mkdirSync(path.join(root, "tree"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The files a bare `tree` reference (i.e. `tree/**`) enumerates. */
  const found = async (): Promise<string[]> => {
    const set = await toPromise(new FSFileSource(root).find(Name.fromLiteral("tree")));
    return [...set].map(([name]) => name).sort();
  };

  it("includes a symlink to a file, as every other path into the tree does", async () => {
    /* `stat`, `ingest` and a watch event all follow the link; a walk that did
     * not would make membership depend on whether anything had touched it. */
    fs.writeFileSync(path.join(root, "tree", "real.txt"), "x");
    fs.symlinkSync("real.txt", path.join(root, "tree", "link.txt"));
    expect(await found()).to.deep.equal(["tree/link.txt", "tree/real.txt"]);
  });

  it("drops a dangling symlink, which resolves to no file", async () => {
    fs.symlinkSync("nowhere.txt", path.join(root, "tree", "broken.txt"));
    expect(await found()).to.deep.equal([]);
  });

  it("does not descend a symlinked directory (the walk stays finite)", async () => {
    fs.mkdirSync(path.join(root, "tree", "real"));
    fs.writeFileSync(path.join(root, "tree", "real", "a.txt"), "x");
    fs.symlinkSync("real", path.join(root, "tree", "loop"));
    expect(await found()).to.deep.equal(["tree/real/a.txt"]);
  });
});
