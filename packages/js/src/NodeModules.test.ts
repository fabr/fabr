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
  IFile,
  MemoryFile,
  PackageFileSet,
  PackageGraphBuilder,
  SymlinkFile,
} from "@fabr-build/core";
import { referenceOf } from "./PnPManifest";
import { assembleNodeModules } from "./NodeModules";

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

function settle<T>(c: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => c.then(resolve, reject));
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
