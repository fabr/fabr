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
import { Computable, FileSet, IFile, MemoryFile, PackageFileSet, SymlinkFile } from "@fabr-build/core";
import {
  assembleNodeModules,
  assembleScopedNodeModules,
  hasPackageExport,
  makeNpmRunnable,
  parseJSTarget,
  resolveJsxImportSource,
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
  it("detects a declared subpath in the exports map", () => {
    const json = JSON.stringify({ exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } });
    expect(hasPackageExport(json, "./jsx-runtime")).to.equal(true);
    expect(hasPackageExport(json, "./missing")).to.equal(false);
  });

  it("returns false without an exports map, or on malformed json", () => {
    expect(hasPackageExport(JSON.stringify({ main: "index.js" }), "./jsx-runtime")).to.equal(false);
    expect(hasPackageExport(JSON.stringify({ exports: "./index.js" }), "./jsx-runtime")).to.equal(false);
    expect(hasPackageExport("not json", "./jsx-runtime")).to.equal(false);
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
