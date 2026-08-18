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
import {
  Computable,
  ConflictError,
  FileSet,
  Flag,
  IFile,
  MemoryFile,
  PackageFileSet,
  PackageGraphBuilder,
  SymlinkFile,
} from "@fabr-build/core";
import {
  assembleNodeModules,
  assembleScopedNodeModules,
  binByConvention,
  binOf,
  canonicalEsLevel,
  classifySourceByExt,
  classifySources,
  compileInputs,
  esLevelOrder,
  hasPackageExport,
  makeNpmRunnable,
  parseJSTarget,
  passthroughFiles,
  resolveJsxImportSource,
  resolveSourceMode,
  resolveSourceVersion,
  usesDom,
  withBinShebangs,
} from "./JSPackage";

/** A package with a single `index.js` and the given (already-built) deps. */
function pkg(name: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}`)]]), name, "1.0.0", deps);
}

/** A versioned package (content distinct per version) with the given carried
 * deps — for a delivered closure: flat winners on the root, private version
 * overrides nested on their requirers. */
function vpkg(name: string, version: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]), name, version, deps);
}

/** Snapshot a FileSet's entries into a plain map for synchronous inspection. */
function entries(set: FileSet): Map<string, IFile> {
  return new Map(set);
}

/* The scoped layout has no consumer today (see assembleScopedNodeModules): it
 * is kept for a filesystem-resolving compiler, and kept TESTED so that whoever
 * wires one up inherits a working arrangement rather than an untested one. */
describe("assembleScopedNodeModules", () => {
  it("exposes only direct deps at the top level, the closure only in the scoped area", () => {
    const transitive = pkg("b4a");
    const direct = pkg("tar-stream", [transitive]);
    const files = entries(assembleScopedNodeModules([direct]));

    /* The direct dep is a symlink into the store; the transitive one is not
     * present at the top level at all. */
    const top = files.get("tar-stream");
    expect(top).to.be.instanceOf(SymlinkFile);
    expect((top as SymlinkFile).target).to.equal(".pkgs/node_modules/tar-stream");
    expect(files.has("b4a")).to.equal(false);

    /* Both packages' real files live in the store, so a direct dep can resolve
     * its own (transitive) imports there. */
    expect(files.has(".pkgs/node_modules/tar-stream/index.js")).to.equal(true);
    expect(files.has(".pkgs/node_modules/b4a/index.js")).to.equal(true);
  });

  it("points a scoped package's symlink back up to the scoped area", () => {
    const files = entries(assembleScopedNodeModules([pkg("@types/node")]));
    /* From node_modules/@types/node the link must climb one level to reach the store. */
    const top = files.get("@types/node");
    expect(top).to.be.instanceOf(SymlinkFile);
    expect((top as SymlinkFile).target).to.equal("../.pkgs/node_modules/@types/node");
    expect(files.has(".pkgs/node_modules/@types/node/index.js")).to.equal(true);
  });

  it("passes non-package sources through at the top level", () => {
    const loose = new FileSet(new Map<string, IFile>([["loose.js", MemoryFile.from("x")]]));
    const files = entries(assembleScopedNodeModules([pkg("tar-stream"), loose]));
    expect(files.has("loose.js")).to.equal(true);
  });

  it("reports two different packages under one name in the closure as a package conflict", () => {
    /* Two NON-override instances disagreeing is two deliveries resolved apart
     * (a local package's closure vs this collection's): hoisting one would
     * silently hand the other's requirers a version their resolution never
     * chose, so the error must name the packages — not the raw store-file
     * collision the union would otherwise trip over. */
    const a = vpkg("a", "1.0.0", [vpkg("shared", "1.0.0")]);
    const b = vpkg("b", "1.0.0", [vpkg("shared", "2.0.0")]);
    expect(() => assembleScopedNodeModules([a, b])).to.throw(ConflictError, /Conflicting packages for shared/);
  });

  it("nests a delivered override instance under its requirer instead of conflicting", () => {
    /* The sanctioned-divergence shape (a '?' alternate's fork): the winner
     * holds the flat store slot; the override — flagged by the delivery — nests
     * under the requirer whose edge binds it, where node resolution finds it
     * first. */
    const fork = new PackageFileSet(
      new Map<string, IFile>([["index.js", MemoryFile.from("// shared@1")]]),
      "shared",
      "1.0.0",
      [],
      undefined,
      true
    );
    const requirer = vpkg("legacy", "1.0.0", [fork]);
    const root = vpkg("app", "1.0.0", [vpkg("shared", "2.0.0"), requirer]);
    const files = entries(assembleScopedNodeModules([root]));
    expect(files.has(".pkgs/node_modules/shared/index.js")).to.equal(true);
    expect(files.has(".pkgs/node_modules/legacy/node_modules/shared/index.js")).to.equal(true);
  });

  it("an override never takes the flat slot, even as the only instance of its name", () => {
    const fork = new PackageFileSet(
      new Map<string, IFile>([["index.js", MemoryFile.from("// only@1")]]),
      "only",
      "1.0.0",
      [],
      undefined,
      true
    );
    const requirer = vpkg("legacy", "1.0.0", [fork]);
    const files = entries(assembleScopedNodeModules([vpkg("app", "1.0.0", [requirer])]));
    expect(files.has(".pkgs/node_modules/only/index.js")).to.equal(false);
    expect(files.has(".pkgs/node_modules/legacy/node_modules/only/index.js")).to.equal(true);
  });
});

describe("assembling delivered edge-binding graphs", () => {
  /** A delivered closure from a literal `id -> {name: id}` graph — complete
   * edge bindings, cycles allowed — built the way NPMRepository.buildClosure
   * builds one: an instance per (name, selection) wired through the graph
   * builder, an aliased edge restamped with the requirer's name for it. */
  function delivered(edges: Record<string, Record<string, string>>, rootId: string, forks: string[] = []): PackageFileSet {
    const builder = new PackageGraphBuilder();
    const instances = new Map<string, PackageFileSet>();
    const instance = (name: string, id: string): PackageFileSet => {
      const key = `${name}\n${id}`;
      let node = instances.get(key);
      if (!node) {
        node = builder.node(
          new Map<string, IFile>([["index.js", MemoryFile.from(`// ${id}`)]]),
          name,
          id.substring(id.lastIndexOf("@") + 1),
          undefined,
          forks.includes(id)
        );
        instances.set(key, node);
        builder.wire(
          node,
          Object.entries(edges[id] ?? {}).map(([depName, toId]) => instance(depName, toId))
        );
      }
      return node;
    };
    const root = instance(rootId.substring(0, rootId.lastIndexOf("@")), rootId);
    builder.seal();
    return root;
  }

  async function contentAt(files: Map<string, IFile>, path: string): Promise<string> {
    const file = files.get(path);
    expect(file, path).to.not.equal(undefined);
    return settle(file!.readString());
  }

  it("nests each divergent edge under its requirer (the mdn-data shape)", async () => {
    /* csso needs css-tree@2 where the flat winner is @3, and that copy needs
     * mdn-data@2.0.28 where the winner is @2.12.2. */
    const root = delivered(
      {
        "svgo@4.0.1": { csso: "csso@5.0.5", "css-tree": "css-tree@3.0.1", "mdn-data": "mdn-data@2.12.2" },
        "csso@5.0.5": { "css-tree": "css-tree@2.2.0" },
        "css-tree@2.2.0": { "mdn-data": "mdn-data@2.0.28" },
        "css-tree@3.0.1": { "mdn-data": "mdn-data@2.12.2" },
        "mdn-data@2.12.2": {},
        "mdn-data@2.0.28": {},
      },
      "svgo@4.0.1"
    );
    const files = entries(assembleNodeModules([root]));
    expect(await contentAt(files, "css-tree/index.js")).to.equal("// css-tree@3.0.1");
    expect(await contentAt(files, "csso/node_modules/css-tree/index.js")).to.equal("// css-tree@2.2.0");
    expect(await contentAt(files, "csso/node_modules/css-tree/node_modules/mdn-data/index.js")).to.equal("// mdn-data@2.0.28");
    expect(await contentAt(files, "mdn-data/index.js")).to.equal("// mdn-data@2.12.2");
  });

  it("keeps a member's requirement across a merge with a sibling delivery (the parse5/entities shape)", async () => {
    /* jsdom's delivery alone hoists entities@4.5.0 flat; merged with a sibling
     * carrying entities@6.0.0 the batch winner changes — and parse5's edge
     * still binds 4.5.0, so the layout decided HERE nests its copy privately.
     * (The pruned encoding decided this per delivery, and lost it.) */
    const jsdom = delivered(
      {
        "jsdom@26.1.0": { parse5: "parse5@7.2.1" },
        "parse5@7.2.1": { entities: "entities@4.5.0" },
        "entities@4.5.0": {},
      },
      "jsdom@26.1.0"
    );
    const other = delivered({ "webby@1.0.0": { entities: "entities@6.0.0" }, "entities@6.0.0": {} }, "webby@1.0.0");
    const files = entries(assembleNodeModules([jsdom, other]));
    expect(await contentAt(files, "entities/index.js")).to.equal("// entities@6.0.0");
    expect(await contentAt(files, "parse5/node_modules/entities/index.js")).to.equal("// entities@4.5.0");
    /* And standing alone, the very same delivery needs no nest at all. */
    const alone = entries(assembleNodeModules([delivered(
      {
        "jsdom@26.1.0": { parse5: "parse5@7.2.1" },
        "parse5@7.2.1": { entities: "entities@4.5.0" },
        "entities@4.5.0": {},
      },
      "jsdom@26.1.0"
    )]));
    expect(await contentAt(alone, "entities/index.js")).to.equal("// entities@4.5.0");
    expect(alone.has("parse5/node_modules/entities/index.js")).to.equal(false);
  });

  it("mounts a root's own divergent edge under the root (the two-mounts shape)", async () => {
    /* DESIGN-package-placement.md bug 2: the root requires uuid@^8 while its
     * closure's flat winner is uuid@9 — the pruned encoding emitted both a
     * winner mount and a root override under one name and conflicted; from
     * complete bindings it is an ordinary private nest. */
    const root = delivered(
      {
        "root@1.0.0": { uuid: "uuid@8.3.2", other: "other@1.0.0" },
        "other@1.0.0": { uuid: "uuid@9.0.0" },
        "uuid@8.3.2": {},
        "uuid@9.0.0": {},
      },
      "root@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    expect(await contentAt(files, "uuid/index.js")).to.equal("// uuid@9.0.0");
    expect(await contentAt(files, "root/node_modules/uuid/index.js")).to.equal("// uuid@8.3.2");
  });

  it("lays out an ordinary dependency cycle flat", () => {
    /* a ↔ b at one version each: complete bindings make the cycle explicit in
     * the delivered graph; nothing diverges, so nothing nests. */
    const root = delivered({ "a@1.0.0": { b: "b@1.0.0" }, "b@1.0.0": { a: "a@1.0.0" } }, "a@1.0.0");
    const files = entries(assembleNodeModules([root]));
    expect(files.has("a/index.js")).to.equal(true);
    expect(files.has("b/index.js")).to.equal(true);
  });

  it("nests a cyclic pair of private copies without recursing forever", async () => {
    /* Two fork copies requiring each other: each nests once under the
     * requirer that diverges, and the bindings they introduce terminate the
     * recursion (a member's edge back to an already-bound name is not a
     * divergence). */
    const root = delivered(
      {
        "app@1.0.0": { legacy: "legacy@1.0.0", a: "a@2.0.0", b: "b@2.0.0" },
        "legacy@1.0.0": { a: "a@1.0.0" },
        "a@1.0.0": { b: "b@1.0.0" },
        "b@1.0.0": { a: "a@1.0.0" },
        "a@2.0.0": {},
        "b@2.0.0": {},
      },
      "app@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    expect(await contentAt(files, "a/index.js")).to.equal("// a@2.0.0");
    expect(await contentAt(files, "legacy/node_modules/a/index.js")).to.equal("// a@1.0.0");
    expect(await contentAt(files, "legacy/node_modules/a/node_modules/b/index.js")).to.equal("// b@1.0.0");
  });

  it("reports a cross-generation version cycle instead of nesting forever", () => {
    /* a@1 → b@1 → a@2 → b@2 → a@1: each hop needs a version other than the one
     * visible where it sits and each nesting is forced, so no finite tree
     * satisfies every edge — judged here, at the merge that needs a tree. */
    const root = delivered(
      {
        "a@1.0.0": { b: "b@1.0.0" },
        "b@1.0.0": { a: "a@2.0.0" },
        "a@2.0.0": { b: "b@2.0.0" },
        "b@2.0.0": { a: "a@1.0.0" },
      },
      "a@1.0.0"
    );
    const err = (() => {
      try {
        assembleNodeModules([root]);
        return undefined;
      } catch (thrown) {
        return thrown as Error & { help?: string };
      }
    })();
    expect(err?.message).to.contain("Cannot lay out this dependency closure");
    /* The full named chain, so a mis-sliced cycle path can't pass. */
    expect(err?.message).to.contain("a@1.0.0 -> b@1.0.0 -> a@2.0.0 -> b@2.0.0 -> a@1.0.0");
    expect(err?.help).to.contain("'@npm:a:<version>' or '@npm:b:<version>'");
  });

  it("mounts an aliased dependency under the alias, and only there", async () => {
    /* The @isaacs/cliui shape: the aliased edge binds a restamped instance —
     * the alias IS its packageName — so it competes for (and here wins) the
     * alias name, never the package's own. */
    const root = delivered(
      {
        "cli@1.0.0": { "@isaacs/cliui": "@isaacs/cliui@8.0.2", "wrap-ansi": "wrap-ansi@8.1.0" },
        "@isaacs/cliui@8.0.2": { "wrap-ansi-cjs": "wrap-ansi@7.0.0" },
        "wrap-ansi@8.1.0": {},
        "wrap-ansi@7.0.0": {},
      },
      "cli@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    expect([...files.keys()].filter(name => name.includes("wrap-ansi")).sort()).to.deep.equal([
      "wrap-ansi-cjs/index.js",
      "wrap-ansi/index.js",
    ]);
    expect(await contentAt(files, "wrap-ansi/index.js")).to.equal("// wrap-ansi@8.1.0");
    expect(await contentAt(files, "wrap-ansi-cjs/index.js")).to.equal("// wrap-ansi@7.0.0");
  });

  it("nests an alias mount privately when its name is won by another version", async () => {
    /* Two requirers aliasing one name to different versions: the alias behaves
     * exactly like a package name — one wins the flat mount, the other nests
     * under the requirer that diverges. */
    const root = delivered(
      {
        "root@1.0.0": { a: "a@1.0.0", b: "b@1.0.0" },
        "a@1.0.0": { "wa-cjs": "wrap-ansi@7.0.0" },
        "b@1.0.0": { "wa-cjs": "wrap-ansi@6.0.0" },
        "wrap-ansi@7.0.0": {},
        "wrap-ansi@6.0.0": {},
      },
      "root@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    expect(await contentAt(files, "wa-cjs/index.js")).to.equal("// wrap-ansi@7.0.0");
    expect(await contentAt(files, "b/node_modules/wa-cjs/index.js")).to.equal("// wrap-ansi@6.0.0");
  });

  it("restamps an alias instance with the name it is delivered under", () => {
    /* The delivered instance IS a package of that name as far as the install
     * is concerned (npm's node_modules/wrap-ansi-cjs, whose package.json still
     * says wrap-ansi) — the content is the aliased package's. */
    const root = delivered({ "cli@1.0.0": { "wrap-ansi-cjs": "wrap-ansi@7.0.0" }, "wrap-ansi@7.0.0": {} }, "cli@1.0.0");
    const [mounted] = root.dependencies;
    expect(mounted).to.be.instanceOf(PackageFileSet);
    expect((mounted as PackageFileSet).packageName).to.equal("wrap-ansi-cjs");
    expect((mounted as PackageFileSet).version).to.equal("7.0.0");
  });

  it("lays out the same deliveries identically regardless of arrival order", () => {
    /* Canonical determinism is a hard requirement — the assembled tree is an
     * action input, so the same graphs must yield a byte-identical layout
     * however the collection point happened to order them: deliveries
     * reversed, and a node's edges declared in a different order. Compared as
     * manifests (hash + mode + sorted names) — the actual cache-key surface. */
    const jsdomGraph = {
      "jsdom@26.1.0": { parse5: "parse5@7.2.1" },
      "parse5@7.2.1": { entities: "entities@4.5.0" },
      "entities@4.5.0": {},
    };
    const webbyGraph = { "webby@1.0.0": { entities: "entities@6.0.0" }, "entities@6.0.0": {} };
    const forward = assembleNodeModules([delivered(jsdomGraph, "jsdom@26.1.0"), delivered(webbyGraph, "webby@1.0.0")]);
    const backward = assembleNodeModules([delivered(webbyGraph, "webby@1.0.0"), delivered(jsdomGraph, "jsdom@26.1.0")]);
    expect(backward.toManifest()).to.equal(forward.toManifest());

    const svgoGraph = {
      "svgo@4.0.1": { csso: "csso@5.0.5", "css-tree": "css-tree@3.0.1", "mdn-data": "mdn-data@2.12.2" },
      "csso@5.0.5": { "css-tree": "css-tree@2.2.0" },
      "css-tree@2.2.0": { "mdn-data": "mdn-data@2.0.28" },
      "css-tree@3.0.1": { "mdn-data": "mdn-data@2.12.2" },
      "mdn-data@2.12.2": {},
      "mdn-data@2.0.28": {},
    };
    const svgoReversed = {
      "mdn-data@2.0.28": {},
      "mdn-data@2.12.2": {},
      "css-tree@3.0.1": { "mdn-data": "mdn-data@2.12.2" },
      "css-tree@2.2.0": { "mdn-data": "mdn-data@2.0.28" },
      "csso@5.0.5": { "css-tree": "css-tree@2.2.0" },
      "svgo@4.0.1": { "mdn-data": "mdn-data@2.12.2", "css-tree": "css-tree@3.0.1", csso: "csso@5.0.5" },
    };
    const declared = assembleNodeModules([delivered(svgoGraph, "svgo@4.0.1")]);
    const permuted = assembleNodeModules([delivered(svgoReversed, "svgo@4.0.1")]);
    expect(permuted.toManifest()).to.equal(declared.toManifest());
  });

  it("re-mounts the flat winner beneath an override that would otherwise shadow it", async () => {
    /* m carries private copies of x AND leaf; its leaf@1 in turn needs x@2 —
     * the flat winner — but from leaf@1's position the override x@1 shadows
     * it, so x@2 must mount again under leaf@1, and (binding nothing new)
     * drops back out of the child bindings: the canonicalization rule. */
    const root = delivered(
      {
        "root@1.0.0": { m: "m@1.0.0", x: "x@2.0.0", leaf: "leaf@2.0.0" },
        "m@1.0.0": { x: "x@1.0.0", leaf: "leaf@1.0.0" },
        "leaf@1.0.0": { x: "x@2.0.0" },
        "x@1.0.0": {},
        "x@2.0.0": {},
        "leaf@2.0.0": {},
      },
      "root@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    expect(await contentAt(files, "x/index.js")).to.equal("// x@2.0.0");
    expect(await contentAt(files, "m/node_modules/x/index.js")).to.equal("// x@1.0.0");
    expect(await contentAt(files, "m/node_modules/leaf/index.js")).to.equal("// leaf@1.0.0");
    expect(await contentAt(files, "m/node_modules/leaf/node_modules/x/index.js")).to.equal("// x@2.0.0");
  });

  it("rejects two batches disagreeing about one packageId (one id is one node)", () => {
    /* Two independently-resolved batches may deliver the same name@version
     * with DIFFERENT edges (one batch cannot — its edges are a function of
     * the joint resolution). The merge resolves ids, not instances, so a
     * disagreement would be settled by traversal order rather than by any
     * decision: a conflict carrying both sides' provenance, never a pick. */
    const batchA = delivered(
      { "rootA@1.0.0": { p: "p@1.0.0" }, "p@1.0.0": { x: "x@1.0.0" }, "x@1.0.0": {} },
      "rootA@1.0.0"
    );
    const batchB = delivered(
      { "rootB@1.0.0": { p: "p@1.0.0" }, "p@1.0.0": { x: "x@2.0.0" }, "x@2.0.0": {} },
      "rootB@1.0.0"
    );
    expect(() => assembleNodeModules([batchA, batchB])).to.throw(ConflictError, /p@1\.0\.0/);
  });

  it("makes a delivered graph runnable with its nested override in the install", async () => {
    /* The standalone sealed-runnable case: under the old encoding a runnable
     * leaned on the delivery's baked hoist; now the same assembler decides
     * its layout from the edge bindings — including a back-edge into the
     * root (a cycle) and a root edge diverging from the install's winner. */
    const builder = new PackageGraphBuilder();
    const tool = builder.node(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(JSON.stringify({ name: "tool", version: "1.0.0", bin: { tool: "bin/tool.js" } }))],
        ["bin/tool.js", MemoryFile.from("#!/usr/bin/env node\n")],
      ]),
      "tool",
      "1.0.0"
    );
    const helper1 = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// helper@1.0.0")]]), "helper", "1.0.0");
    const helper2 = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// helper@2.0.0")]]), "helper", "2.0.0");
    const other = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// other@1.0.0")]]), "other", "1.0.0");
    builder.wire(tool, [helper1, other]);
    builder.wire(other, [helper2, tool]);
    builder.seal();

    const runnable = await settle(makeNpmRunnable(tool));
    const install = entries(runnable);
    expect(install.has("node_modules/tool/bin/tool.js")).to.equal(true);
    expect(await contentAt(install, "node_modules/helper/index.js")).to.equal("// helper@2.0.0");
    expect(await contentAt(install, "node_modules/tool/node_modules/helper/index.js")).to.equal("// helper@1.0.0");
    expect(await contentAt(install, "node_modules/other/index.js")).to.equal("// other@1.0.0");
  });
});


describe("assembleNodeModules", () => {
  it("mounts a single-version closure flat, as always", () => {
    const dep = pkg("b4a");
    const root = pkg("tar-stream", [dep]);
    const files = entries(assembleNodeModules([root]));
    expect(files.has("tar-stream/index.js")).to.equal(true);
    expect(files.has("b4a/index.js")).to.equal(true);
  });

  it("nests listed version overrides under their requirer (the mdn-data shape)", async () => {
    /* svgo's delivered closure: winners flat (css-tree@3, mdn-data@2.12.2,
     * csso), with csso carrying its private css-tree@2, which carries its
     * private mdn-data@2.0.28 — the in-memory node_modules tree. */
    const mdnOld = vpkg("mdn-data", "2.0.28");
    const cssTree2 = vpkg("css-tree", "2.2.0", [mdnOld]);
    const csso = vpkg("csso", "5.0.5", [cssTree2]);
    const mdnNew = vpkg("mdn-data", "2.12.2");
    const cssTree3 = vpkg("css-tree", "3.0.1");
    const root = vpkg("svgo", "4.0.1", [mdnNew, cssTree3, csso]);
    const files = entries(assembleNodeModules([root]));

    /* Winners flat... */
    const flatCss = await settle(files.get("css-tree/index.js")!.readString());
    expect(flatCss).to.equal("// css-tree@3.0.1");
    const flatMdn = await settle(files.get("mdn-data/index.js")!.readString());
    expect(flatMdn).to.equal("// mdn-data@2.12.2");
    /* ...csso resolves css-tree to its private @2 copy... */
    const nestedCss = await settle(files.get("csso/node_modules/css-tree/index.js")!.readString());
    expect(nestedCss).to.equal("// css-tree@2.2.0");
    /* ...which resolves mdn-data to ITS private 2.0.28. */
    const nestedMdn = await settle(files.get("csso/node_modules/css-tree/node_modules/mdn-data/index.js")!.readString());
    expect(nestedMdn).to.equal("// mdn-data@2.0.28");
  });

  it("skips a listed dep that is the flat winner of its name (no duplicate mount)", () => {
    /* b@1 nests under a; b@1's own listed dep points back at the flat winner
     * a@1 — a winner is never nested, so the cycle-shaped structure stops.
     * A real cycle, so built through the builder (one instance per node). */
    const builder = new PackageGraphBuilder();
    const a = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// a@1.0.0")]]), "a", "1.0.0");
    const b1 = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// b@1.0.0")]]), "b", "1.0.0");
    builder.wire(a, [b1]);
    builder.wire(b1, [a]);
    builder.seal();
    const b2 = vpkg("b", "2.0.0");
    const root = vpkg("top", "1.0.0", [a, b2]);
    const files = entries(assembleNodeModules([root]));
    expect(files.has("a/node_modules/b/index.js")).to.equal(true);
    /* The nested b@1 does NOT nest a copy of a (a@1.0.0 is the flat winner). */
    expect(files.has("a/node_modules/b/node_modules/a/index.js")).to.equal(false);
  });

  it("a top-level package always wins its own name over a higher carried version", async () => {
    const transitiveNewer = vpkg("tool", "9.9.9");
    const carrier = vpkg("other", "1.0.0", [transitiveNewer]);
    const root = vpkg("tool", "1.0.0", [carrier]);
    const files = entries(assembleNodeModules([root]));
    const flat = await settle(files.get("tool/index.js")!.readString());
    expect(flat).to.equal("// tool@1.0.0");
    /* The carried newer version is not the winner, so it nests under its lister. */
    const nested = await settle(files.get("other/node_modules/tool/index.js")!.readString());
    expect(nested).to.equal("// tool@9.9.9");
  });

  it("reports two different roots sharing a name as a conflict, not a silent drop", () => {
    /* Every root was directly listed and must hold its own top-level mount —
     * two can't, and roots cannot nest the way a transitive non-winner can. */
    expect(() => assembleNodeModules([vpkg("tool", "1.0.0"), vpkg("tool", "2.0.0")])).to.throw(
      ConflictError,
      /Conflicting packages for tool/
    );
  });

  it("accepts the same-identity root arriving twice", () => {
    const files = entries(assembleNodeModules([vpkg("tool", "1.0.0"), vpkg("tool", "1.0.0")]));
    expect(files.has("tool/index.js")).to.equal(true);
  });

  /* One id must be one node: the merge resolves ids, not instances, so two
   * instances disagreeing under one id would be settled by traversal order —
   * a conflict, not a pick (and the identity-named action key relies on it). */
  it("rejects two different contents delivered under one id", () => {
    const debug = new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// debug")]]), "mylib", undefined);
    const release = new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// release")]]), "mylib", undefined);
    expect(() => assembleNodeModules([pkg("x", [debug]), pkg("y", [release])])).to.throw(ConflictError, /mylib@\*/);
  });

  it("rejects two different edge bindings under one id, contents equal", () => {
    const carrierOf = (dep: PackageFileSet): PackageFileSet =>
      new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// carrier")]]), "carrier", "1.0.0", [dep]);
    expect(() => assembleNodeModules([carrierOf(vpkg("q", "1.0.0")), carrierOf(vpkg("q", "2.0.0"))])).to.throw(ConflictError);
  });

  it("rejects a same-id disagreement in CONTENT, not just in edges", () => {
    /* One id, two different builds of it: settled by traversal order rather
     * than by any decision, so it is refused like any two-deliveries-disagree. */
    const debug = new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// debug")]]), "mylib", undefined);
    const release = new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// release")]]), "mylib", undefined);
    expect(() => assembleNodeModules([pkg("x", [debug]), pkg("y", [release])])).to.throw(ConflictError);
  });
});

/** A package whose package.json declares (or not) a `./jsx-runtime` export. */
function jsxPkg(name: string, providesJsxRuntime: boolean): PackageFileSet {
  const json = JSON.stringify({
    name,
    exports: providesJsxRuntime ? { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } : { ".": "./index.js" },
  });
  return new PackageFileSet(new Map<string, IFile>([["package.json", MemoryFile.from(json)]]), name);
}

function settle<T>(c: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => c.then(resolve, reject));
}
async function rejectionMessage<T>(c: Computable<T>): Promise<string> {
  try {
    await settle(c);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("hasPackageExport", () => {
  const manifest = (content: string): IFile => MemoryFile.from(content);

  it("detects a declared subpath in the exports map", async () => {
    const json = manifest(JSON.stringify({ exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } }));
    expect(await settle(hasPackageExport(json, "./jsx-runtime"))).to.equal(true);
    expect(await settle(hasPackageExport(json, "./missing"))).to.equal(false);
  });

  it("answers no without an exports map, or for an unreadable manifest", async () => {
    /* A question *about a dependency*: a manifest fabr can't read exposes no
       subpath — whoever builds that dependency is the one to report it. */
    expect(await settle(hasPackageExport(manifest(JSON.stringify({ main: "index.js" })), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(manifest(JSON.stringify({ exports: "./index.js" })), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(manifest("not json"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(manifest("[]"), "./jsx-runtime"))).to.equal(false);
  });
});

describe("resolveJsxImportSource", () => {
  const react = jsxPkg("react", true);
  const preact = jsxPkg("preact", true);
  const lodash = jsxPkg("lodash", false);
  /* Has the jsx-runtime export, but @types never names the runtime. */
  const reactTypes = jsxPkg("@types/react", true);

  it("names the runtime package (from package.json exports './jsx-runtime')", async () => {
    expect(await settle(resolveJsxImportSource([react]))).to.equal("react");
    expect(await settle(resolveJsxImportSource([preact]))).to.equal("preact");
  });

  it("picks the first provider in dependency order, skipping non-runtimes", async () => {
    expect(await settle(resolveJsxImportSource([lodash, react]))).to.equal("react");
  });

  it("never treats a @types package as the runtime", async () => {
    expect(await settle(resolveJsxImportSource([reactTypes, react]))).to.equal("react");
    expect(await rejectionMessage(resolveJsxImportSource([reactTypes]))).to.match(/No JSX runtime/);
  });

  it("errors when no dependency provides a JSX runtime", async () => {
    expect(await rejectionMessage(resolveJsxImportSource([lodash]))).to.match(/No JSX runtime specified in dependencies/);
  });

  it("errors when several dependencies provide one (ambiguous)", async () => {
    expect(await rejectionMessage(resolveJsxImportSource([react, preact]))).to.match(/Multiple JSX runtimes.*react.*preact/);
  });
});

describe("parseJSTarget", () => {
  it("parses valid triples into version/module/environment", () => {
    expect(parseJSTarget("es2018-commonjs")).to.deep.equal({ version: "es2018", module: "commonjs", environment: "node" });
    expect(parseJSTarget("es2021-esm")).to.deep.equal({ version: "es2021", module: "esm", environment: "node" });
    expect(parseJSTarget("esnext-esm-browser")).to.deep.equal({ version: "esnext", module: "esm", environment: "browser" });
    expect(parseJSTarget("es2020")).to.deep.equal({ version: "es2020", module: "commonjs", environment: "node" });
  });

  it("rejects a malformed triple rather than silently mis-parsing it to the defaults", () => {
    /* 'browser' in the module slot — the old parser silently produced commonjs/node. */
    expect(() => parseJSTarget("es2020-browser")).to.throw(/module must be/);
    expect(() => parseJSTarget("es2018-esmm")).to.throw(/module must be/);
    expect(() => parseJSTarget("es2018-esm-nodejs")).to.throw(/environment must be/);
    expect(() => parseJSTarget("es2018-esm-node-extra")).to.throw(/expected/);
    expect(() => parseJSTarget("es20x8-esm")).to.throw(/ECMAScript version/);
  });
});

describe("resolveSourceMode", () => {
  it("is empty (default strict) with no flags", () => {
    expect(resolveSourceMode([])).to.deep.equal({});
  });

  it("ignores unrecognized flags (they may address other rules)", () => {
    expect(resolveSourceMode([new Flag("some/other-flag", [])])).to.deep.equal({});
  });

  it("maps a recognized flag to its compilerOptions fragment", () => {
    expect(resolveSourceMode([new Flag("ts/no_strict", [])])).to.deep.equal({ strict: false });
    expect(resolveSourceMode([new Flag("ts/allow_implicit_any", [])])).to.deep.equal({ noImplicitAny: false });
    expect(resolveSourceMode([new Flag("ts/no_es_module_interop", [])])).to.deep.equal({ esModuleInterop: false });
  });

  it("merges several flags into one overlay", () => {
    expect(resolveSourceMode([new Flag("ts/allow_implicit_any", []), new Flag("ts/no_strict_null_checks", [])])).to.deep.equal({
      noImplicitAny: false,
      strictNullChecks: false,
    });
  });

  it("walks a composite flag's provides closure", () => {
    const composite = new Flag("my/relaxed", [new Flag("ts/no_strict", []), new Flag("ts/allow_implicit_any", [])]);
    expect(resolveSourceMode([composite])).to.deep.equal({ strict: false, noImplicitAny: false });
  });

  it("relaxes one member of the strict family per flag", () => {
    expect(resolveSourceMode([new Flag("ts/allow_implicit_this", [])])).to.deep.equal({ noImplicitThis: false });
    expect(resolveSourceMode([new Flag("ts/no_use_unknown_in_catch_variables", [])])).to.deep.equal({ useUnknownInCatchVariables: false });
    expect(resolveSourceMode([new Flag("ts/no_strict_function_types", [])])).to.deep.equal({ strictFunctionTypes: false });
    expect(resolveSourceMode([new Flag("ts/no_strict_bind_call_apply", [])])).to.deep.equal({ strictBindCallApply: false });
  });

  it("keeps class fields on assignment semantics for legacy decorators", () => {
    /* A property decorator installs a prototype accessor, which the instance
     * field emitted at es2022+ shadows — so the decorator silently does nothing
     * unless the two travel together. */
    expect(resolveSourceMode([new Flag("ts/experimental_decorators", [])])).to.deep.equal({
      experimentalDecorators: true,
      useDefineForClassFields: false,
    });
  });

  it("expands ts/emit_decorator_metadata through its provides (tsc rejects it on its own)", () => {
    const metadata = new Flag("ts/emit_decorator_metadata", [new Flag("ts/experimental_decorators", [])]);
    expect(resolveSourceMode([metadata])).to.deep.equal({
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    });
  });
});

describe("esLevelOrder", () => {
  it("orders ES levels, with esnext highest", () => {
    expect(esLevelOrder("es5")).to.be.lessThan(esLevelOrder("es2015"));
    expect(esLevelOrder("es2021")).to.be.lessThan(esLevelOrder("es2022"));
    expect(esLevelOrder("es2023")).to.be.lessThan(esLevelOrder("esnext"));
  });

  it("orders es6 as es2015, tsc's alias for it", () => {
    /* Numerically es6 is 6, i.e. just above es5 — which would put the default
     * JS_TARGET below every version rule keyed on a year. */
    expect(esLevelOrder("es6")).to.equal(esLevelOrder("es2015"));
  });
});

describe("canonicalEsLevel", () => {
  it("normalizes es6 to es2015 and leaves every other level alone", () => {
    expect(canonicalEsLevel("es6")).to.equal("es2015");
    for (const level of ["es5", "es2015", "es2022", "esnext"]) {
      expect(canonicalEsLevel(level)).to.equal(level);
    }
  });

  it("canonicalizes a parsed target, so es6 and es2015 builds share one tsconfig", () => {
    expect(parseJSTarget("es6-esm-browser").version).to.equal("es2015");
    expect(parseJSTarget("es2015-esm-browser").version).to.equal("es2015");
  });

  it("canonicalizes a declared source level too", () => {
    expect(resolveSourceVersion([new Flag("es6", [])])).to.equal("es2015");
  });

  it("orders an unparseable name lowest, so it can never win a max", () => {
    expect(esLevelOrder("nonsense")).to.be.lessThan(esLevelOrder("es5"));
  });
});

describe("usesDom", () => {
  it("reads the declared flag, not the emit target", () => {
    expect(usesDom([new Flag("dom", [])])).to.equal(true);
    expect(usesDom([new Flag("es2020", [])])).to.equal(false);
    expect(usesDom([])).to.equal(false);
  });

  /* Walked through `provides` like every other source-mode flag, so a composite
   * flag ("this is a browser widget") can supply it. */
  it("finds it through a composite flag's provides", () => {
    expect(usesDom([new Flag("widget", [new Flag("dom", [])])])).to.equal(true);
  });
});

describe("makeNpmRunnable", () => {
  it("normalizes a './'-prefixed package.json bin path in the surface symlink", async () => {
    const json = JSON.stringify({ name: "typescript", version: "5.4.5", bin: { tsc: "./bin/tsc" } });
    const pkg = new PackageFileSet(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(json)],
        ["bin/tsc", MemoryFile.from("#!/usr/bin/env node\n")],
      ]),
      "typescript",
      "5.4.5"
    );
    const runnable = await settle(makeNpmRunnable(pkg));
    /* The bin command 'tsc' resolves to a SymlinkFile whose target has no stray
     * '/./' — otherwise the same-install-path dedup at launch sees two entries. */
    const link = new Map(runnable.surface).get("tsc");
    expect(link).to.be.instanceOf(SymlinkFile);
    expect((link as SymlinkFile).target).to.equal("node_modules/typescript/bin/tsc");
  });
});

describe("withBinShebangs", () => {
  async function shebang(files: Record<string, string>): Promise<Map<string, IFile>> {
    const set = new FileSet(new Map(Object.entries(files).map(([name, body]) => [name, MemoryFile.from(body)])));
    return entries(await settle(withBinShebangs(set)));
  }
  const body = (file: IFile | undefined): Promise<string> => settle(file!.readString());

  it("prepends a node shebang to a convention bin that lacks one", async () => {
    const out = await shebang({ "bin/fabr.js": "require('../index');\n" });
    expect(await body(out.get("bin/fabr.js"))).to.equal("#!/usr/bin/env node\nrequire('../index');\n");
  });

  it("leaves a bin that already has a shebang untouched (no double)", async () => {
    const original = "#!/usr/bin/env node\nrun();\n";
    const out = await shebang({ "bin/fabr.js": original });
    expect(await body(out.get("bin/fabr.js"))).to.equal(original);
  });

  it("respects a bundled bin's own interpreter line", async () => {
    const original = "#!/bin/sh\necho hi\n";
    const out = await shebang({ "bin/tool.sh": original });
    expect(await body(out.get("bin/tool.sh"))).to.equal(original);
  });

  it("touches only files under bin/, and skips .d.ts / .map siblings", async () => {
    const out = await shebang({
      "bin/cli.js": "x\n",
      "bin/cli.d.ts": "export {};\n",
      "bin/cli.js.map": "{}\n",
      "index.js": "y\n",
    });
    expect(await body(out.get("bin/cli.js"))).to.equal("#!/usr/bin/env node\nx\n");
    expect(await body(out.get("bin/cli.d.ts"))).to.equal("export {};\n");
    expect(await body(out.get("bin/cli.js.map"))).to.equal("{}\n");
    expect(await body(out.get("index.js"))).to.equal("y\n");
  });
});

describe("binOf", () => {
  /* package.json is untrusted content from an arbitrary package: bin commands
   * and targets must never carry path structure out of the package. */
  function pkgWithBin(bin: unknown): PackageFileSet {
    const json = JSON.stringify({ name: "tool", version: "1.0.0", bin });
    return new PackageFileSet(new Map<string, IFile>([["package.json", MemoryFile.from(json)]]), "tool", "1.0.0");
  }

  it("uses only the basename of a bin command key (npm's rule)", async () => {
    const bins = await settle(binOf(pkgWithBin({ "nested/dir/tool-cli": "lib/cli.js" })));
    expect([...bins]).to.deep.equal([["tool-cli", "lib/cli.js"]]);
  });

  it("reads a bin of any other shape as no bin (npm normalizes those away)", async () => {
    expect([...(await settle(binOf(pkgWithBin(["lib/cli.js"]))))]).to.deep.equal([]);
    expect([...(await settle(binOf(pkgWithBin(42))))]).to.deep.equal([]);
    expect([...(await settle(binOf(pkgWithBin(undefined))))]).to.deep.equal([]);
  });

  it("rejects a bin target that is not a string", async () => {
    expect(await rejectionMessage(binOf(pkgWithBin({ tool: { path: "lib/cli.js" } })))).to.match(/invalid bin target/);
  });

  it("rejects a bin command that reduces to no name", async () => {
    expect(await rejectionMessage(binOf(pkgWithBin({ "..": "lib/cli.js" })))).to.match(/invalid bin name/);
  });

  it("rejects a bin target escaping the package", async () => {
    /* Judged by the canonical-name rule, but with error-not-flatten semantics:
     * a repaired escape would silently re-point the bin inside the package. */
    expect(await rejectionMessage(binOf(pkgWithBin({ tool: "../../outside.js" })))).to.match(/invalid bin target/);
    expect(await rejectionMessage(binOf(pkgWithBin({ tool: "/etc/passwd" })))).to.match(/invalid bin target/);
  });
});

describe("classifySourceByExt", () => {
  it("compiles the module-flavoured TypeScript spellings", () => {
    /* Routed to js_compile, not shipped verbatim as a resource. */
    expect(classifySourceByExt("src/a.mts")).to.equal("ts");
    expect(classifySourceByExt("src/a.cts")).to.equal("ts");
    expect(classifySourceByExt("src/a.mjs")).to.equal("js");
    expect(classifySourceByExt("src/a.cjs")).to.equal("js");
  });

  it("treats their declaration forms as declarations", () => {
    expect(classifySourceByExt("src/a.d.mts")).to.equal("dts");
    expect(classifySourceByExt("src/a.d.cts")).to.equal("dts");
  });

  it("still copies anything tsc neither compiles nor emits", () => {
    expect(classifySourceByExt("src/run.sh")).to.equal("copy");
    expect(classifySourceByExt("src/logo.png")).to.equal("copy");
  });

  /* JSON is a compile input as well as a resource: js_compile sets
   * resolveJsonModule, so tsc types `import cfg from "./x.json"` from the real
   * document — which it can only do if the document is in the compile tree. */
  it("gives json its own kind, so it both compiles and ships", () => {
    expect(classifySourceByExt("src/data.json")).to.equal("json");
    const sources = classifySources(new FileSet(new Map<string, IFile>([["src/data.json", MemoryFile.from("{}")]])));
    expect([...compileInputs(sources)].map(([name]) => name)).to.deep.equal(["src/data.json"]);
    expect([...passthroughFiles(sources)].map(([name]) => name)).to.deep.equal(["src/data.json"]);
  });
});

describe("binByConvention", () => {
  const contents = (...names: string[]): FileSet =>
    new FileSet(new Map<string, IFile>(names.map(name => [name, MemoryFile.from(`// ${name}`)])));

  it("names each bin after its file (extension stripped), ignoring anything outside bin/", () => {
    expect([...binByConvention(contents("bin/fabr.js", "bin/tool.sh", "lib/x.js"))]).to.deep.equal([
      ["fabr", "bin/fabr.js"],
      ["tool", "bin/tool.sh"],
    ]);
  });

  it("skips the emitted declaration and map siblings", () => {
    expect([...binByConvention(contents("bin/fabr.js", "bin/fabr.d.ts", "bin/fabr.js.map"))]).to.deep.equal([
      ["fabr", "bin/fabr.js"],
    ]);
  });

  it("reports two bins claiming one command as a conflict, naming both files", () => {
    let caught: ConflictError | undefined;
    try {
      binByConvention(contents("bin/x.js", "bin/x.sh"));
    } catch (err) {
      caught = err as ConflictError;
    }
    expect(caught).to.be.instanceOf(ConflictError);
    expect(caught!.key).to.equal("x");
    expect([caught!.left.detail, caught!.right.detail]).to.deep.equal(["bin/x.js", "bin/x.sh"]);
  });
});
