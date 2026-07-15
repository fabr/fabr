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
import { Computable, ComputableSource } from "./Computable";
import { FSFileSource, TreeQuery } from "./FSFileSource";
import { Name } from "./Name";
import { expect } from "chai";

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
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

  /** A TreeQuery whose enumeration this test resolves manually, plus the resolver. */
  function windowedQuery(name: string): { query: TreeQuery; resolveEnum: (v: EnumResult) => void } {
    const src = new FSFileSource(root);
    let resolveEnum!: (v: EnumResult) => void;
    const enumerator = (): Computable<EnumResult> =>
      Computable.from<EnumResult>(resolve => {
        resolveEnum = resolve;
      });
    const query = new TreeQuery(src, root, Name.fromLiteral(name), "", enumerator);
    /* Wrap, not capture: `resolveEnum` is only assigned once the query attaches
     * (in toPromise below), which is after this returns. */
    return { query, resolveEnum: (v: EnumResult) => resolveEnum(v) };
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
});
