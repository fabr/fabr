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
import { FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { ConflictError } from "./Errors";

function set(entries: Record<string, string>): FileSet {
  return new FileSet(new Map(Object.entries(entries).map(([name, content]) => [name, MemoryFile.from(content)])));
}

describe("FileSet.rename", () => {
  it("renames matched files and drops those the renamer excludes", () => {
    const files = set({ "a.expect": "1", "b.expect": "2", "note.txt": "3" });
    const renamed = files.rename(name => (name.endsWith(".expect") ? name.replace(/\.expect$/, ".out") : undefined));
    expect([...renamed].map(([name]) => name).sort()).to.deep.equal(["a.out", "b.out"]);
  });

  it("dedups the same file arriving twice at one name", () => {
    const shared = MemoryFile.from("x");
    const files = new FileSet(
      new Map([
        ["a", shared],
        ["b", shared],
      ])
    );
    /* Both map to "same" but are the *same* IFile — no conflict. */
    const renamed = files.rename(() => "same");
    expect(renamed.size).to.equal(1);
  });

  it("reports a conflict when two different files rename to one name", () => {
    const files = set({ "a.in": "1", "b.in": "2" });
    expect(() => files.rename(() => "collide.out")).to.throw(ConflictError);
  });
});
