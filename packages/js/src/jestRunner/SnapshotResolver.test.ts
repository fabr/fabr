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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSnapshotPath, resolveTestPath, testPathForConsistencyCheck } from "./SnapshotResolver";

/* Where a recorded snapshot lives, which is jest's own `snapshotResolver` seam.
 * Exercised here because nothing else does: the write-back e2e supplies its own
 * fixture runner (to stay off the network), so it matches records by its own
 * rules and never reaches this. */
describe("resolveSnapshotPath", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-snapres-"));
    fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A compiled test at `build/<name>`, optionally with the source map tsc
   * emits beside it (`sources` are relative to the map, as tsc writes them). */
  function compiled(name: string, source?: string): string {
    const file = path.join(dir, "build", name);
    fs.writeFileSync(file, "");
    if (source !== undefined) {
      fs.writeFileSync(`${file}.map`, JSON.stringify({ version: 3, sources: [source], sourcesContent: [""] }));
    }
    return file;
  }

  /** An already-recorded snapshot beside the compiled test. */
  function record(name: string): string {
    const snapshots = path.join(dir, "build", "__snapshots__");
    fs.mkdirSync(snapshots, { recursive: true });
    fs.writeFileSync(path.join(snapshots, name), "");
    return path.join(snapshots, name);
  }

  it("names a record for the SOURCE the test was compiled from", () => {
    /* The run only ever sees `Foo.test.js`; the map is what knows it came from
     * a `.tsx`, so a brand-new record is created under jest's own convention
     * rather than under the artifact's name. */
    const test = compiled("Foo.test.js", "../src/Foo.test.tsx");
    expect(resolveSnapshotPath(test)).to.equal(path.join(dir, "build", "__snapshots__", "Foo.test.tsx.snap"));
  });

  it("names it the same whether or not a record already exists", () => {
    /* The point of deriving from the map: the answer is a function of the
     * inputs, not of what happens to be on disk. */
    const test = compiled("Foo.test.js", "../src/Foo.test.ts");
    const before = resolveSnapshotPath(test);
    record("Foo.test.ts.snap");
    expect(resolveSnapshotPath(test)).to.equal(before);
  });

  it("keeps the record beside the compiled test, not beside the source", () => {
    /* The staged records ride the compiled tree (they are `copy` sources), so
     * the directory is the test's own — only the NAME comes from the source. */
    const test = compiled("Foo.test.js", "../src/Foo.test.ts");
    expect(path.dirname(resolveSnapshotPath(test))).to.equal(path.join(dir, "build", "__snapshots__"));
  });

  it("falls back to an existing record by stem when there is no map", () => {
    /* A release build emits no maps. An existing record still identifies itself,
     * so a suite carrying checked-in records keeps matching them. */
    const test = compiled("Foo.test.js");
    record("Foo.test.tsx.snap");
    expect(resolveSnapshotPath(test)).to.equal(path.join(dir, "build", "__snapshots__", "Foo.test.tsx.snap"));
  });

  it("falls back to the compiled name when there is neither map nor record", () => {
    const test = compiled("Foo.test.js");
    expect(resolveSnapshotPath(test)).to.equal(path.join(dir, "build", "__snapshots__", "Foo.test.js.snap"));
  });

  it("ignores a same-stem file that is not a record", () => {
    const test = compiled("Foo.test.js");
    record("Foo.test.ts.notsnap");
    expect(resolveSnapshotPath(test)).to.equal(path.join(dir, "build", "__snapshots__", "Foo.test.js.snap"));
  });

  it("survives an unreadable or non-JSON map rather than throwing", () => {
    const test = compiled("Foo.test.js");
    fs.writeFileSync(`${test}.map`, "not json at all");
    expect(resolveSnapshotPath(test)).to.equal(path.join(dir, "build", "__snapshots__", "Foo.test.js.snap"));
  });
});

describe("resolveTestPath", () => {
  it("round-trips jest's consistency sample", () => {
    /* jest asserts the two are mutual inverses using this exact value, so it
     * must name a file with no record and no map on disk — the compiled-name
     * branch, which is the invertible one. */
    expect(resolveTestPath(resolveSnapshotPath(testPathForConsistencyCheck))).to.equal(testPathForConsistencyCheck);
  });
});
