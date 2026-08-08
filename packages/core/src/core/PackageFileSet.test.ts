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
import { MemoryFile } from "./MemoryFS";
import { IFile } from "./FileSet";
import { PackageFileSet, PackageGraphBuilder } from "./PackageFileSet";

describe("PackageGraphBuilder", () => {
  function files(tag: string): Map<string, IFile> {
    return new Map([["index.js", MemoryFile.from(`// ${tag}`)]]);
  }

  it("constructs a dependency cycle of immutable packages", () => {
    /* The construction depth-first immutability cannot produce: a ↔ b, each
     * carrying the other as an edge binding. */
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    const b = builder.node(files("b"), "b", "1.0.0");
    builder.wire(a, [b]);
    builder.wire(b, [a]);
    builder.seal();
    expect(a.dependencies).to.deep.equal([b]);
    expect(b.dependencies).to.deep.equal([a]);
    expect(Object.isFrozen(a.dependencies)).to.equal(true);
  });

  it("rejects wiring a node twice", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    const b = builder.node(files("b"), "b", "1.0.0");
    builder.wire(a, [b]);
    expect(() => builder.wire(a, [b])).to.throw("already wired");
  });

  it("counts an empty wiring as wired (a deliberate leaf is still wired once)", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    const b = builder.node(files("b"), "b", "1.0.0");
    builder.wire(a, []);
    expect(() => builder.wire(a, [b])).to.throw("already wired");
  });

  it("rejects nodes and wiring after seal", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    builder.seal();
    expect(() => builder.node(files("b"), "b", "1.0.0")).to.throw("sealed");
    expect(() => builder.wire(a, [])).to.throw("sealed");
  });

  it("rejects wiring a node it did not create", () => {
    const builder = new PackageGraphBuilder();
    const foreign = new PackageFileSet(files("x"), "x", "1.0.0");
    expect(() => builder.wire(foreign, [])).to.throw("not an unwired node");
  });

  it("an unwired node is an ordinary leaf after seal", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    builder.seal();
    expect(a.dependencies).to.deep.equal([]);
  });
});
