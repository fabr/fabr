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

/* Driver-level CLI behaviours exercised through the real command line: `cat`
 * output ordering/atomicity, and setup-failure reporting. */
describe("e2e: driver CLI", () => {
  const project = {
    "PROJECT.fabr": "files = src:**/*;\n",
    "src/a.txt": "AAA\n",
    "src/b.txt": "BBB\n",
  };

  it("cats multiple names in argument order, not name-sorted / settle order", () => {
    /* `b.txt` first though it sorts after `a.txt`: the output must follow the
     * argument order, so a wrong (sorted or settle-order) result is visible. */
    const result = runFabr(project, ["cat", "files:b.txt", "files:a.txt"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("BBB\nAAA\n");
  });

  it("writes no partial output when a later name matches nothing", () => {
    /* The first name resolves fine, the second matches no files. Because cat
     * collects every name before emitting, the run fails with nothing on stdout
     * (rather than the first name's content followed by an error). */
    const result = runFabr(project, ["cat", "files:a.txt", "files:zzz.txt"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/matched no files/);
  });

  it("renders both sides of a naming conflict raised by the driver's own union", () => {
    /* `both` is a multi-value property whose two values resolve to filesets that
     * each name `dup.txt` at a different underlying file. `cat both` unions them
     * in the driver (no enclosing target build), so the ConflictError is
     * ownerless — the formatter must still surface both attributed sides, not
     * just the one-line message. */
    const conflict = {
      "PROJECT.fabr": "adir = src:a/* -> *;\nbdir = src:b/* -> *;\nboth = adir bdir;\n",
      "src/a/dup.txt": "FROM A\n",
      "src/b/dup.txt": "FROM B\n",
    };
    const result = runFabr(conflict, ["cat", "both"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/Conflicting files for dup\.txt/);
    /* The two sides — dropped before the fix (owner-gated), now rendered as
     * notes tracing each contributor to its underlying file. */
    expect(result.stderr).to.match(/src\/a\/dup\.txt/);
    expect(result.stderr).to.match(/src\/b\/dup\.txt/);
  });

  it("reports a formatted diagnostic (not a raw crash) when run outside a project", () => {
    /* No PROJECT.fabr anywhere up the tree: getSourceRoot fails before the build
     * graph exists. That failure must be reported like any other (the terminal
     * "Build failed" line marks the handled path) and not escape as an unhandled
     * rejection. */
    const result = runFabr({ "notes.txt": "hi\n" }, ["cat", "files:a.txt"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/No PROJECT\.fabr found/);
    expect(result.stderr).to.match(/Build failed/);
  });
});
