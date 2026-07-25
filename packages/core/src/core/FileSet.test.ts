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
import { canonicalFileName } from "../support/Paths";
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

describe("FileSet name canonicalization", () => {
  it("keeps already-canonical names as written", () => {
    const files = set({ "a/b/c.txt": "1", "top.txt": "2" });
    expect([...files].map(([name]) => name).sort()).to.deep.equal(["a/b/c.txt", "top.txt"]);
  });

  it("flattens a leading ../ run to its tail (the flat sandbox has no above)", () => {
    const files = set({ "../scripts/x.ts": "1", "../../deep/y.ts": "2" });
    expect([...files].map(([name]) => name).sort()).to.deep.equal(["deep/y.ts", "scripts/x.ts"]);
  });

  it("resolves ./ and interior .. segments and strips a leading /", () => {
    const files = set({ "./a/x": "1", "a/../b/y": "2", "/rooted/z": "3" });
    expect([...files].map(([name]) => name).sort()).to.deep.equal(["a/x", "b/y", "rooted/z"]);
  });

  it("rejects backslashes and control characters", () => {
    expect(() => set({ "a\\b": "1" })).to.throw(/Invalid file name/);
    expect(() => set({ "a\nb": "1" })).to.throw(/Invalid file name/);
  });

  it("rejects names that name no path", () => {
    expect(() => set({ "..": "1" })).to.throw(/names no path/);
    expect(() => set({ ".": "1" })).to.throw(/names no path/);
  });

  it("conflicts when two different files flatten to one name", () => {
    expect(() => set({ "../scripts/x": "1", "scripts/x": "2" })).to.throw(ConflictError);
  });

  it("dedups the same file arriving under two spellings of one name", () => {
    const shared = MemoryFile.from("x");
    const files = new FileSet(
      new Map([
        ["./same", shared],
        ["same", shared],
      ])
    );
    expect(files.size).to.equal(1);
    expect(files.getFile("same")).to.equal(shared);
  });

  it("canonicalFileName flattens and rejects as documented", () => {
    expect(canonicalFileName("../a/./b/../c")).to.equal("a/c");
    expect(canonicalFileName("/abs/path")).to.equal("abs/path");
    expect(() => canonicalFileName("../..")).to.throw(/names no path/);
  });
});

describe("FileSet.remap", () => {
  it("is checked: two different files remapped to one name is a conflict", () => {
    const files = set({ "a.in": "1", "b.in": "2" });
    expect(() => files.remap(() => "collide")).to.throw(ConflictError);
  });

  it("canonicalizes remapped names, conflicting on a post-flatten collision", () => {
    const files = set({ "x.in": "1" });
    const remapped = files.remap(name => `../out/${name}`);
    expect([...remapped].map(([name]) => name)).to.deep.equal(["out/x.in"]);
    const two = set({ "out/x": "1", x: "2" });
    expect(() => two.remap(name => (name.startsWith("out/") ? name : `../out/${name}`))).to.throw(ConflictError);
  });
});
