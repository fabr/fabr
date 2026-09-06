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
import { ConflictError } from "./Errors";
import { FileSet, IFile } from "./FileSet";
import {
  assertSamePackageNode,
  flattenFileSetArray,
  packageNodeSignature,
  PackageFileSet,
  PackageGraphBuilder,
} from "./PackageFileSet";

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

describe("flattenFileSetArray", () => {
  function files(tag: string): Map<string, IFile> {
    return new Map([["index.js", MemoryFile.from(`// ${tag}`)]]);
  }

  it("retains loose members and appends a package member's closure, each instance once", () => {
    const loose = new FileSet(files("loose"));
    const shared = new PackageFileSet(files("shared"), "shared", "1.0.0");
    const a = new PackageFileSet(files("a"), "a", "1.0.0", [shared]);
    const b = new PackageFileSet(files("b"), "b", "1.0.0", [shared]);
    const flat = flattenFileSetArray([loose, a, b]);
    /* Given members in order first, then the closure breadth-first; the shared
     * instance is deduplicated by identity. */
    expect(flat).to.deep.equal([loose, a, b, shared]);
  });

  it("is cycle-safe", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    const b = builder.node(files("b"), "b", "1.0.0");
    builder.wire(a, [b]);
    builder.wire(b, [a]);
    builder.seal();
    expect(flattenFileSetArray([a])).to.deep.equal([a, b]);
  });
});

describe("packageNodeSignature", () => {
  function files(tag: string): Map<string, IFile> {
    return new Map([["index.js", MemoryFile.from(`// ${tag}`)]]);
  }

  it("names a package by one line — id, content hash, edges, override flag", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(files("a"), "a", "1.0.0");
    const b = builder.node(files("b"), "b", "1.0.0");
    builder.wire(a, [b]);
    builder.wire(b, []);
    builder.seal();
    const line = packageNodeSignature(a);
    expect(line).to.contain("a@1.0.0");
    expect(line).to.contain(a.toManifestHash());
    expect(line).to.contain("[b@1.0.0]");
    expect(line).to.not.contain("\n");
    expect(line, "the line covers this node only, not the edge target's content").to.not.contain(b.toManifestHash());
  });

  it("distinguishes an edge rebinding and a nested-override delivery, contents unchanged", () => {
    const leaf = (nested: boolean): PackageFileSet => new PackageFileSet(files("p"), "p", "1.0.0", [], undefined, nested);
    const bound = new PackageFileSet(files("p"), "p", "1.0.0", [new PackageFileSet(files("d"), "d", "1.0.0")]);
    expect(packageNodeSignature(leaf(false)), "an edge is part of the node").to.not.equal(packageNodeSignature(bound));
    expect(packageNodeSignature(leaf(false)), "so is the placement flag").to.not.equal(packageNodeSignature(leaf(true)));
  });
});

/* Naming a node by its id (in the manifest's edges and the assemblers' merge)
 * is sound only if two instances sharing an id agree on everything an
 * assembler can read off them — the invariant this check enforces. */
describe("assertSamePackageNode", () => {
  function files(tag: string): Map<string, IFile> {
    return new Map([["index.js", MemoryFile.from(`// ${tag}`)]]);
  }

  it("accepts two equal wrappings of one package", () => {
    /* Byte-identical, separately constructed — the ordinary shape of one
     * package arriving through two deliveries. */
    const dep = (): PackageFileSet => new PackageFileSet(files("p"), "p", "1.0.0", [new PackageFileSet(files("q"), "q", "1.0.0")]);
    expect(() => assertSamePackageNode(dep(), dep())).to.not.throw();
  });

  it("rejects two contents under one id", () => {
    const a = new PackageFileSet(files("built debug"), "p", "1.0.0");
    const b = new PackageFileSet(files("built release"), "p", "1.0.0");
    expect(() => assertSamePackageNode(a, b)).to.throw(ConflictError, "p@1.0.0");
  });

  it("rejects two edge bindings under one id, contents equal", () => {
    const a = new PackageFileSet(files("p"), "p", "1.0.0", [new PackageFileSet(files("q1"), "q", "1.0.0")]);
    const b = new PackageFileSet(files("p"), "p", "1.0.0", [new PackageFileSet(files("q2"), "q", "2.0.0")]);
    expect(() => assertSamePackageNode(a, b)).to.throw(ConflictError);
  });

  it("rejects a nested-override instance against a plain one", () => {
    const a = new PackageFileSet(files("p"), "p", "1.0.0");
    const b = new PackageFileSet(files("p"), "p", "1.0.0", [], undefined, true);
    expect(() => assertSamePackageNode(a, b)).to.throw(ConflictError);
  });
});
