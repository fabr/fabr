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
import { Computable, ConflictError, FileSet, Flag, IFile, MemoryFile, PackageFileSet, SymlinkFile } from "@fabr-build/core";
import {
  assembleNodeModules,
  buildMounts,
  EdgeMap,
  planMounts,
  PlannedMount,
  assembleScopedNodeModules,
  binByConvention,
  binOf,
  classifyJsSource,
  hasPackageExport,
  makeNpmRunnable,
  parseJSTarget,
  resolveJsxImportSource,
  resolveSourceMode,
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

describe("assembleScopedNodeModules", () => {
  it("exposes only direct deps at the top level, the closure only in the store", () => {
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

  it("points a scoped package's symlink back up to the store", () => {
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
    /* The flat store has one slot per name; a two-version closure is
     * unrepresentable, and the error must name the packages — not the raw
     * store-file collision the union would otherwise trip over. */
    const a = vpkg("a", "1.0.0", [vpkg("shared", "1.0.0")]);
    const b = vpkg("b", "1.0.0", [vpkg("shared", "2.0.0")]);
    expect(() => assembleScopedNodeModules([a, b])).to.throw(ConflictError, /Conflicting packages for shared/);
  });
});

describe("planMounts", () => {
  /** A closure member: `name@version`, its files distinguishable by content. */
  function member(name: string, version: string): PackageFileSet {
    return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]), name, version);
  }

  /** Everything planMounts reads, from a literal `id -> {name: id}` graph. */
  function graph(edges: Record<string, Record<string, string>>): {
    packages: Map<string, PackageFileSet>;
    members: Set<string>;
    edgeMap: EdgeMap;
  } {
    const packages = new Map<string, PackageFileSet>();
    for (const id of Object.keys(edges)) {
      const at = id.lastIndexOf("@");
      packages.set(id, member(id.substring(0, at), id.substring(at + 1)));
    }
    const edgeMap: EdgeMap = new Map(Object.entries(edges).map(([id, deps]) => [id, new Map(Object.entries(deps))]));
    return { packages, members: new Set(packages.keys()), edgeMap };
  }

  /** The planned tree as `id` paths, so nesting is inspectable. */
  function tree(mounts: PlannedMount[]): string[] {
    return mounts.flatMap(mount => [mount.id, ...tree(mount.overrides).map(path => `${mount.id}/${path}`)]);
  }

  it("nests each divergent edge target under its requirer", () => {
    /* The mdn-data shape: csso needs css-tree@2 where the flat winner is @3,
     * and that copy needs mdn-data@2.0.28 where the winner is @2.12.2. */
    const { members, edgeMap } = graph({
      "svgo@4.0.1": { csso: "csso@5.0.5", "css-tree": "css-tree@3.0.1", "mdn-data": "mdn-data@2.12.2" },
      "csso@5.0.5": { "css-tree": "css-tree@2.2.0" },
      "css-tree@2.2.0": { "mdn-data": "mdn-data@2.0.28" },
      "css-tree@3.0.1": { "mdn-data": "mdn-data@2.12.2" },
      "mdn-data@2.12.2": {},
      "mdn-data@2.0.28": {},
    });
    const winners = new Map([
      ["svgo", "svgo@4.0.1"],
      ["csso", "csso@5.0.5"],
      ["css-tree", "css-tree@3.0.1"],
      ["mdn-data", "mdn-data@2.12.2"],
    ]);
    expect(tree(planMounts("svgo@4.0.1", "svgo", winners, edgeMap, members))).to.deep.equal([
      "csso@5.0.5",
      "csso@5.0.5/css-tree@2.2.0",
      "csso@5.0.5/css-tree@2.2.0/mdn-data@2.0.28",
      "css-tree@3.0.1",
      "mdn-data@2.12.2",
    ]);
  });

  it("reports a cross-generation version cycle instead of nesting forever", () => {
    /* a@1 → b@1 → a@2 → b@2 → a@1: every hop needs a version other than the
     * one visible where it sits, and each nesting is forced, so the tree would
     * grow without end (it used to, until the stack gave out). No finite
     * node_modules layout satisfies all four, so it is reported as such. */
    const { members, edgeMap } = graph({
      "a@1.0.0": { b: "b@1.0.0" },
      "b@1.0.0": { a: "a@2.0.0" },
      "a@2.0.0": { b: "b@2.0.0" },
      "b@2.0.0": { a: "a@1.0.0" },
    });
    /* The root holds its own name; b's flat winner is its highest version. */
    const winners = new Map([
      ["a", "a@1.0.0"],
      ["b", "b@2.0.0"],
    ]);
    const err = (() => {
      try {
        planMounts("a@1.0.0", "a", winners, edgeMap, members);
        return undefined;
      } catch (thrown) {
        return thrown as Error & { help?: string };
      }
    })();
    expect(err?.message).to.contain("b@1.0.0 -> a@2.0.0 -> b@2.0.0 -> a@1.0.0 -> b@1.0.0");
    expect(err?.help).to.contain("@npm:b:<version>");
  });

  it("nests a cycle that resolves to one version per name", () => {
    /* The ordinary cyclic dependency (a ↔ b, one version each) is not the
     * problem — nothing diverges from the flat winners, so nothing nests. */
    const { members, edgeMap } = graph({
      "a@1.0.0": { b: "b@1.0.0" },
      "b@1.0.0": { a: "a@1.0.0" },
    });
    const winners = new Map([
      ["a", "a@1.0.0"],
      ["b", "b@1.0.0"],
    ]);
    expect(tree(planMounts("a@1.0.0", "a", winners, edgeMap, members))).to.deep.equal(["b@1.0.0"]);
  });

  it("reuses one subtree for a position reached twice with the same bindings", () => {
    /* Two requirers diverging the same way share the instance: the subtree is
     * a function of (node, bindings), so planning it twice is waste — and on a
     * wide graph, exponential waste. */
    const { members, edgeMap } = graph({
      "root@1.0.0": { x: "x@1.0.0", y: "y@1.0.0", shared: "shared@2.0.0" },
      "x@1.0.0": { shared: "shared@1.0.0" },
      "y@1.0.0": { shared: "shared@1.0.0" },
      "shared@1.0.0": {},
      "shared@2.0.0": {},
    });
    const winners = new Map([
      ["root", "root@1.0.0"],
      ["x", "x@1.0.0"],
      ["y", "y@1.0.0"],
      ["shared", "shared@2.0.0"],
    ]);
    const mounts = planMounts("root@1.0.0", "root", winners, edgeMap, members);
    const x = mounts.find(mount => mount.id.startsWith("x@"))!;
    const y = mounts.find(mount => mount.id.startsWith("y@"))!;
    expect(x.overrides[0]).to.equal(y.overrides[0]);
  });

  it("mounts an aliased dependency under the alias, and only there", () => {
    /* The @isaacs/cliui shape: cliui requires wrap-ansi@7 as `wrap-ansi-cjs`
     * (and its code requires that name), while the tree's own wrap-ansi is @8.
     * Nothing asks for wrap-ansi@7 by its own name, so it is mounted only
     * where cliui looks for it. */
    const { packages, members, edgeMap } = graph({
      "cli@1.0.0": { "@isaacs/cliui": "@isaacs/cliui@8.0.2", "wrap-ansi": "wrap-ansi@8.1.0" },
      "@isaacs/cliui@8.0.2": { "wrap-ansi-cjs": "wrap-ansi@7.0.0" },
      "wrap-ansi@8.1.0": {},
      "wrap-ansi@7.0.0": {},
    });
    const winners = new Map([
      ["cli", "cli@1.0.0"],
      ["@isaacs/cliui", "@isaacs/cliui@8.0.2"],
      ["wrap-ansi", "wrap-ansi@8.1.0"],
      ["wrap-ansi-cjs", "wrap-ansi@7.0.0"],
    ]);
    const plan = planMounts("cli@1.0.0", "cli", winners, edgeMap, members);
    expect(plan.map(mount => `${mount.as}=${mount.id}`)).to.deep.equal([
      "@isaacs/cliui=@isaacs/cliui@8.0.2",
      "wrap-ansi=wrap-ansi@8.1.0",
      "wrap-ansi-cjs=wrap-ansi@7.0.0",
    ]);
    const root = new PackageFileSet(packages.get("cli@1.0.0")!, "cli", "1.0.0", buildMounts(plan, packages, { kind: "target" }));
    const files = entries(assembleNodeModules([root]));
    expect([...files.keys()].filter(name => name.includes("wrap-ansi"))).to.deep.equal([
      "wrap-ansi/index.js",
      "wrap-ansi-cjs/index.js",
    ]);
  });

  it("restamps an alias mount with the name it is mounted under", async () => {
    /* The delivered instance IS a package of that name as far as the install
     * is concerned (npm's node_modules/wrap-ansi-cjs, whose package.json still
     * says wrap-ansi) — the content is the aliased package's. */
    const { packages, members, edgeMap } = graph({
      "cli@1.0.0": { "wrap-ansi-cjs": "wrap-ansi@7.0.0" },
      "wrap-ansi@7.0.0": {},
    });
    const winners = new Map([
      ["cli", "cli@1.0.0"],
      ["wrap-ansi-cjs", "wrap-ansi@7.0.0"],
    ]);
    const [mounted] = buildMounts(planMounts("cli@1.0.0", "cli", winners, edgeMap, members), packages, { kind: "target" });
    expect(mounted.packageName).to.equal("wrap-ansi-cjs");
    expect(mounted.version).to.equal("7.0.0");
    expect(await settle(entries(mounted).get("index.js")!.readString())).to.equal("// wrap-ansi@7.0.0");
  });

  it("nests an alias mount privately when its name is won by another version", () => {
    /* Two requirers aliasing one name to different versions: the alias behaves
     * exactly like a package name — one wins the flat mount, the other nests
     * under the requirer that diverges. */
    const { members, edgeMap } = graph({
      "root@1.0.0": { a: "a@1.0.0", b: "b@1.0.0" },
      "a@1.0.0": { "wa-cjs": "wrap-ansi@7.0.0" },
      "b@1.0.0": { "wa-cjs": "wrap-ansi@6.0.0" },
      "wrap-ansi@7.0.0": {},
      "wrap-ansi@6.0.0": {},
    });
    const winners = new Map([
      ["root", "root@1.0.0"],
      ["a", "a@1.0.0"],
      ["b", "b@1.0.0"],
      ["wa-cjs", "wrap-ansi@7.0.0"],
    ]);
    expect(tree(planMounts("root@1.0.0", "root", winners, edgeMap, members))).to.deep.equal([
      "a@1.0.0",
      "b@1.0.0",
      "b@1.0.0/wrap-ansi@6.0.0",
      "wrap-ansi@7.0.0",
    ]);
  });

  it("realises a plan into the nested layout it describes", () => {
    /* The seam: planning decides the shape from ids alone, building fills in
     * the fetched content, and the layout comes out where the plan put it. */
    const { packages, members, edgeMap } = graph({
      "svgo@4.0.1": { csso: "csso@5.0.5", "css-tree": "css-tree@3.0.1" },
      "csso@5.0.5": { "css-tree": "css-tree@2.2.0" },
      "css-tree@2.2.0": {},
      "css-tree@3.0.1": {},
    });
    const winners = new Map([
      ["svgo", "svgo@4.0.1"],
      ["csso", "csso@5.0.5"],
      ["css-tree", "css-tree@3.0.1"],
    ]);
    const plan = planMounts("svgo@4.0.1", "svgo", winners, edgeMap, members);
    const root = new PackageFileSet(packages.get("svgo@4.0.1")!, "svgo", "4.0.1", buildMounts(plan, packages, { kind: "target" }));
    const files = entries(assembleNodeModules([root]));
    expect(files.has("css-tree/index.js")).to.equal(true);
    expect(files.has("csso/node_modules/css-tree/index.js")).to.equal(true);
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
     * a@1 — a winner is never nested, so the cycle-shaped structure stops. */
    const a = vpkg("a", "1.0.0");
    const b1 = vpkg("b", "1.0.0", [a]);
    const a2 = vpkg("a", "1.0.0", [b1]); /* same id as a — winner */
    const b2 = vpkg("b", "2.0.0");
    const root = vpkg("top", "1.0.0", [a2, b2]);
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
    expect(resolveSourceMode([new Flag("ts/nostrict", [])])).to.deep.equal({ strict: false });
    expect(resolveSourceMode([new Flag("ts/allow_implicit_any", [])])).to.deep.equal({ noImplicitAny: false });
    expect(resolveSourceMode([new Flag("ts/no_esmodule_interop", [])])).to.deep.equal({ esModuleInterop: false });
  });

  it("merges several flags into one overlay", () => {
    expect(resolveSourceMode([new Flag("ts/allow_implicit_any", []), new Flag("ts/allow_implicit_null", [])])).to.deep.equal({
      noImplicitAny: false,
      strictNullChecks: false,
    });
  });

  it("walks a composite flag's provides closure", () => {
    const composite = new Flag("my/relaxed", [new Flag("ts/nostrict", []), new Flag("ts/allow_implicit_any", [])]);
    expect(resolveSourceMode([composite])).to.deep.equal({ strict: false, noImplicitAny: false });
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

describe("classifyJsSource", () => {
  it("compiles the module-flavoured TypeScript spellings", () => {
    /* Routed to js_compile, not shipped verbatim as a resource. */
    expect(classifyJsSource("src/a.mts")).to.equal("ts");
    expect(classifyJsSource("src/a.cts")).to.equal("ts");
    expect(classifyJsSource("src/a.mjs")).to.equal("js");
    expect(classifyJsSource("src/a.cjs")).to.equal("js");
  });

  it("treats their declaration forms as declarations", () => {
    expect(classifyJsSource("src/a.d.mts")).to.equal("dts");
    expect(classifyJsSource("src/a.d.cts")).to.equal("dts");
  });

  it("still copies anything tsc neither compiles nor emits", () => {
    expect(classifyJsSource("src/data.json")).to.equal("copy");
    expect(classifyJsSource("src/run.sh")).to.equal("copy");
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
