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
import { runFabr } from "./harness";

/* The rename projection (`sel -> tmpl`) on a reference, exercised through the
 * real CLI: `fabr ls`/`cat` resolve a whole reference with the same grammar a
 * build file uses, so this covers lexer→parser→resolution→FileSet.rename. */
describe("e2e: rename projection", () => {
  const project = {
    "PROJECT.fabr": "myfiles = src:**/*;\n",
    "src/a.expect": "AAA\n",
    "src/sub/b.expect": "BBB\n",
    "src/c.txt": "CCC\n",
  };

  it("renames a recursive projection, preserving directory structure", () => {
    const result = runFabr(project, ["ls", "myfiles:**/*.expect -> **/*.out"]);
    expect(result.status).to.equal(0);
    /* `.expect` renamed to `.out`; the subdirectory is kept; the root-level file
     * gets no leading slash; `c.txt` is not selected. */
    expect(result.stdout.trim().split("\n").sort()).to.deep.equal(["a.out", "sub/b.out"]);
  });

  it("selects and renames a single file, cat reading the original content", () => {
    const result = runFabr(project, ["cat", "myfiles:*.expect -> *.out"]);
    expect(result.status).to.equal(0);
    /* `*` is segment-bounded, so only the root `a.expect` matches. */
    expect(result.stdout).to.equal("AAA\n");
  });
});
