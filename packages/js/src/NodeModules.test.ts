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
  dependenciesOn,
  nodeNaming,
} from "@fabr-build/core";
import { referenceOf } from "./PnPManifest";
import { assembleHoistedNodeModules, assembleNodeModules, hoistedPlacements } from "./NodeModules";

/** A package with a single `index.js` and the given (already-built) deps. */
function pkg(name: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}`)]]),
    name,
    "1.0.0",
    dependenciesOn(...deps)
  );
}

/** A versioned package (content distinct per version) with the given carried
 * deps — for a delivered closure: flat winners on the root, private version
 * overrides nested on their requirers. */
function vpkg(name: string, version: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]),
    name,
    version,
    dependenciesOn(...deps)
  );
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
  /** Build a closure from a literal `id -> {name: id}` graph — complete edge
   * bindings, cycles allowed — as a resolution's materialized graph is built:
   * an instance per selection wired through PackageGraphBuilder, named as it
   * is installed. */
  function delivered(edges: Record<string, Record<string, string>>, rootId: string): PackageFileSet {
    const builder = new PackageGraphBuilder();
    const instances = new Map<string, PackageFileSet>();
    const instance = (name: string, id: string): PackageFileSet => {
      const key = `${name}\n${id}`;
      let node = instances.get(key);
      if (!node) {
        node = builder.node(
          new Map<string, IFile>([["index.js", MemoryFile.from(`// ${id}`)]]),
          name,
          id.substring(id.lastIndexOf("@") + 1)
        );
        instances.set(key, node);
        builder.wire(node, dependenciesOn(...Object.entries(edges[id] ?? {}).map(([depName, toId]) => instance(depName, toId))));
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
    const [mounted] = root.packages;
    expect(mounted.packageName).to.equal("wrap-ansi-cjs");
    expect(mounted.version).to.equal("7.0.0");
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
    other.wire(root, dependenciesOn(p));
    other.wire(p, []);
    other.seal();
    expect(() => assembleNodeModules([one, root])).to.throw(ConflictError, /p/);
  });

  describe("hoisted", () => {
    /** The assembled hoisted tree's entries, checked to hold no links. */
    const hoisted = (sets: FileSet[]): Map<string, IFile> => {
      const files = entries(assembleHoistedNodeModules(sets));
      expect([...files.values()].filter(file => file instanceof SymlinkFile)).to.have.lengthOf(0);
      return files;
    };

    it("gives each requirer the version its edge binds, each copy as high as it can go", async () => {
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
      const files = hoisted([root]);
      expect(await imported(files, "svgo", "css-tree")).to.equal("// css-tree@3.0.1");
      expect(await imported(files, "svgo", "csso", "css-tree")).to.equal("// css-tree@2.2.0");
      expect(await imported(files, "svgo", "csso", "css-tree", "mdn-data")).to.equal("// mdn-data@2.0.28");
      expect(await imported(files, "svgo", "css-tree", "mdn-data")).to.equal("// mdn-data@2.12.2");
      expect([...files.keys()].filter(name => name.endsWith("/index.js")).sort()).to.deep.equal([
        "css-tree/index.js",
        "csso/index.js",
        "csso/node_modules/css-tree/index.js",
        "csso/node_modules/mdn-data/index.js",
        "mdn-data/index.js",
        "svgo/index.js",
      ]);
    });

    it("installs an instance once where nothing takes its name (the pg shape)", async () => {
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
      const files = hoisted([root]);
      expect(await imported(files, "app", "orm", "pg")).to.equal("// pg@8.11.3");
      expect(await imported(files, "app", "pool", "pg")).to.equal("// pg@8.11.3");
      expect(await imported(files, "app", "saver", "pg")).to.equal("// pg@8.12.0");
      expect([...files.keys()].filter(name => name.endsWith("pg/index.js")).sort()).to.deep.equal([
        "pg/index.js",
        "saver/node_modules/pg/index.js",
      ]);
    });

    it("refuses a cross-generation version cycle, whose tree would not end", () => {
      const root = delivered(
        {
          "a@1.0.0": { b: "b@1.0.0" },
          "b@1.0.0": { a: "a@2.0.0" },
          "a@2.0.0": { b: "b@2.0.0" },
          "b@2.0.0": { a: "a@1.0.0" },
        },
        "a@1.0.0"
      );
      expect(() => assembleHoistedNodeModules([root])).to.throw(/Can't lay out b@1\.0\.0 without links/);
    });

    it("lays out a copy beneath a copy of itself where the copy's own dependencies are found above it", async () => {
      /* X@1's copy beneath G finds E@1 at X/node_modules/E, so the tree ends. */
      const root = delivered(
        {
          "root@1.0.0": { X: "X@1.0.0", E: "E@2.0.0", G: "G@2.0.0" },
          "X@1.0.0": { E: "E@1.0.0" },
          "E@1.0.0": { X: "X@2.0.0" },
          "X@2.0.0": { G: "G@1.0.0" },
          "G@1.0.0": { X: "X@1.0.0" },
          "E@2.0.0": {},
          "G@2.0.0": {},
        },
        "root@1.0.0"
      );
      const files = hoisted([root]);
      expect(await imported(files, "root", "X", "E", "X", "G", "X", "E")).to.equal("// E@1.0.0");
    });

    it("lays out a graph whose copies repeat a package above them, seeing other packages there", async () => {
      /* b@1 wired two ways (w1 requiring w2), c@1 beneath copies of itself. */
      const builder = new PackageGraphBuilder();
      const node = (name: string, version: string): PackageFileSet =>
        builder.node(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]), name, version);
      const a2 = node("a", "2.0.0");
      const bW1 = node("b", "1.0.0");
      const bW2 = node("b", "1.0.0");
      const c1 = node("c", "1.0.0");
      const c2 = node("c", "2.0.0");
      const d3 = node("d", "3.0.0");
      builder.wire(bW2, dependenciesOn(a2, d3));
      builder.wire(d3, dependenciesOn(c1));
      builder.wire(c1, dependenciesOn(a2, bW1, d3));
      builder.wire(bW1, dependenciesOn(bW2, c2));
      builder.wire(c2, dependenciesOn(c1));
      builder.wire(a2, []);
      builder.seal();
      const files = hoisted([bW2]);
      expect(await imported(files, "b", "d", "c", "b", "b", "d", "c", "b", "c")).to.equal("// c@2.0.0");
    });

    it("keeps a tree linear in the graph where a family of packages takes names the top holds", () => {
      /* Each a_i@2 requires b_i@2 and c_i@2, which both require a_{i+1}@2; the
       * @1 of every name holds the top. Nesting each in its requirer's own
       * node_modules would double the copies at every level. */
      const levels = 12;
      const graph: Record<string, Record<string, string>> = {};
      const root: Record<string, string> = { r: "r@1.0.0" };
      for (let i = 0; i <= levels; i++) {
        for (const name of ["a", "b", "c"]) {
          root[`${name}${i}`] = `${name}${i}@1.0.0`;
          graph[`${name}${i}@1.0.0`] = {};
        }
        graph[`a${i}@2.0.0`] = i < levels ? { [`b${i}`]: `b${i}@2.0.0`, [`c${i}`]: `c${i}@2.0.0` } : {};
        if (i < levels) {
          graph[`b${i}@2.0.0`] = { [`a${i + 1}`]: `a${i + 1}@2.0.0` };
          graph[`c${i}@2.0.0`] = { [`a${i + 1}`]: `a${i + 1}@2.0.0` };
        }
      }
      /* And, beside it, a copy beneath a copy of itself that ends (X@1 under G@1). */
      Object.assign(root, { X: "X@1.0.0", E: "E@2.0.0", G: "G@2.0.0" });
      Object.assign(graph, {
        "X@1.0.0": { E: "E@1.0.0" },
        "E@1.0.0": { X: "X@2.0.0" },
        "X@2.0.0": { G: "G@1.0.0" },
        "G@1.0.0": { X: "X@1.0.0" },
        "E@2.0.0": {},
        "G@2.0.0": {},
      });
      graph["root@1.0.0"] = root;
      graph["r@1.0.0"] = { a0: "a0@2.0.0" };
      const placements = hoistedPlacements([delivered(graph, "root@1.0.0")]);
      expect(placements.size).to.be.lessThan(4 * 3 * (levels + 1) + 12);
    });

    it("places nothing for a dependency its requirer bundles, and nests others beneath the bundle", () => {
      /* p ships x@2 under its own node_modules; q, beneath p, requires x@3. */
      const builder = new PackageGraphBuilder();
      const node = (name: string, version: string, files: string[] = ["index.js"]): PackageFileSet =>
        builder.node(
          new Map<string, IFile>(files.map(file => [file, MemoryFile.from(`// ${name}@${version} ${file}`)])),
          name,
          version
        );
      const root = node("root", "1.0.0");
      const x1 = node("x", "1.0.0");
      const x2 = node("x", "2.0.0");
      const x3 = node("x", "3.0.0");
      const p = node("p", "1.0.0", ["index.js", "node_modules/x/index.js", "node_modules/x/package.json"]);
      const q1 = node("q", "1.0.0");
      const q2 = node("q", "2.0.0");
      builder.wire(root, dependenciesOn(p, x1, q1));
      builder.wire(p, dependenciesOn(x2, q2));
      builder.wire(q2, dependenciesOn(x3));
      [x1, x2, x3, q1].forEach(pkg => builder.wire(pkg, []));
      builder.seal();
      const placements = hoistedPlacements([root]);
      expect([...placements.keys()].sort()).to.deep.equal([
        "p",
        "p/node_modules/q",
        "p/node_modules/q/node_modules/x",
        "q",
        "root",
        "x",
      ]);
    });
  });

  it("still NAMES the same delivery, because references need no tree", () => {
    /* A report can span surfaces that never co-resolved, where two nodes under
     * one id is an ordinary fact about two deliveries — and a node's reference
     * is its own signature, so it exists whatever layout does. */
    const batches = disagreeingBatches();
    const pOf = (root: PackageFileSet): PackageFileSet => root.getDependency("p")!.package!;
    expect(referenceOf(pOf(batches[0])), "the two p nodes get distinct references").to.not.equal(referenceOf(pOf(batches[1])));
  });
});

describe("hoistedPlacements over random graphs", () => {
  /** A seeded generator of numbers in [0, 1). */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A random graph: nodes by name and version, each node's dependencies as
   *  node indices (one per name), and the roots (distinct names). */
  interface IGraphSpec {
    nodes: Array<{ name: string; version: string }>;
    edges: number[][];
    roots: number[];
  }

  /** Make a random graph: up to five names, three versions each, some
   *  versions wired two ways, each node requiring a random set of names (its
   *  own among them), cycles allowed. */
  function spec(seed: number): IGraphSpec {
    const next = random(seed);
    const names = ["a", "b", "c", "d", "@s/e"].slice(0, 2 + Math.floor(next() * 4));
    const nodes: IGraphSpec["nodes"] = [];
    for (const name of names) {
      for (let version = 1; version <= 1 + Math.floor(next() * 3); version++) {
        for (let wiring = 0; wiring < (next() < 0.2 ? 2 : 1); wiring++) {
          nodes.push({ name, version: `${version}.0.0` });
        }
      }
    }
    const of = (name: string): number[] => nodes.flatMap((node, index) => (node.name === name ? [index] : []));
    const pick = (indices: number[]): number => indices[Math.floor(next() * indices.length)];
    const edges = nodes.map(() => names.filter(() => next() < 0.45).map(name => pick(of(name))));
    const roots = names.filter(() => next() < 0.5).map(name => pick(of(name)));
    return { nodes, edges, roots: roots.length > 0 ? roots : [0] };
  }

  /** Build the graph `spec` describes, its nodes made, its edges wired and its
   *  roots listed in reverse where `reversed`. */
  function build({ nodes, edges, roots }: IGraphSpec, reversed: boolean): PackageFileSet[] {
    const order = <T>(items: T[]): T[] => (reversed ? [...items].reverse() : items);
    const builder = new PackageGraphBuilder();
    const made = new Map<number, PackageFileSet>();
    for (const index of order(nodes.map((_, at) => at))) {
      const { name, version } = nodes[index];
      made.set(index, builder.node(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]), name, version));
    }
    for (const index of order(nodes.map((_, at) => at))) {
      builder.wire(made.get(index)!, dependenciesOn(...order(edges[index]).map(dep => made.get(dep)!)));
    }
    builder.seal();
    return order(roots).map(root => made.get(root)!);
  }

  /**
   * @return how many directories placing each conflicting dependency in its
   * requirer's own `node_modules` makes, with no check for a tree that never
   * ends, or undefined past `cap`; the top level is chosen as
   * hoistedPlacements chooses it.
   */
  function nestedInRequirers(roots: PackageFileSet[], cap: number): number | undefined {
    const nodeOf = nodeNaming(roots);
    const byName = (a: PackageFileSet, b: PackageFileSet): number =>
      a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0;
    const placements = new Map<string, PackageFileSet>(roots.map(root => [root.packageName, root]));
    const visited = new Set<string>();
    for (let level = [...placements.values()]; level.length > 0;) {
      const next: PackageFileSet[] = [];
      const ordered = level
        .filter(pkg => !visited.has(nodeOf(pkg)) && visited.add(nodeOf(pkg)))
        .sort((a, b) => (nodeOf(a) < nodeOf(b) ? -1 : nodeOf(a) > nodeOf(b) ? 1 : 0));
      for (const pkg of ordered) {
        for (const dep of [...pkg.packages].sort(byName)) {
          if (!placements.has(dep.packageName)) {
            placements.set(dep.packageName, dep);
          }
          next.push(dep);
        }
      }
      level = next;
    }
    const walk = (from: string, name: string): string | undefined => {
      const parts = from.split("/node_modules/");
      for (let count = parts.length; count >= 1; count--) {
        const candidate = `${parts.slice(0, count).join("/node_modules/")}/node_modules/${name}`;
        if (placements.has(candidate)) {
          return candidate;
        }
      }
      return placements.has(name) ? name : undefined;
    };
    const queue = [...placements.keys()];
    for (let at = 0; at < queue.length; at++) {
      if (queue.length > cap) {
        return undefined;
      }
      for (const dep of placements.get(queue[at])!.packages) {
        const found = walk(queue[at], dep.packageName);
        if (found === undefined || nodeOf(placements.get(found)!) !== nodeOf(dep)) {
          placements.set(`${queue[at]}/node_modules/${dep.packageName}`, dep);
          queue.push(`${queue[at]}/node_modules/${dep.packageName}`);
        }
      }
    }
    return placements.size;
  }

  it("resolves every edge of every copy to the package it is bound to, refuses only a tree that never ends, and is deterministic", () => {
    let laidOut = 0;
    let refused = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const graphSpec = spec(seed);
      const roots = build(graphSpec, false);
      let placements: Map<string, PackageFileSet>;
      try {
        placements = hoistedPlacements(roots);
      } catch (error) {
        expect(String(error), `seed ${seed}`).to.match(/without links/);
        expect(nestedInRequirers(roots, 200), `seed ${seed}: refused a tree that ends`).to.equal(undefined);
        expect(() => hoistedPlacements(build(graphSpec, true)), `seed ${seed}: refused in one order only`).to.throw(/without links/);
        refused++;
        continue;
      }
      laidOut++;
      const nodeOf = nodeNaming(roots);
      const files = entries(assembleHoistedNodeModules(roots, placements));
      const byDirectory = new Map([...placements].map(([directory, pkg]): [string, string] => [directory, nodeOf(pkg)]));
      for (const root of roots) {
        expect(byDirectory.get(resolveFrom(files, "", root.packageName)!), `seed ${seed}: root ${root.packageName}`).to.equal(
          nodeOf(root)
        );
      }
      for (const [directory, pkg] of placements) {
        for (const dep of pkg.packages) {
          const found = resolveFrom(files, directory, dep.packageName);
          expect(
            found === undefined ? undefined : byDirectory.get(found),
            `seed ${seed}: ${directory} -> ${dep.packageName}`
          ).to.equal(nodeOf(dep));
        }
      }
      expect(assembleHoistedNodeModules(build(graphSpec, true)).toManifest(), `seed ${seed}`).to.equal(
        assembleHoistedNodeModules(roots, placements).toManifest()
      );
    }
    expect(laidOut).to.be.greaterThan(60);
    expect(refused).to.be.greaterThan(0);
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
    const files = entries(
      assembleNodeModules([new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from("x")]]), "mylib", undefined)])
    );
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
      assembleNodeModules([
        vpkg("top", "1.0.0", [vpkg("b", "1.0.0", [vpkg("shared", "2.0.0")]), vpkg("a", "1.0.0", [vpkg("shared", "1.0.0")])]),
      ])
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
      new PackageFileSet(
        new Map<string, IFile>([["index.js", MemoryFile.from("// carrier")]]),
        "carrier",
        "1.0.0",
        dependenciesOn(dep)
      );
    expect(() => assembleNodeModules([carrierOf(vpkg("q", "1.0.0")), carrierOf(vpkg("q", "2.0.0"))])).to.throw(ConflictError);
  });
});
