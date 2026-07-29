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
import { FileSet, IFile, MemoryFile } from "@fabr-build/core";
import { selectCompiledTestFiles } from "./TestPipeline";

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
