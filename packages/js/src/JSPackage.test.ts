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

import { posix } from "path";
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
import { referenceOf } from "./PnPManifest";
import {
  assembleNodeModules,
  binByConvention,
  binOf,
  canonicalEsLevel,
  classifySourceByExt,
  classifySources,
  compileInputs,
  dualFormatOutputs,
  esLevelOrder,
  hasPackageExport,
  makeNpmRunnable,
  parseJSTarget,
  passthroughFiles,
  resolveJsxImportSource,
  resolveSourceMode,
  resolveSourceVersion,
  usesDom,
  usesNodeGlobals,
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

/** The directory a path names in an assembled tree, links followed. */
function realPath(files: Map<string, IFile>, path: string): string {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const link = files.get(prefix);
    if (link instanceof SymlinkFile) {
      return realPath(files, posix.join(posix.dirname(prefix), link.target, ...parts.slice(i)));
    }
  }
  return path;
}

/** Where `name` resolves from the directory `from` of an assembled
 * node_modules tree (`""` is the tree's top), as node's walk up finds it. */
function resolveFrom(files: Map<string, IFile>, from: string, name: string): string | undefined {
  const present = (dir: string): boolean => files.has(dir) || [...files.keys()].some(key => key.startsWith(`${dir}/`));
  for (let dir = from; ; dir = posix.dirname(dir)) {
    const top = dir === "" || dir === ".";
    const candidate = top ? name : posix.basename(dir) === "node_modules" ? `${dir}/${name}` : `${dir}/node_modules/${name}`;
    if (present(candidate)) {
      return realPath(files, candidate);
    }
    if (top) {
      return undefined;
    }
  }
}

/** The `index.js` content reached by importing each of `names` in turn,
 * starting from the top of the tree. */
async function imported(files: Map<string, IFile>, ...names: string[]): Promise<string | undefined> {
  let dir: string | undefined = "";
  for (const name of names) {
    dir = resolveFrom(files, dir, name);
    if (dir === undefined) {
      return undefined;
    }
  }
  return settle(files.get(`${dir}/index.js`)!.readString());
}

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

  it("gives each requirer the version its edge binds (the mdn-data shape)", async () => {
    /* csso needs css-tree@2 where svgo itself uses @3, and that copy needs
     * mdn-data@2.0.28 where the others use @2.12.2. */
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
    expect(await imported(files, "svgo", "css-tree")).to.equal("// css-tree@3.0.1");
    expect(await imported(files, "svgo", "csso", "css-tree")).to.equal("// css-tree@2.2.0");
    expect(await imported(files, "svgo", "csso", "css-tree", "mdn-data")).to.equal("// mdn-data@2.0.28");
    expect(await imported(files, "svgo", "css-tree", "mdn-data")).to.equal("// mdn-data@2.12.2");
  });

  it("installs an instance once however many packages require it (the pg shape)", async () => {
    /* The app, its ORM and the pool all bind pg@8.11.3 while one other package
     * binds 8.12.0: the three load ONE directory, so module state is shared. */
    const root = delivered(
      {
        "app@1.0.0": { pg: "pg@8.11.3", orm: "orm@1.0.0", pool: "pool@1.0.0", saver: "saver@1.0.0" },
        "orm@1.0.0": { pg: "pg@8.11.3" },
        "pool@1.0.0": { pg: "pg@8.11.3" },
        "saver@1.0.0": { pg: "pg@8.12.0" },
        "pg@8.11.3": {},
        "pg@8.12.0": {},
      },
      "app@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    const app = resolveFrom(files, "", "app")!;
    const viaApp = resolveFrom(files, app, "pg");
    expect(viaApp).to.equal(".fabr/pg@8.11.3/node_modules/pg");
    expect(resolveFrom(files, resolveFrom(files, app, "orm")!, "pg")).to.equal(viaApp);
    expect(resolveFrom(files, resolveFrom(files, app, "pool")!, "pg")).to.equal(viaApp);
    expect(resolveFrom(files, resolveFrom(files, app, "saver")!, "pg")).to.equal(".fabr/pg@8.12.0/node_modules/pg");
    expect([...files.keys()].filter(name => name.endsWith("/pg/index.js"))).to.have.lengthOf(2);
  });

  it("keeps a member's requirement across a merge with a sibling delivery (the parse5/entities shape)", async () => {
    const jsdomGraph = {
      "jsdom@26.1.0": { parse5: "parse5@7.2.1" },
      "parse5@7.2.1": { entities: "entities@4.5.0" },
      "entities@4.5.0": {},
    };
    const other = delivered({ "webby@1.0.0": { entities: "entities@6.0.0" }, "entities@6.0.0": {} }, "webby@1.0.0");
    const files = entries(assembleNodeModules([delivered(jsdomGraph, "jsdom@26.1.0"), other]));
    expect(await imported(files, "webby", "entities")).to.equal("// entities@6.0.0");
    expect(await imported(files, "jsdom", "parse5", "entities")).to.equal("// entities@4.5.0");
  });

  it("gives a root its own edge where its closure uses another version (the two-mounts shape)", async () => {
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
    expect(await imported(files, "root", "uuid")).to.equal("// uuid@8.3.2");
    expect(await imported(files, "root", "other", "uuid")).to.equal("// uuid@9.0.0");
  });

  it("lays out an ordinary dependency cycle", async () => {
    const root = delivered({ "a@1.0.0": { b: "b@1.0.0" }, "b@1.0.0": { a: "a@1.0.0" } }, "a@1.0.0");
    const files = entries(assembleNodeModules([root]));
    expect(await imported(files, "a", "b", "a", "b")).to.equal("// b@1.0.0");
    expect([...files.keys()].filter(name => name.endsWith("/index.js"))).to.have.lengthOf(2);
  });

  it("lays out a cross-generation version cycle, which no nesting can", async () => {
    /* a@1 → b@1 → a@2 → b@2 → a@1: each hop needs a version other than the one
     * its requirer sees. Four directories and four links. */
    const root = delivered(
      {
        "a@1.0.0": { b: "b@1.0.0" },
        "b@1.0.0": { a: "a@2.0.0" },
        "a@2.0.0": { b: "b@2.0.0" },
        "b@2.0.0": { a: "a@1.0.0" },
      },
      "a@1.0.0"
    );
    const files = entries(assembleNodeModules([root]));
    expect(await imported(files, "a")).to.equal("// a@1.0.0");
    expect(await imported(files, "a", "b")).to.equal("// b@1.0.0");
    expect(await imported(files, "a", "b", "a")).to.equal("// a@2.0.0");
    expect(await imported(files, "a", "b", "a", "b")).to.equal("// b@2.0.0");
    expect(await imported(files, "a", "b", "a", "b", "a")).to.equal("// a@1.0.0");
    expect([...files.keys()].filter(name => name.endsWith("/index.js"))).to.have.lengthOf(4);
  });

  it("links an aliased dependency under the alias, and only there", async () => {
    /* The @isaacs/cliui shape: the aliased edge binds a restamped instance —
     * the alias IS its packageName. */
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
    expect(await imported(files, "cli", "wrap-ansi")).to.equal("// wrap-ansi@8.1.0");
    expect(await imported(files, "cli", "@isaacs/cliui", "wrap-ansi-cjs")).to.equal("// wrap-ansi@7.0.0");
    /* A scoped name's instance directory has no separator in it, and its links
     * climb the extra level. */
    expect(files.has(".fabr/@isaacs+cliui@8.0.2/node_modules/@isaacs/cliui/index.js")).to.equal(true);
    expect((files.get(".fabr/cli@1.0.0/node_modules/@isaacs/cliui") as SymlinkFile).target).to.equal(
      "../../../@isaacs+cliui@8.0.2/node_modules/@isaacs/cliui"
    );
  });

  it("gives two requirers aliasing one name to different versions each their own", async () => {
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
    expect(await imported(files, "root", "a", "wa-cjs")).to.equal("// wrap-ansi@7.0.0");
    expect(await imported(files, "root", "b", "wa-cjs")).to.equal("// wrap-ansi@6.0.0");
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

  /* Two independently-resolved batches delivering one name@version with
   * DIFFERENT edges — which a single batch cannot produce, its edges being a
   * function of the joint resolution. Two nodes, one id. */
  const disagreeingBatches = (): PackageFileSet[] => [
    delivered({ "rootA@1.0.0": { p: "p@1.0.0" }, "p@1.0.0": { x: "x@1.0.0" }, "x@1.0.0": {} }, "rootA@1.0.0"),
    delivered({ "rootB@1.0.0": { p: "p@1.0.0" }, "p@1.0.0": { x: "x@2.0.0" }, "x@2.0.0": {} }, "rootB@1.0.0"),
  ];

  it("installs one package wired two ways as two instances", async () => {
    /* p@1.0.0 depends on x@1 in one batch and x@2 in the other: one package,
     * two directories told apart by a suffix, each seeing its own x. */
    const files = entries(assembleNodeModules(disagreeingBatches()));
    expect(await imported(files, "rootA", "p", "x")).to.equal("// x@1.0.0");
    expect(await imported(files, "rootB", "p", "x")).to.equal("// x@2.0.0");
    const instances = [...files.keys()].filter(name => name.endsWith("/node_modules/p/index.js"));
    expect(instances).to.have.lengthOf(2);
    for (const name of instances) {
      expect(name).to.match(/^\.fabr\/p@1\.0\.0_[0-9a-f]{12}\/node_modules\/p\/index\.js$/);
    }
  });

  it("is deterministic about how the wirings of one package are named", () => {
    const layout = (batches: PackageFileSet[]): string => assembleNodeModules(batches).toManifest();
    expect(layout(disagreeingBatches().reverse())).to.equal(layout(disagreeingBatches()));
  });

  it("still refuses two packages of different content under one packageId", () => {
    const one = delivered({ "rootA@1.0.0": { p: "p@1.0.0" } }, "rootA@1.0.0");
    const other = new PackageGraphBuilder();
    const root = other.node(new Map<string, IFile>([["index.js", MemoryFile.from("// rootB@1.0.0")]]), "rootB", "1.0.0");
    const p = other.node(new Map<string, IFile>([["index.js", MemoryFile.from("// a different p")]]), "p", "1.0.0");
    other.wire(root, [p]);
    other.wire(p, []);
    other.seal();
    expect(() => assembleNodeModules([one, root])).to.throw(ConflictError, /p/);
  });

  it("still NAMES the same delivery, because references need no tree", () => {
    /* A report can span surfaces that never co-resolved, where two nodes under
     * one id is an ordinary fact about two deliveries — and a node's reference
     * is its own signature, so it exists whatever layout does. */
    const batches = disagreeingBatches();
    const pOf = (root: PackageFileSet): PackageFileSet =>
      [...root.dependencies].find((dep): dep is PackageFileSet => dep instanceof PackageFileSet && dep.packageName === "p")!;
    expect(referenceOf(pOf(batches[0])), "the two p nodes get distinct references").to.not.equal(
      referenceOf(pOf(batches[1]))
    );
  });

  it("makes a delivered graph runnable, its root reached through the top-level link", async () => {
    /* A back-edge into the root (a cycle) and a root edge to a version other
     * than the one its dependency uses. */
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
    expect((install.get("node_modules/tool") as SymlinkFile).target).to.equal(".fabr/tool@1.0.0/node_modules/tool");
    expect(install.has("node_modules/.fabr/tool@1.0.0/node_modules/tool/bin/tool.js")).to.equal(true);
    const modules = new Map([...install].filter(([name]) => name.startsWith("node_modules/")).map(([name, file]) => [name.slice(13), file]));
    expect(await imported(modules, "tool", "helper")).to.equal("// helper@1.0.0");
    expect(await imported(modules, "tool", "other", "helper")).to.equal("// helper@2.0.0");
    expect(resolveFrom(modules, resolveFrom(modules, resolveFrom(modules, "", "tool")!, "other")!, "tool")).to.equal(
      ".fabr/tool@1.0.0/node_modules/tool"
    );
  });
});

describe("assembleNodeModules", () => {
  it("links only the given packages at the top, their closure behind them", () => {
    const files = entries(assembleNodeModules([pkg("tar-stream", [pkg("b4a")])]));
    expect((files.get("tar-stream") as SymlinkFile).target).to.equal(".fabr/tar-stream@1.0.0/node_modules/tar-stream");
    expect(files.has(".fabr/tar-stream@1.0.0/node_modules/tar-stream/index.js")).to.equal(true);
    expect((files.get(".fabr/tar-stream@1.0.0/node_modules/b4a") as SymlinkFile).target).to.equal("../../b4a@1.0.0/node_modules/b4a");
    expect(files.has(".fabr/b4a@1.0.0/node_modules/b4a/index.js")).to.equal(true);
    expect(files.has("b4a")).to.equal(false);
  });

  it("links a scoped package from one level deeper", () => {
    const files = entries(assembleNodeModules([pkg("@types/node")]));
    expect((files.get("@types/node") as SymlinkFile).target).to.equal("../.fabr/@types+node@1.0.0/node_modules/@types/node");
    expect(files.has(".fabr/@types+node@1.0.0/node_modules/@types/node/index.js")).to.equal(true);
  });

  it("names a package with no version by its name alone", () => {
    const files = entries(assembleNodeModules([new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("x")]]), "mylib", undefined)]));
    expect(files.has(".fabr/mylib/node_modules/mylib/index.js")).to.equal(true);
  });

  it("passes non-package sources through at the top level", () => {
    const loose = new FileSet(new Map<string, IFile>([["loose.js", MemoryFile.from("x")]]));
    expect(entries(assembleNodeModules([pkg("tar-stream"), loose])).has("loose.js")).to.equal(true);
  });

  it("lets a package find a name it never declared, nearest the top first", async () => {
    /* `deep` imports `shared` without declaring it. Two versions are in the
     * closure; the one a direct dependency of the top uses is the one found.
     * A name given at the top is never claimed: it is found there anyway. */
    const deep = vpkg("deep", "1.0.0");
    const far = vpkg("far", "1.0.0", [vpkg("shared", "1.0.0"), deep]);
    const near = vpkg("near", "1.0.0", [far]);
    const top = vpkg("top", "1.0.0", [vpkg("shared", "2.0.0"), near]);
    const files = entries(assembleNodeModules([top]));
    expect(await imported(files, "top", "near", "far", "deep", "shared")).to.equal("// shared@2.0.0");
    expect(await imported(files, "top", "near", "far", "shared")).to.equal("// shared@1.0.0");
    expect(files.has(".fabr/node_modules/top")).to.equal(false);
    expect(await imported(files, "top", "near", "far", "deep", "top")).to.equal("// top@1.0.0");
  });

  it("breaks a tie for an undeclared name by instance name", async () => {
    const files = entries(
      assembleNodeModules([vpkg("top", "1.0.0", [vpkg("b", "1.0.0", [vpkg("shared", "2.0.0")]), vpkg("a", "1.0.0", [vpkg("shared", "1.0.0")])])])
    );
    expect((files.get(".fabr/node_modules/shared") as SymlinkFile).target).to.equal("../shared@1.0.0/node_modules/shared");
  });

  it("a given package holds its own name at the top over another version in the closure", async () => {
    const root = vpkg("tool", "1.0.0", [vpkg("other", "1.0.0", [vpkg("tool", "9.9.9")])]);
    const files = entries(assembleNodeModules([root]));
    expect(await imported(files, "tool")).to.equal("// tool@1.0.0");
    expect(await imported(files, "tool", "other", "tool")).to.equal("// tool@9.9.9");
  });

  it("reports two different given packages sharing a name as a conflict, not a silent drop", () => {
    expect(() => assembleNodeModules([vpkg("tool", "1.0.0"), vpkg("tool", "2.0.0")])).to.throw(
      ConflictError,
      /Conflicting packages for tool/
    );
  });

  it("accepts the same-identity package given twice", () => {
    const files = entries(assembleNodeModules([vpkg("tool", "1.0.0"), vpkg("tool", "1.0.0")]));
    expect(files.has(".fabr/tool@1.0.0/node_modules/tool/index.js")).to.equal(true);
  });

  it("rejects two different contents delivered under one id", () => {
    const debug = new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// debug")]]), "mylib", undefined);
    const release = new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// release")]]), "mylib", undefined);
    expect(() => assembleNodeModules([pkg("x", [debug]), pkg("y", [release])])).to.throw(ConflictError, /mylib@\*/);
  });

  it("rejects two given packages of one id wired differently", () => {
    const carrierOf = (dep: PackageFileSet): PackageFileSet =>
      new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("// carrier")]]), "carrier", "1.0.0", [dep]);
    expect(() => assembleNodeModules([carrierOf(vpkg("q", "1.0.0")), carrierOf(vpkg("q", "2.0.0"))])).to.throw(ConflictError);
  });
});

/** A package that provides (or not) the JSX runtime — the map publishing the
 * subpath AND the file it names, since providing it takes both. */
function jsxPkg(name: string, providesJsxRuntime: boolean): PackageFileSet {
  const json = JSON.stringify({
    name,
    exports: providesJsxRuntime ? { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } : { ".": "./index.js" },
  });
  const files: Array<[string, IFile]> = [["package.json", MemoryFile.from(json)], ["index.js", MemoryFile.from("")]];
  if (providesJsxRuntime) {
    files.push(["jsx-runtime.js", MemoryFile.from("")]);
  }
  return new PackageFileSet(new Map<string, IFile>(files), name);
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
  /** A package with the given manifest, holding `files` (empty content — only
   * their presence is ever asked about). */
  const pkg = (manifest: string, ...files: string[]): PackageFileSet =>
    new PackageFileSet(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(manifest)],
        ...files.map((name): [string, IFile] => [name, MemoryFile.from("")]),
      ]),
      "probe"
    );

  it("detects a declared subpath whose file the package holds", async () => {
    const react = pkg(JSON.stringify({ exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } }), "jsx-runtime.js");
    expect(await settle(hasPackageExport(react, "./jsx-runtime"))).to.equal(true);
    expect(await settle(hasPackageExport(react, "./missing"))).to.equal(false);
  });

  it("resolves the subpath as a consumer would, not as a literal key", async () => {
    /* A package that publishes the subpath through a pattern exposes it just as
       much as one that names it outright — the consumer's import is identical. */
    const patterned = pkg(JSON.stringify({ exports: { "./*": "./src/*.js" } }), "src/jsx-runtime.js");
    expect(await settle(hasPackageExport(patterned, "./jsx-runtime"))).to.equal(true);
    /* And a hole punched in that pattern closes it again. */
    const blocked = pkg(JSON.stringify({ exports: { "./jsx-runtime": null, "./*": "./src/*.js" } }), "src/jsx-runtime.js");
    expect(await settle(hasPackageExport(blocked, "./jsx-runtime"))).to.equal(false);
  });

  it("is not answered by a catch-all pattern that lands on nothing", async () => {
    /* markdown-it's map, and the fortawesome icon packs'. A wildcard says a
       subpath maps SOMEWHERE, not that anything is there — read as a capability
       it would claim the package provides a JSX runtime, a JSON parser, and
       whatever else one thought to ask for. It published 16 targets' worth of
       "multiple JSX runtimes" before the file was looked for. */
    const catchAll = pkg(JSON.stringify({ exports: { ".": "./index.js", "./*": { require: "./*", import: "./*" } } }), "index.js", "lib/token.js");
    expect(await settle(hasPackageExport(catchAll, "./jsx-runtime"))).to.equal(false);
    /* The same map still answers for what the package really holds. */
    expect(await settle(hasPackageExport(catchAll, "./lib/token.js"))).to.equal(true);
  });

  it("answers no when the map publishes a file the package does not hold", async () => {
    const missing = pkg(JSON.stringify({ exports: { "./jsx-runtime": "./jsx-runtime.js" } }));
    expect(await settle(hasPackageExport(missing, "./jsx-runtime"))).to.equal(false);
  });

  it("answers no without an exports map, or for an unreadable manifest", async () => {
    /* A question *about a dependency*: a manifest fabr can't read exposes no
       subpath — whoever builds that dependency is the one to report it. */
    expect(await settle(hasPackageExport(pkg(JSON.stringify({ main: "index.js" }), "jsx-runtime.js"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(pkg(JSON.stringify({ exports: "./index.js" }), "jsx-runtime.js"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(pkg("not json"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(pkg("[]"), "./jsx-runtime"))).to.equal(false);
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

describe("dualFormatOutputs", () => {
  /** The two compiles of a dual package: the same names emitted twice, plus
   *  whatever each format alone produces. */
  const compiled = (...names: string[]): FileSet => new FileSet(new Map(names.map(name => [name, MemoryFile.from("")])));
  const partition = (commonjs: string[], esm: string[]): string[][] =>
    dualFormatOutputs(compiled(...commonjs), compiled(...esm)).map(format => [...format].map(([name]) => name).sort());

  it("takes the .mjs family from the ES-module compile and everything else from the CommonJS one", () => {
    const [primary, secondary] = partition(
      ["index.js", "index.d.ts", "index.js.map", "index.mjs", "index.d.mts"],
      ["index.js", "index.d.ts", "index.mjs", "index.d.mts", "index.mjs.map"]
    );
    expect(primary).to.deep.equal(["index.d.ts", "index.js", "index.js.map"]);
    expect(secondary).to.deep.equal(["index.d.mts", "index.mjs", "index.mjs.map"]);
  });

  it("keeps a format-pinned source's output from the compile whose format it pinned", () => {
    /* `.mts`/`.cts` emit under their own names from BOTH compiles; only the one
     * whose module setting agrees with the pin has the right syntax — and the
     * right sibling specifiers. */
    const [primary, secondary] = partition(["legacy.cjs", "legacy.d.cts", "modern.mjs"], ["legacy.cjs", "modern.mjs", "modern.d.mts"]);
    expect(primary).to.deep.equal(["legacy.cjs", "legacy.d.cts"]);
    expect(secondary).to.deep.equal(["modern.d.mts", "modern.mjs"]);
  });

  it("drops the ES-module copy of a bin the CommonJS format delivers", () => {
    /* A bin is the package as a program: one format, no condition to select on. */
    const [primary, secondary] = partition(["bin/tool.js", "bin/tool.mjs"], ["bin/tool.js", "bin/tool.mjs", "bin/tool.d.mts"]);
    expect(primary).to.deep.equal(["bin/tool.js"]);
    expect(secondary).to.deep.equal([]);
  });

  it("keeps a bin that has no CommonJS format at all", () => {
    /* A bin compiled from an `.mts` emits only `.mjs`, which the CommonJS format
     * discards as ES-module output. Dropping it from the other format too would
     * leave the package with no bin and no error — the regression this guards. */
    const [primary, secondary] = partition(["bin/tool.mjs"], ["bin/tool.mjs", "bin/tool.d.mts"]);
    expect(primary).to.deep.equal([]);
    expect(secondary).to.deep.equal(["bin/tool.d.mts", "bin/tool.mjs"]);
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

describe("usesNodeGlobals", () => {
  it("reads the declared flag by its full namespaced name", () => {
    expect(usesNodeGlobals([new Flag("js/node_globals", [])])).to.equal(true);
    expect(usesNodeGlobals([new Flag("dom", [])])).to.equal(false);
    expect(usesNodeGlobals([])).to.equal(false);
  });

  it("finds it through a composite flag's provides", () => {
    expect(usesNodeGlobals([new Flag("legacy_app", [new Flag("js/node_globals", [])])])).to.equal(true);
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
