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
import { registerProvenanceRenderer, renderProvenance } from "./Provenance";
import { parseName } from "../model/Parser";
import type { IProjection } from "./FileSetRef";

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

describe("FileSet merge provenance (lazy)", () => {
  /* A source origin whose renderer echoes the path it is asked to explain — lets
   * a test observe exactly what path the merge step delegates with. Registered in
   * the describe body (runs before the `it`s; no mocha `before` under jest). */
  registerProvenanceRenderer("test-echo", (_step, ctx) => [{ message: `echo:${ctx.path}` }]);

  it("unionAll delegates to the source that owns a given file's path", () => {
    const a = set({ "a.txt": "1" }).withOrigin({ kind: "test-echo" });
    const b = set({ "b.txt": "2" }).withOrigin({ kind: "test-echo" });
    const merged = FileSet.unionAll(a, b);
    expect(renderProvenance(merged.origin, { path: "b.txt" })).to.deep.equal([{ message: "echo:b.txt" }]);
  });

  it("layout strips the mount prefix before delegating, through nested merges", () => {
    const pkg = set({ "readme.md": "x" }).withOrigin({ kind: "test-echo" });
    const install = FileSet.layout({ node_modules: FileSet.layout({ yallist: pkg }) });
    /* node_modules/yallist/readme.md → (strip node_modules/) yallist/readme.md
     * → (strip yallist/) readme.md, delegated to the package origin. */
    expect(renderProvenance(install.origin, { path: "node_modules/yallist/readme.md" })).to.deep.equal([
      { message: "echo:readme.md" },
    ]);
  });

  it("carries no origin when no contributor has one (nothing to attribute)", () => {
    expect(FileSet.unionAll(set({ "a.txt": "1" }), set({ "b.txt": "2" })).origin).to.equal(undefined);
  });
});

describe("FileSet.locate", () => {
  const project = (selector: string, prefix = ""): IProjection => ({ pattern: parseName(selector), prefix });

  it("maps a member's own name to the name the projection gives it", () => {
    const located = set({ "index.js": "a", "other.js": "b" }).locate([project("index.js")]);
    expect([...located]).to.deep.equal([["index.js", "index.js"]]);
  });

  it("keys by the container-relative path when the selector strips a prefix", () => {
    /* `pkg/src/blah:index.ts` — called `index.ts`, but it lives at src/blah/. */
    const located = set({ "src/blah/index.ts": "a", "src/other.ts": "b" }).locate([project("src/blah:index.ts")]);
    expect([...located]).to.deep.equal([["src/blah/index.ts", "index.ts"]]);
  });

  it("gives the renamed name as the value, leaving the file where it is", () => {
    const located = set({ "index.ts": "a" }).locate([project("*.ts -> *.js")]);
    expect([...located]).to.deep.equal([["index.ts", "index.js"]]);
  });

  it("matches several members, and drops those the projection excludes", () => {
    const located = set({ "bin/one.js": "a", "bin/two.js": "b", "lib/x.js": "c" }).locate([project("bin/*.js")]);
    expect([...located.keys()]).to.deep.equal(["bin/one.js", "bin/two.js"]);
  });

  it("narrows successively — a later projection applies to the earlier's names", () => {
    const located = set({ "bin/one.js": "a", "bin/two.js": "b" }).locate([project("bin:*.js"), project("two.js")]);
    expect([...located]).to.deep.equal([["bin/two.js", "two.js"]]);
  });

  it("is empty when nothing matches", () => {
    expect(set({ "a.js": "x" }).locate([project("b.js")]).size).to.equal(0);
  });
});
