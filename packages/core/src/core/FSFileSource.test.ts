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
import { FileSet } from "./FileSet";
import { Name, NamePartKind } from "./Name";
import { parseName } from "../model/Parser";
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
describe("FSFileSource.get", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-get-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns a file only at exactly that path — a directory is not a file", async () => {
    /* The contract ("a single direct file by exact name") and the walker's
     * boundary probes both need this: a directory holding exactly one file
     * must NOT answer with that file (wrong identity), nor walk its subtree
     * just to answer an existence probe. */
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "only.txt"), "x");
    const src = new FSFileSource(root);
    expect(await toPromise(src.get("sub"))).to.equal(undefined);
    expect(await toPromise(src.get("sub/only.txt"))).to.not.equal(undefined);
    expect(await toPromise(src.get("absent.txt"))).to.equal(undefined);
  });
});

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

  it("a stale enumeration cannot clobber a value a watch flush has already settled", async () => {
    /* The enumeration's build and a flush's recompute both snapshot `files` when they
     * start, and can finish in either order: here `big.ts` is deleted while its initial
     * hash is still in flight, so the (shorter) recompute settles the correct set first
     * and the enumeration's build lands afterwards holding the pre-delete snapshot.
     * Without the delivery guard it settles that snapshot — resurrecting the deleted
     * file AND advancing lastManifest to it, so the next recompute sees no change and
     * the deletion is lost until something else touches the query. */
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "big.ts"), "x");
    fs.writeFileSync(path.join(root, "dir", "small.ts"), "x");
    const { query, resolveEnum } = windowedQuery("dir");

    const seen: string[][] = [];
    query.then(fileSet => seen.push([...fileSet].map(([n]) => n)));
    resolveEnum({ names: ["dir/big.ts", "dir/small.ts"], project: rel => rel });
    /* Enumeration has landed but its build (ingest + hash of both files) is still in
     * flight — nothing settled yet. */
    expect(seen).to.deep.equal([]);

    /* big.ts is deleted and a flush recomputes and applies, all before that build ends. */
    fs.rmSync(path.join(root, "dir", "big.ts"));
    expect(query.applyEvent("dir/big.ts", true)).to.equal(true);
    const update = await toPromise(query.recompute());
    update?.invalidate();
    update?.settle();
    expect(seen).to.deep.equal([["dir/small.ts"]]);

    /* Now let the enumeration's build finish. It must deliver nothing. */
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(seen).to.deep.equal([["dir/small.ts"]]);
    expect([...(query.value as FileSet)].map(([n]) => n)).to.deep.equal(["dir/small.ts"]);
  });

  it("does not settle a prepared update whose query has since reattached", async () => {
    /* The controller prepares an update, then applies it after the whole batch has been
     * built — so a detach/reattach can happen in between. The reattach leaves the node
     * Unresolved (attached), so the base settle guard passes and only the delivery
     * tokens can reject the previous generation's file set. */
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "one.ts"), "x");
    const { query, resolvers } = windowedQuery("dir");

    const dep = query.then(() => undefined); /* attach #1 */
    resolvers[0]({ names: ["dir/one.ts"], project: rel => rel });
    await new Promise(resolve => setTimeout(resolve, 25));

    /* A change, recomputed into a prepared update the controller has not applied yet. */
    fs.writeFileSync(path.join(root, "dir", "two.ts"), "x");
    expect(query.applyEvent("dir/two.ts", false)).to.equal(true);
    const update = await toPromise(query.recompute());
    expect(update).to.not.be.null;

    /* Before it is applied, the query loses its dependant and regains one. */
    unlink(query, dep);
    const settled = toPromise(query); /* attach #2: enumeration #2 pending */
    update?.invalidate();
    update?.settle();
    /* The stale set must not have landed — attach #2 is still awaiting its enumeration. */
    expect(query.state).to.equal(ComputableState.Unresolved);

    /* Enumeration #2 is what settles it, from the current tree. */
    resolvers[1]({ names: ["dir/one.ts", "dir/two.ts"], project: rel => rel });
    const fileSet = await settled;
    expect([...fileSet].map(([n]) => n)).to.deep.equal(["dir/one.ts", "dir/two.ts"]);
  });

  it("reports no change while mid-enumeration (the file map is empty by construction)", async () => {
    /* A query already dirty in the controller can detach and reattach before the flush
     * fires. Recomputing during that window would build from the just-cleared map and
     * settle an empty set — and, worse, bump the delivery token so the enumeration
     * about to populate the map could no longer deliver. */
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "dir", "one.ts"), "x");
    const { query, resolvers } = windowedQuery("dir");

    const settled = toPromise(query); /* attach: enumeration pending */
    expect(await toPromise(query.recompute())).to.be.null;

    resolvers[0]({ names: ["dir/one.ts"], project: rel => rel });
    const fileSet = await settled;
    expect([...fileSet].map(([n]) => n)).to.deep.equal(["dir/one.ts"]);
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

/* Directory-level events. macOS reports a rename as one delete of the old path and one
 * create of the new, with NO per-child events, so a query must drop the old subtree and
 * walk the new one — neither of which the projection can judge, being a file-membership
 * predicate that a directory path simply fails. */
describe("FSFileSource directory events (TreeQuery)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-dir-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const names = (set: FileSet): string[] => [...set].map(([name]) => name).sort();

  /** Stand in for the controller: keep applying what the query reports until it reaches a
   * steady state. A rename settles in two steps — the synchronous subtree drop, then the
   * async rescan's own notify — exactly as it does in production, one flush each. */
  const settleFully = async (query: TreeQuery): Promise<string[]> => {
    for (let quiet = 0; quiet < 3; ) {
      const update = await toPromise(query.recompute());
      if (update) {
        update.invalidate();
        update.settle();
        quiet = 0;
      } else {
        quiet++;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return names(query.value as FileSet);
  };

  /** The two events, and only the two events, that `mv <from> <to>` actually delivers. */
  const renameEvents = (query: TreeQuery, from: string, to: string): void => {
    fs.renameSync(path.join(root, from), path.join(root, to));
    query.applyEvent(from, true);
    query.applyEvent(to, false);
  };

  function tree(): void {
    fs.mkdirSync(path.join(root, "src", "a", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a", "one.ts"), "1");
    fs.writeFileSync(path.join(root, "src", "a", "nested", "two.ts"), "2");
  }

  it("follows a directory rename under a glob reference", async () => {
    tree();
    const glob = new Name([
      { kind: NamePartKind.Literal, value: "src/" },
      { kind: NamePartKind.Glob, value: "**" },
    ]);
    const query = new FSFileSource(root).find(glob) as TreeQuery;
    expect(names(await toPromise(query))).to.deep.equal(["src/a/nested/two.ts", "src/a/one.ts"]);

    renameEvents(query, "src/a", "src/b");
    expect(await settleFully(query)).to.deep.equal(["src/b/nested/two.ts", "src/b/one.ts"]);
  });

  it("follows a directory rename under a bare directory reference", async () => {
    /* The both-arms case: `src/b` matches the reference's own literal arm, so it ingests
     * to `undefined` (a directory is no file) and only the rescan finds its contents. */
    tree();
    const query = new FSFileSource(root).find(Name.fromLiteral("src")) as TreeQuery;
    expect(names(await toPromise(query))).to.deep.equal(["src/a/nested/two.ts", "src/a/one.ts"]);

    renameEvents(query, "src/a", "src/b");
    expect(await settleFully(query)).to.deep.equal(["src/b/nested/two.ts", "src/b/one.ts"]);
  });

  it("drops a whole subtree on a directory delete", async () => {
    tree();
    fs.writeFileSync(path.join(root, "src", "keep.ts"), "k");
    const query = new FSFileSource(root).find(Name.fromLiteral("src")) as TreeQuery;
    expect(names(await toPromise(query))).to.deep.equal(["src/a/nested/two.ts", "src/a/one.ts", "src/keep.ts"]);

    fs.rmSync(path.join(root, "src", "a"), { recursive: true, force: true });
    /* One event for the directory, claimed because we hold files beneath it. */
    expect(query.applyEvent("src/a", true)).to.equal(true);
    expect(await settleFully(query)).to.deep.equal(["src/keep.ts"]);
  });

  it("still applies an ordinary single-file delete", async () => {
    tree();
    const query = new FSFileSource(root).find(Name.fromLiteral("src")) as TreeQuery;
    await toPromise(query);
    fs.rmSync(path.join(root, "src", "a", "one.ts"));
    expect(query.applyEvent("src/a/one.ts", true)).to.equal(true);
    expect(await settleFully(query)).to.deep.equal(["src/a/nested/two.ts"]);
  });

  it("discards a rescan that lands under a newer attach", async () => {
    /* The probe mutates shared file state, so it carries the attach generation like the
     * enumeration does: landing after a detach/reattach it must inject nothing into the
     * new attach's map. */
    fs.mkdirSync(path.join(root, "dir", "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "dir", "sub", "stale.ts"), "s");
    fs.writeFileSync(path.join(root, "dir", "fresh.ts"), "f");
    const resolvers: ((v: EnumResult) => void)[] = [];
    const query = new TreeQuery(new FSFileSource(root), root, Name.fromLiteral("dir"), "", () =>
      Computable.from<EnumResult>(resolve => resolvers.push(resolve))
    );

    const dep = query.then(() => undefined); /* attach #1 */
    resolvers[0]({ names: [], project: rel => rel });
    await new Promise(resolve => setTimeout(resolve, 10));

    query.applyEvent("dir/sub", false); /* probe starts, walking dir/sub */
    unlink(query, dep); /* superseded before it lands */
    const settled = toPromise(query); /* attach #2, enumeration #2 pending */
    await new Promise(resolve => setTimeout(resolve, 50)); /* the stale probe lands here */

    resolvers[1]({ names: ["dir/fresh.ts"], project: rel => rel });
    expect(names(await settled)).to.deep.equal(["dir/fresh.ts"]);
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

/* The regression: a pure-literal extglob (`!(Validation)/**`) matched nothing,
 * because the group's characters were literal to the name model while picomatch
 * read them as an extglob — so the walk based at a directory named
 * `!(Validation)`, which does not exist. A group with an interior wildcard
 * (`!(V*)`) accidentally worked, its glob part cutting the base back to "".
 * These enumerate for real, so the walk base and the match must agree. */
describe("FSFileSource extglob enumeration", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-ext-"));
    for (const dir of ["Validation", "V3", "api", "web"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, "f.ts"), "x");
    }
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const found = async (name: string): Promise<string[]> => {
    const set = await toPromise(new FSFileSource(root).find(parseName(name)));
    return [...set].map(([n]) => n).sort();
  };

  it("excludes a literal-only alternative", async () => {
    expect(await found("!(Validation)/**")).to.deep.equal(["V3/f.ts", "api/f.ts", "web/f.ts"]);
  });

  it("excludes several literal-only alternatives", async () => {
    /* A pattern list is one or more patterns — one alternative (above) and three
     * are as valid as the two that `|` makes look mandatory. */
    expect(await found("!(Validation|V3)/**/*.ts")).to.deep.equal(["api/f.ts", "web/f.ts"]);
    expect(await found("!(Validation|V3|api)/**/*.ts")).to.deep.equal(["web/f.ts"]);
  });

  it("agrees with the wildcard-bearing form that used to be the workaround", async () => {
    expect(await found("!(Valid*n|V3)/**")).to.deep.equal(await found("!(Validation|V3)/**"));
  });

  it("selects with the other leaders, and nested", async () => {
    expect(await found("@(api|web)/*.ts")).to.deep.equal(["api/f.ts", "web/f.ts"]);
    expect(await found("!(Validation|@(V3|api))/**")).to.deep.equal(["web/f.ts"]);
  });

  it("still bases the walk on a literal prefix before the group", async () => {
    /* Only the group itself is cut from the base: `api/` is still walked
     * directly rather than the whole tree being scanned and filtered. */
    expect(parseName("api/!(x)/**").getLiteralPathPrefix()).to.equal("api/");
    expect(await found("api/!(x).ts")).to.deep.equal(["api/f.ts"]);
  });

  it("treats the group's characters literally when quoted", async () => {
    fs.mkdirSync(path.join(root, "!(lit)"));
    fs.writeFileSync(path.join(root, "!(lit)", "g.ts"), "y");
    expect(await found("'!(lit)'/**")).to.deep.equal(["!(lit)/g.ts"]);
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
