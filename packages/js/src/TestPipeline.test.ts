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
import { EMPTY_FILESET, FileSet, IFile, MemoryFile } from "@fabr-build/core";
import { selectCompiledSetupFile, selectCompiledTestFiles, snapshotWriteBacks } from "./TestPipeline";

/** A FileSet with the given names (contents irrelevant to selection). */
function fileSetOf(...names: string[]): FileSet {
  return new FileSet(new Map<string, IFile>(names.map(name => [name, MemoryFile.from("")])));
}

describe("selectCompiledTestFiles", () => {
  it("picks the .js outputs whose stem is a declared test, out of the actual compiled tree", () => {
    /* The tree also carries the sourcemap, declarations, a non-test source, and a
     * non-test .js — none of which should be selected. */
    const tree = fileSetOf("a/foo.test.js", "a/foo.test.js.map", "a/foo.test.d.ts", "a/foo.js", "b/bar.test.js");
    const stems = new Set(["a/foo.test", "b/bar.test"]);
    expect(selectCompiledTestFiles(tree, stems)).to.deep.equal(["a/foo.test.js", "b/bar.test.js"]);
  });

  it("includes a .js test source's compiled output, not only .ts/.tsx (the M2 case)", () => {
    /* A `foo.test.js` source → stem `foo.test` → compiled `foo.test.js`. The old
     * `.ts`-only name prediction dropped it → a silently-green run; here it's
     * selected because js_compile actually emitted it. */
    const tree = fileSetOf("foo.test.js");
    expect(selectCompiledTestFiles(tree, new Set(["foo.test"]))).to.deep.equal(["foo.test.js"]);
  });

  it("returns empty when no compiled .js matches a declared test (so the caller errors, not greens)", () => {
    const tree = fileSetOf("foo.js", "foo.d.ts");
    expect(selectCompiledTestFiles(tree, new Set(["foo.test"]))).to.deep.equal([]);
  });

  it("picks up a .mts/.cts test's compiled .mjs/.cjs output", () => {
    const tree = fileSetOf("a.test.mjs", "b.test.cjs", "a.test.d.mts");
    expect(selectCompiledTestFiles(tree, new Set(["a.test", "b.test"]))).to.deep.equal(["a.test.mjs", "b.test.cjs"]);
  });
});

/** A source-tree FileSet: names as declared, each locatable back to `root` —
 * the provenance an FS query attaches (see FSFileSource's source-tree step). */
function sourceSetOf(root: string, ...names: string[]): FileSet {
  return new FileSet(
    new Map<string, IFile>(names.map(name => [name, MemoryFile.from("")])),
    { kind: "source-tree", root, paths: new Map(names.map(name => [name, name])) } as never
  );
}

describe("snapshotWriteBacks", () => {
  it("rekeys a refreshed record to the SOURCE name, in the tests' own namespace", () => {
    /* A runner may name a record after the compiled file it ran (jest's own
     * default, so perfectly conforming). Rekeying it here to the source name is
     * what makes the correspondence a pure naming rule — and it is also what
     * reaches the tree, so a record lands as `<test file>.snap`, jest's
     * convention, unchanged. Nothing here is a host path. */
    const tests = sourceSetOf("/proj", "a/foo.test.tsx");
    const snapshots = fileSetOf("a/__snapshots__/foo.test.js.snap");
    const [candidate] = snapshotWriteBacks(snapshots, tests, EMPTY_FILESET);
    expect([...candidate.files].map(([name]) => name)).to.deep.equal(["a/__snapshots__/foo.test.tsx.snap"]);
    expect(candidate.origin).to.equal(tests.origin);
  });

  it("states the correspondence as one rewrite, which names the test a record belongs to", () => {
    /* The driver applies this and nothing else — it needs no notion of what a
     * snapshot is, and the names cannot drift from the relationship because
     * there is only one statement of it. */
    const tests = sourceSetOf("/proj", "a/foo.test.tsx", "bar.test.ts");
    const snapshots = fileSetOf("a/__snapshots__/foo.test.tsx.snap", "__snapshots__/bar.test.ts.snap");
    const [candidate] = snapshotWriteBacks(snapshots, tests, EMPTY_FILESET);
    const belongs = candidate.belongsTo.makeProjector();
    expect(belongs("a/__snapshots__/foo.test.tsx.snap")).to.equal("a/foo.test.tsx");
    /* At the tree root the `**` captures nothing and the separator normalizes. */
    expect(belongs("__snapshots__/bar.test.ts.snap")).to.equal("bar.test.ts");
  });

  it("does not offer a record the run reproduced unchanged", () => {
    /* Changed-ness is decided HERE, where both sides are already hashed — the
     * staged input the run was given, and what it wrote — rather than by reading
     * the user's file at write time. So an unchanged record is never offered,
     * which is what lets the write itself be unconditional and keeps a no-op
     * update run from touching the tree at all. */
    const tests = sourceSetOf("/proj", "a/foo.test.tsx");
    const name = "a/__snapshots__/foo.test.js.snap";
    const recorded = new FileSet(new Map<string, IFile>([[name, MemoryFile.from("recorded: one")]]));
    /* Same name, same bytes: the run put back exactly what it was given. */
    expect(snapshotWriteBacks(recorded, tests, recorded)).to.deep.equal([]);
    /* Different bytes under that name: a real change, and offered. */
    const refreshed = new FileSet(new Map<string, IFile>([[name, MemoryFile.from("recorded: two")]]));
    expect(snapshotWriteBacks(refreshed, tests, recorded)).to.have.lengthOf(1);
    /* A record that did not exist has nothing to compare against. */
    expect(snapshotWriteBacks(refreshed, tests, EMPTY_FILESET)).to.have.lengthOf(1);
  });

  it("prefers the source-named record when both it and a compiled-named one were collected", () => {
    /* A runner that found the checked-in record rewrites THAT file; the
     * unchanged staged copy and a stray compiled-named one both share the stem,
     * so the exact name decides rather than iteration order. */
    const tests = sourceSetOf("/proj", "foo.test.ts");
    const wanted = MemoryFile.from("chosen");
    const snapshots = new FileSet(
      new Map<string, IFile>([
        ["__snapshots__/foo.test.js.snap", MemoryFile.from("other")],
        ["__snapshots__/foo.test.ts.snap", wanted],
      ])
    );
    expect([...snapshotWriteBacks(snapshots, tests, EMPTY_FILESET)[0].files][0][1]).to.equal(wanted);
  });

  it("offers nothing for a test with no refreshed record", () => {
    const tests = sourceSetOf("/proj", "foo.test.ts", "bar.test.ts");
    const snapshots = fileSetOf("__snapshots__/foo.test.js.snap");
    expect([...snapshotWriteBacks(snapshots, tests, EMPTY_FILESET)[0].files].map(([name]) => name)).to.deep.equal([
      "__snapshots__/foo.test.ts.snap",
    ]);
  });

  it("offers a record for a test with no source location, and lets the driver find it unplaceable", () => {
    /* A generated test. Nothing here has to notice: the offer is stated the same
     * way either way, and it is the driver — the one that resolves inputs to
     * places on disk — that discovers there is nowhere to write it and says so.
     * Skipping it here would put the failure in the layer that cannot report it. */
    const tests = fileSetOf("generated.test.ts");
    const snapshots = fileSetOf("__snapshots__/generated.test.js.snap");
    const [candidate] = snapshotWriteBacks(snapshots, tests, EMPTY_FILESET);
    expect([...candidate.files].map(([name]) => name)).to.deep.equal(["__snapshots__/generated.test.ts.snap"]);
    expect(candidate.origin).to.equal(undefined);
  });

  it("ignores collected files that are not records", () => {
    const tests = sourceSetOf("/proj", "foo.test.ts");
    expect(snapshotWriteBacks(fileSetOf("ctrf-report.json", "foo.snap"), tests, EMPTY_FILESET)).to.deep.equal([]);
  });
});

describe("selectCompiledSetupFile", () => {
  it("finds the conventional script at the tree root, whatever it compiled from", () => {
    for (const compiled of ["setupTests.js", "setupTests.cjs", "setupTests.mjs"]) {
      expect(selectCompiledSetupFile(fileSetOf(compiled, "a/thing.js")), compiled).to.equal(compiled);
    }
  });

  it("is undefined for a target that has none", () => {
    expect(selectCompiledSetupFile(fileSetOf("a/thing.js", "a/thing.test.js"))).to.equal(undefined);
  });

  it("ignores one nested inside the tree", () => {
    /* Rooted, so an ordinary source that happens to be named this — a helper
     * for one directory's tests — cannot quietly become suite-wide setup. */
    expect(selectCompiledSetupFile(fileSetOf("helpers/setupTests.js", "a/thing.js"))).to.equal(undefined);
  });

  it("ignores a non-JS file of the same stem", () => {
    expect(selectCompiledSetupFile(fileSetOf("setupTests.d.ts", "setupTests.js.map"))).to.equal(undefined);
  });

  it("rejects two at the root rather than picking one", () => {
    /* Silently choosing would leave the other's polyfills mysteriously absent. */
    expect(() => selectCompiledSetupFile(fileSetOf("setupTests.js", "setupTests.cjs"))).to.throw("more than one");
  });
});
