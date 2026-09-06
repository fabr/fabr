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
import { Computable } from "./Computable";
import { EMPTY_FILESET, FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { PackageFileSet, PackageGraphBuilder } from "./PackageFileSet";
import { StringReader } from "../support/StringReader";
import { ActionFileInputs, BuildAction, declIdentity, IBuildActionDefinition, manifestFileInputs, optionsDigest } from "./BuildAction";
import { ActionOptions } from "./Manifest";
import { DeclKind, ITargetDecl } from "../model/AST";
import { parseName } from "../model/Parser";

const STEP: IBuildActionDefinition = { id: "test:compile", version: 1, run: () => Computable.resolve({ result: EMPTY_FILESET }) };

function decl(name: string, file: string): ITargetDecl {
  return {
    kind: DeclKind.Target,
    type: "js_package",
    typeOffset: 0,
    name: parseName(name),
    properties: [],
    source: { fs: EMPTY_FILESET, file, reader: new StringReader("") },
    offset: 0,
  };
}

function sources(content: string): FileSet {
  return new FileSet(new Map([["src/index.ts", MemoryFile.from(content)]]));
}

/** The action's input bags, any of them omitted — the test fixture's shorthand. */
interface ActionParts {
  inputs?: ActionFileInputs;
  options?: ActionOptions;
  discoverable?: ActionFileInputs;
}

function action(parts: ActionParts, step = STEP): BuildAction {
  return new BuildAction(step, parts.inputs ?? {}, parts.options ?? {}, parts.discoverable, "compile");
}

describe("target-key identity", () => {
  const owner = decl("mylib", "packages/mylib/PROJECT.fabr");

  it("survives an edit to the sources it is compiling", () => {
    /* A target key names "this compile, across edits", so the build state
     * recorded under it is still the right one to diff the next edit against. */
    const before = action({ inputs: { srcs: sources("one") }, options: { argv: ["tsc"] } }).targetKey(owner);
    const after = action({ inputs: { srcs: sources("two") }, options: { argv: ["tsc"] } }).targetKey(owner);
    expect(after).to.equal(before);
  });

  it("survives a source being added or removed", () => {
    const one = action({ inputs: { srcs: sources("one") } }).targetKey(owner);
    const two = action({
      inputs: {
        srcs: new FileSet(
          new Map([
            ["src/index.ts", MemoryFile.from("one")],
            ["src/extra.ts", MemoryFile.from("x")],
          ])
        ),
      },
    }).targetKey(owner);
    expect(two).to.equal(one);
  });

  it("separates the compiles one target legitimately runs", () => {
    /* A dual-format package builds its ESM and CommonJS emits from one
     * declaration: they differ in their generated configuration, which is what
     * the digest is for. Sharing one would thrash a single graph into perpetual
     * full compiles. */
    const esm = action({ inputs: { srcs: sources("one") }, options: { argv: ["tsc", "--emit-extension", ".mjs"] } }).targetKey(owner);
    const cjs = action({ inputs: { srcs: sources("one") }, options: { argv: ["tsc"] } }).targetKey(owner);
    expect(esm).to.not.equal(cjs);
  });

  it("separates targets and steps", () => {
    const base = action({ inputs: { srcs: sources("one") } });
    const key = base.targetKey(owner);
    expect(base.targetKey(decl("other", "packages/mylib/PROJECT.fabr")), "a target").to.not.equal(key);
    expect(base.targetKey(decl("mylib", "elsewhere/PROJECT.fabr")), "the file it was declared in").to.not.equal(key);
    expect(action({ inputs: { srcs: sources("one") } }, { ...STEP, version: 2 }).targetKey(owner), "a step version").to.not.equal(key);
  });

  it("is the same wherever a configuration changed nothing the action consumes", () => {
    /* A target is identified by what it CONSUMES, and everything consumed is
     * already an input — so a `-D` naming the value the shipped default already
     * had produces a bit-identical action and must land on the same one. Keying it
     * apart would put the memo where the next build does not look. */
    const inputs = { inputs: { srcs: sources("one") }, options: { argv: ["tsc"], strict: "on" } };
    expect(action(inputs).targetKey(owner)).to.equal(action({ ...inputs }).targetKey(owner));
  });

  it("is different where a configuration moved something the action consumes", () => {
    /* The other half: a constraint a rule actually READ has reached the action
     * as a scalar input, and so reaches the key through the digest — which is
     * the read-trace of exactly that. */
    const srcs = { srcs: sources("one") };
    const key = action({ inputs: srcs, options: { argv: ["tsc"], strict: "on" } }).targetKey(owner);
    expect(
      action({ inputs: srcs, options: { argv: ["tsc"], strict: "off" } }).targetKey(owner),
      "a switch the rule read"
    ).to.not.equal(key);
    expect(
      action({ inputs: srcs, options: { argv: ["tsc", "--target", "es5"], strict: "on" } }).targetKey(owner),
      "a target the rule read"
    ).to.not.equal(key);
  });

  it("ignores a sub-target's display label", () => {
    /* A label is text a rule author chose to describe work in progress, not
     * identity: what distinguishes two compiles of one owner is their inputs. */
    const inputs: ActionFileInputs = { srcs: sources("one") };
    const labelled = new BuildAction(STEP, inputs, {}, undefined, "compiling for the browser");
    expect(labelled.targetKey(owner)).to.equal(new BuildAction(STEP, inputs, {}).targetKey(owner));
  });

  it("names a declaration by its target and the file it was written in", () => {
    /* Process-stable on purpose: in-memory decl identity would do for one run
     * and is worthless across two, which is the only span a target key exists
     * over. */
    expect(declIdentity(owner)).to.equal("mylib@packages/mylib/PROJECT.fabr");
  });
});

describe("the options digest", () => {
  it("holds everything that is not per-file material", () => {
    const digest = (parts: ActionParts): string => optionsDigest(action(parts));
    const srcs = { srcs: sources("one") };
    const base = { inputs: srcs, options: { argv: ["tsc"], layout: "pnp" } };
    expect(digest(base), "a string input").to.not.equal(digest({ inputs: srcs, options: { argv: ["tsc"], layout: "flat" } }));
    expect(digest(base), "a string list").to.not.equal(
      digest({ inputs: srcs, options: { argv: ["tsc", "--strict"], layout: "pnp" } })
    );
    expect(digest(base), "a projection").to.not.equal(
      digest({ ...base, options: { ...base.options, output: parseName("build:**") } })
    );
  });

  it("reads nothing but the options — per-file inputs and the pool are not identity", () => {
    /* Anchor fields carry no unassembled packages in production — a tool
     * arrives as its assembled install, ordinary per-file content inside
     * `inputs` — so a tool change reaches the build through the action key and
     * the memo's per-file diff (a changed non-graph file forces the driver's
     * full recompile), never through the digest. The digest is therefore a
     * pure function of `options`. */
    const dep = (content: string): PackageFileSet =>
      new PackageFileSet(new Map([["index.d.ts", MemoryFile.from(content)]]), "left-pad", "1.0.0", []);
    const base = { inputs: { srcs: sources("one") }, options: { argv: ["tsc"] } };
    expect(optionsDigest(action(base)), "an edited source").to.equal(
      optionsDigest(action({ ...base, inputs: { srcs: sources("edited") } }))
    );
    expect(optionsDigest(action(base)), "a list of filesets").to.equal(
      optionsDigest(action({ ...base, inputs: { ...base.inputs, extra: [sources("a"), sources("b")] } }))
    );
    expect(optionsDigest(action(base)), "a package input").to.equal(
      optionsDigest(action({ ...base, inputs: { ...base.inputs, tools: dep("one") } }))
    );
    expect(optionsDigest(action({ ...base, discoverable: { deps: [dep("one")] } })), "the discoverable deps").to.equal(
      optionsDigest(action({ ...base, discoverable: { deps: [dep("two")] } }))
    );
  });
});

describe("the key fold over package inputs", () => {
  /** a → b, as a delivery would carry it. */
  function graph(bTag: string, nested = false): { a: PackageFileSet; b: PackageFileSet } {
    const builder = new PackageGraphBuilder();
    const a = builder.node(new Map([["index.js", MemoryFile.from("// a")]]), "a", "1.0.0");
    const b = builder.node(new Map([["index.js", MemoryFile.from(`// ${bTag}`)]]), "b", "1.0.0", undefined, nested);
    builder.wire(a, [b]);
    builder.wire(b, []);
    builder.seal();
    return { a, b };
  }
  const keyOf = (deps: FileSet[]): string => manifestFileInputs({ deps });

  it("is stable for an unchanged closure, and names a transitive by the path it is reached by", () => {
    expect(keyOf([graph("b").a])).to.equal(keyOf([graph("b").a]));
    const { a, b } = graph("b");
    expect(keyOf([a])).to.contain(`a b ${b.toManifestHash()}`);
  });

  it("turns over when a TRANSITIVE package's content changes", () => {
    /* The point of walking the graph: the key must still turn over when a
     * package the step will mount changes, even though the direct member's own
     * name doesn't. */
    expect(keyOf([graph("b").a])).to.not.equal(keyOf([graph("b changed").a]));
  });

  it("turns over when an edge is rebound or a delivery nests, contents unchanged", () => {
    const unbound = new PackageFileSet(new Map([["index.js", MemoryFile.from("// a")]]), "a", "1.0.0");
    expect(keyOf([unbound]), "a dropped edge is a different graph").to.not.equal(keyOf([graph("b").a]));
    expect(keyOf([graph("b").a]), "a nested-override delivery too").to.not.equal(keyOf([graph("b", true).a]));
  });

  it("DOES distinguish direct from transitive — what a package is reached by is what a mount sees", () => {
    /* `scoped` and `pnp` both decide visibility from the direct list — the
     * top-level row is `dependencyList(roots)` — so the same instances reached
     * two ways are not the same input: dropping a declared dep that survives
     * transitively must move the key. */
    const { a, b } = graph("b");
    expect(keyOf([a, b])).to.not.equal(keyOf([a]));
    expect(keyOf([a, b]), "the direct member is named by a length-one path").to.contain(`b ${b.toManifestHash()}`);
  });

  it("is order-canonical, packages and loose members alike", () => {
    /* No assembled outcome depends on list order: conflicts fire regardless of
     * it, and the pnp table sorts. */
    const x = new PackageFileSet(new Map([["index.js", MemoryFile.from("// x")]]), "x", "1.0.0");
    const y = new PackageFileSet(new Map([["index.js", MemoryFile.from("// y")]]), "y", "1.0.0");
    expect(keyOf([x, y])).to.equal(keyOf([y, x]));
    const loose = (tag: string): FileSet => new FileSet(new Map([[`${tag}.txt`, MemoryFile.from(tag)]]));
    expect(keyOf([loose("p"), loose("q")])).to.equal(keyOf([loose("q"), loose("p")]));
  });

  it("keeps a loose member's files form beside the graph lines", () => {
    const pkg = new PackageFileSet(new Map([["index.js", MemoryFile.from("// p")]]), "p", "1.0.0");
    const loose = new FileSet(new Map([["config.json", MemoryFile.from("{}")]]));
    const manifest = keyOf([pkg, loose]);
    expect(manifest).to.contain(`p ${pkg.toManifestHash()}`);
    expect(manifest).to.contain("config.json");
  });

  it("records each package's edges once, at its first-seen path", () => {
    /* a → b, a → c, b → c, c → d: c's edges are walked where c was first seen,
     * so `a c d` is present and `a b c d` is not — one line per edge rather
     * than one per route, which a shared graph makes exponential. */
    const builder = new PackageGraphBuilder();
    const node = (tag: string): PackageFileSet => builder.node(new Map([["index.js", MemoryFile.from(`// ${tag}`)]]), tag, "1.0.0");
    const [a, b, c, d] = [node("a"), node("b"), node("c"), node("d")];
    builder.wire(a, [b, c]);
    builder.wire(b, [c]);
    builder.wire(c, [d]);
    builder.wire(d, []);
    builder.seal();
    const paths = keyOf([a])
      .split("\n")
      .map(line => line.split(" ").slice(0, -1).join(" "))
      .filter(path => path.length > 0 && !path.startsWith("{"));
    expect(paths).to.deep.equal(["a", "a b", "a c", "a b c", "a c d"]);
  });
});

describe("the action key", () => {
  it("omits the discoverable deps — names as well as contents — unconditionally", () => {
    /* The anchor is structural: an action carrying discoverable deps keys
     * without them, so adding an unrelated one is a no-op, and two different
     * sets under one anchor are told apart by the precise key alone. */
    const dep = (content: string): PackageFileSet =>
      new PackageFileSet(new Map([["index.d.ts", MemoryFile.from(content)]]), "left-pad", "1.0.0", []);
    const srcs = { srcs: sources("one") };
    const anchored = action({ inputs: srcs, discoverable: { deps: [dep("one")] } }).actionKey();
    expect(action({ inputs: srcs, discoverable: { deps: [dep("two")] } }).actionKey(), "a dep's content").to.equal(anchored);
    expect(action({ inputs: srcs }).actionKey(), "even their presence").to.equal(anchored);
    expect(action({ inputs: { ...srcs, deps: [dep("one")] } }).actionKey(), "an ordinary input is key material").to.not.equal(
      anchored
    );
  });

  it("keeps same-named members apart across the two sections", () => {
    /* The sections are rendered with their own headers even when empty, so a
     * member cannot slide from one section to the other and land on the same
     * key text. */
    const asInput = action({ inputs: { files: sources("x") } }).actionKey();
    const asOption = action({ options: { files: "x" } }).actionKey();
    expect(asInput).to.not.equal(asOption);
  });
});
