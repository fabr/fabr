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
import { FileSetRef } from "./FileSetRef";
import { MemoryFile } from "./MemoryFS";
import { parseName } from "../model/Parser";

function set(entries: Record<string, string>): FileSet {
  return new FileSet(new Map(Object.entries(entries).map(([name, content]) => [name, MemoryFile.from(content)])));
}
const project = (selector: string, prefix = ""): { pattern: ReturnType<typeof parseName>; prefix: string } => ({
  pattern: parseName(selector),
  prefix,
});

describe("FileSetRef.select", () => {
  it("applies the projections, giving the files under their projected names", () => {
    const ref = new FileSetRef(set({ "src/a.ts": "a", "src/b.ts": "b", "other.ts": "c" }), [project("src:*.ts")]);
    expect([...ref.select()].map(([name]) => name)).to.deep.equal(["a.ts", "b.ts"]);
  });

  it("applies a rename", () => {
    const ref = new FileSetRef(set({ "index.ts": "a" }), [project("*.ts -> *.js")]);
    expect([...ref.select()].map(([name]) => name)).to.deep.equal(["index.js"]);
  });

  it("narrows successively", () => {
    const ref = new FileSetRef(set({ "bin/one.js": "a", "bin/two.js": "b" }), [project("bin:*.js"), project("two.js")]);
    expect([...ref.select()].map(([name]) => name)).to.deep.equal(["two.js"]);
  });

  it("throws the miss error when it matches nothing", () => {
    const miss = (): Error => new Error("nothing there");
    const ref = new FileSetRef(set({ "a.ts": "a" }), [project("b.ts")], miss);
    expect(() => ref.select()).to.throw("nothing there");
  });

  it("allows an empty result when there is no miss", () => {
    /* Carrying a miss IS the "this must resolve" judgment, made over the whole
     * written name by whoever built the ref — so a name with a glob in it
     * arrives here with none, and its empty result is not an error. */
    const ref = new FileSetRef(set({ "a.ts": "a" }), [project("*.css")]);
    expect(ref.select().isEmpty()).to.equal(true);
  });
});

describe("FileSetRef.locate", () => {
  it("gives container-relative path → projected name, the container untouched", () => {
    const ref = new FileSetRef(set({ "src/a.ts": "a", "other.ts": "c" }), [project("src:*.ts -> *.js")]);
    expect([...ref.locate()]).to.deep.equal([["src/a.ts", "a.js"]]);
  });

  it("applies the same must-resolve rule as select", () => {
    const miss = (): Error => new Error("nothing there");
    expect(() => new FileSetRef(set({ "a.ts": "a" }), [project("b.ts")], miss).locate()).to.throw("nothing there");
    /* ...and equally allows an empty result where there is no miss. */
    expect(new FileSetRef(set({ "a.ts": "a" }), [project("*.css")]).locate().size).to.equal(0);
  });
});

describe("FileSet.unionAll with a ref", () => {
  it("takes a materialized ref as the content it projects", () => {
    const ref = new FileSetRef(set({ "src/a.ts": "a" }), [project("src:*.ts")]);
    const union = FileSet.unionAll(set({ "b.ts": "b" }), ref);
    expect([...union].map(([name]) => name).sort()).to.deep.equal(["a.ts", "b.ts"]);
  });
});
