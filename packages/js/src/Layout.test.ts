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
import * as path from "path";
import {
  BuildAction,
  Computable,
  dependenciesOn,
  FileSet,
  IBuildActionDefinition,
  IFile,
  MemoryFile,
  PackageFileSet,
  SymlinkFile,
} from "@fabr-build/core";
import { virtualLocation } from "@fabr-build/js-tools";
import { HOISTED, IPackageLayout, layoutPackages, NODE_MODULES, PNP } from "./Layout";
import { packageDirectories } from "./NodeModules";

const STEP: IBuildActionDefinition = { id: "test:step", version: 1, run: () => Computable.reject(new Error("not run")) };
const DIR = path.resolve("/work/step/work");
/** Where the pool holds each tree, by the package's content hash. */
const POOL = path.resolve("/pool/trees");

function pkg(name: string, content = name, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([["index.js", MemoryFile.from(`// ${content}`)]]),
    name,
    "1.0.0",
    dependenciesOn(...deps)
  );
}

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** Lay the packages out for a step in {@link DIR}, each tree ensured at its pool path. */
function laid(
  deps: FileSet[],
  layout: string,
  self?: { name: string; location: string },
  mount?: string,
  unplug?: boolean
): Promise<IPackageLayout> {
  const action = new BuildAction(
    STEP,
    {},
    { layout, ...(self ? { selfName: self.name, selfLocation: self.location } : {}) },
    { discoverable: { deps } }
  );
  return toPromise(layoutPackages(action, DIR, tree => Computable.resolve(path.join(POOL, tree.toManifestHash())), mount, unplug));
}

/** A package `name` at `version`, its content distinct per version. */
function versioned(name: string, version: string): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]), name, version);
}

const row = (name: ReturnType<IPackageLayout["nameRead"]>): unknown =>
  name !== undefined && "route" in name ? { route: name.route, path: name.path, pkg: name.package?.packageName } : name;

describe("layoutPackages", () => {
  const b = pkg("b");
  const a = pkg("a", "a", [b]);

  describe("under node_modules", () => {
    it("stages the tree at the mount, with the sources' own package linked at its name", async () => {
      const layout = await laid([a], NODE_MODULES, { name: "@scope/self", location: "./build/" });
      expect(layout.trees.size).to.equal(0);
      expect(layout.members).to.deep.equal([a]);
      const link = layout.files.getFile("node_modules/@scope/self");
      expect(link).to.be.instanceOf(SymlinkFile);
      expect((link as SymlinkFile).target).to.equal("../../build");
      expect(layout.files.getFile(`node_modules/${packageDirectories([a]).get(a)}/index.js`)).to.not.equal(undefined);
    });

    it("names a read of a staged file by its name, and of a package's file by its route", async () => {
      const layout = await laid([a], NODE_MODULES);
      const directories = packageDirectories([a]);
      expect(layout.nameRead(path.join(DIR, "build", "a.test.js"))).to.deep.equal({ file: "build/a.test.js" });
      expect(row(layout.nameRead(path.join(DIR, "node_modules", ...directories.get(a)!.split("/"), "index.js")))).to.deep.equal({
        route: ["a"],
        path: "index.js",
        pkg: "a",
      });
      expect(row(layout.nameRead(path.join(DIR, "node_modules", ...directories.get(b)!.split("/"), "lib", "x.js")))).to.deep.equal({
        route: ["a", "b"],
        path: "lib/x.js",
        pkg: "b",
      });
      expect(
        row(layout.nameRead(path.join(DIR, "node_modules", ...directories.get(b)!.split("/")))),
        "the instance directory"
      ).to.deep.equal({
        route: ["a", "b"],
        path: "",
        pkg: "b",
      });
    });

    it("names a probe of the mount's own <name> by that name, with the member there or none", async () => {
      const layout = await laid([a], NODE_MODULES);
      expect(row(layout.nameRead(path.join(DIR, "node_modules", "a", "package.json")))).to.deep.equal({
        route: ["a"],
        path: "package.json",
        pkg: "a",
      });
      expect(row(layout.nameRead(path.join(DIR, "node_modules", "opt", "package.json")))).to.deep.equal({
        route: ["opt"],
        path: "package.json",
        pkg: undefined,
      });
      expect(row(layout.nameRead(path.join(DIR, "node_modules", "@scope", "opt", "index.js")))).to.deep.equal({
        route: ["@scope/opt"],
        path: "index.js",
        pkg: undefined,
      });
      expect(layout.nameRead(path.join(DIR, "node_modules", ".fabr", "node_modules", "b", "index.js")), "the hidden links").to.equal(
        undefined
      );
      expect(layout.nameRead(path.join(DIR, "node_modules", "@scope")), "a bare scope").to.equal(undefined);
    });

    it("names nothing outside the working directory, and reads under another mount by it", async () => {
      const layout = await laid([a], NODE_MODULES, undefined, ".tools/tsc");
      expect(layout.nameRead(path.resolve("/elsewhere/runner/index.js"))).to.equal(undefined);
      expect(layout.nameRead(path.dirname(DIR))).to.equal(undefined);
      expect(
        row(layout.nameRead(path.join(DIR, ".tools", "tsc", ...packageDirectories([a]).get(a)!.split("/"), "index.js")))
      ).to.deep.equal({ route: ["a"], path: "index.js", pkg: "a" });
      expect(layout.nameRead(path.join(DIR, "node_modules", "a", "index.js")), "not the mount").to.deep.equal({
        file: "node_modules/a/index.js",
      });
    });

    it("locates a package's file by its route, in the package's instance directory", async () => {
      const layout = await laid([a], NODE_MODULES);
      const located = layout.locate(["a", "b"], "lib/x.js");
      expect(located).to.equal(path.join(DIR, "node_modules", ...packageDirectories([a]).get(b)!.split("/"), "lib", "x.js"));
      expect(row(layout.nameRead(located!))).to.deep.equal({ route: ["a", "b"], path: "lib/x.js", pkg: "b" });
      expect(layout.locate(["b"], "index.js"), "a route the walk does not take").to.equal(undefined);
    });

    it("locates each copy of one package wired one way, and a scoped name along a route, by following the links", async () => {
      const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
      const dep = pkg("@scope/dep");
      const left = new PackageFileSet(content, "@scope/shared", "1.0.0", dependenciesOn(dep));
      const right = new PackageFileSet(content, "@scope/shared", "1.0.0", dependenciesOn(dep));
      const layout = await laid([pkg("l", "l", [left]), pkg("r", "r", [right])], NODE_MODULES);
      const instance = path.join(DIR, "node_modules", ...packageDirectories([left]).get(left)!.split("/"), "index.js");
      expect(layout.locate(["l", "@scope/shared"], "index.js")).to.equal(instance);
      expect(layout.locate(["r", "@scope/shared"], "index.js")).to.equal(instance);
      expect(layout.locate(["r", "@scope/shared", "@scope/dep"], "index.js")).to.equal(
        path.join(DIR, "node_modules", ...packageDirectories([dep]).get(dep)!.split("/"), "index.js")
      );
      expect(layout.locate(["l", "@scope/dep"], "index.js"), "no such edge").to.equal(undefined);
    });
  });

  describe("under hoisted", () => {
    it("stages the tree at the mount with each package at its directory, and the sources' own package linked", async () => {
      const layout = await laid([a], HOISTED, { name: "self", location: "src" });
      const files = new Map(layout.files);
      expect(files.has("node_modules/a/index.js")).to.equal(true);
      expect(files.has("node_modules/b/index.js")).to.equal(true);
      expect((files.get("node_modules/self") as SymlinkFile).target).to.equal("../src");
    });

    it("places a package of the sources' own name below the top, which their link holds", async () => {
      const layout = await laid([pkg("tool", "tool", [versioned("self", "0.9.0")])], HOISTED, { name: "self", location: "src" });
      const files = new Map(layout.files);
      expect(files.get("node_modules/self")).to.be.instanceOf(SymlinkFile);
      expect(files.has("node_modules/tool/node_modules/self/index.js")).to.equal(true);
    });

    it("locates a package's file by its route, at a directory the tree places it", async () => {
      const x1 = versioned("x", "1.0.0");
      const x2 = versioned("x", "2.0.0");
      const layout = await laid([pkg("top", "top", [x1, pkg("y", "y", [x2])])], HOISTED);
      expect(layout.locate(["top", "y", "x"], "index.js")).to.equal(
        path.join(DIR, "node_modules", "y", "node_modules", "x", "index.js")
      );
      expect(layout.locate(["top", "x"], "index.js")).to.equal(path.join(DIR, "node_modules", "x", "index.js"));
      expect(layout.locate(["top", "missing"], "index.js")).to.equal(undefined);
      expect(layout.nameRead(path.join(DIR, "node_modules", "x", "index.js")), "a hoisted tree names no read").to.equal(undefined);
    });

    it("locates a package past a bundle where the tree places it, and nothing it only bundles", async () => {
      /* `bundler` ships its own x@2; `other` requires x@2 too, placed at the top. */
      const x2 = versioned("x", "2.0.0");
      const bundler = new PackageFileSet(
        new Map<string, IFile>(["index.js", "node_modules/x/index.js"].map(file => [file, MemoryFile.from(file)])),
        "bundler",
        "1.0.0",
        dependenciesOn(x2)
      );
      const layout = await laid([bundler, pkg("other", "other", [x2])], HOISTED);
      expect(layout.locate(["bundler", "x"], "index.js")).to.equal(path.join(DIR, "node_modules", "x", "index.js"));
      /* With x@1 holding the top, the bundled x@2 is placed nowhere. */
      const shadowed = await laid([bundler, versioned("x", "1.0.0")], HOISTED);
      expect(shadowed.locate(["bundler", "x"], "index.js")).to.equal(undefined);
    });
  });

  describe("under pnp", () => {
    it("stages the table alone and addresses every package as a tree in the pool", async () => {
      const layout = await laid([a], PNP);
      expect([...layout.files].map(([name]) => name)).to.deep.equal([".pnp.data.json"]);
      expect([...layout.trees.values()]).to.have.members([a, b]);
      expect(layout.members).to.deep.equal([a]);
    });

    it("names a read at a virtual location by the wiring it belongs to", async () => {
      /* One content wired two ways: each wiring has a virtual location over the
       * one tree, and a read there is that wiring's, not the first one's. */
      const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
      const left = new PackageFileSet(content, "shared", "1.0.0", dependenciesOn(pkg("dep", "1")));
      const right = new PackageFileSet(content, "shared", "1.0.0", dependenciesOn(pkg("dep", "2")));
      const layout = await laid([pkg("l", "l", [left]), pkg("r", "r", [right])], PNP);
      const virtual = [...layout.trees].filter(([location]) => location.includes("__virtual__"));
      expect(virtual).to.have.lengthOf(2);
      for (const [location, wiring] of virtual) {
        const read = path.join(POOL, path.posix.relative("../.fabr-tree", location), "index.js");
        const named = layout.nameRead(read);
        expect(named !== undefined && "route" in named && named.package).to.equal(wiring);
        expect(row(named)).to.deep.equal({ route: [wiring === left ? "l" : "r", "shared"], path: "index.js", pkg: "shared" });
      }
      expect(
        row(layout.nameRead(path.join(POOL, left.toManifestHash(), "index.js"))),
        "the physical tree, named by the first wiring"
      ).to.deep.equal({ route: ["l", "shared"], path: "index.js", pkg: "shared" });
    });

    it("names a read within a tree, physical or virtual, by the package's route", async () => {
      const layout = await laid([a], PNP);
      const tree = path.join(POOL, b.toManifestHash());
      expect(row(layout.nameRead(path.join(tree, "index.js")))).to.deep.equal({ route: ["a", "b"], path: "index.js", pkg: "b" });
      expect(row(layout.nameRead(path.join(virtualLocation(tree, "0123abcd"), "lib", "y.js")))).to.deep.equal({
        route: ["a", "b"],
        path: "lib/y.js",
        pkg: "b",
      });
      expect(row(layout.nameRead(tree)), "the tree itself").to.deep.equal({ route: ["a", "b"], path: "", pkg: "b" });
      expect(layout.nameRead(path.join(DIR, "build", "a.test.js"))).to.deep.equal({ file: "build/a.test.js" });
      expect(layout.nameRead(path.join(POOL, "0000", "index.js")), "a tree of no package here").to.equal(undefined);
    });

    it("locates a package's file by its route, at the location of that wiring", async () => {
      expect((await laid([a], PNP)).locate(["a", "b"], "lib/y.js")).to.equal(path.join(POOL, b.toManifestHash(), "lib", "y.js"));
      const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
      const left = new PackageFileSet(content, "shared", "1.0.0", dependenciesOn(pkg("dep", "1")));
      const right = new PackageFileSet(content, "shared", "1.0.0", dependenciesOn(pkg("dep", "2")));
      const layout = await laid([pkg("l", "l", [left]), pkg("r", "r", [right])], PNP);
      for (const route of [
        ["l", "shared"],
        ["r", "shared"],
      ]) {
        const located = layout.locate(route, "index.js")!;
        expect(located).to.contain("__virtual__");
        const named = layout.nameRead(located);
        expect(named !== undefined && "route" in named && named.package).to.equal(route[0] === "l" ? left : right);
      }
    });

    it("locates each copy of one package wired one way, by its own route, at the one location", async () => {
      /* Two objects of one node, one row of the table between them. */
      const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
      const dep = pkg("dep");
      const left = new PackageFileSet(content, "shared", "1.0.0", dependenciesOn(dep));
      const right = new PackageFileSet(content, "shared", "1.0.0", dependenciesOn(dep));
      const layout = await laid([pkg("l", "l", [left]), pkg("r", "r", [right])], PNP);
      const tree = path.join(POOL, left.toManifestHash(), "index.js");
      expect(layout.locate(["l", "shared"], "index.js")).to.equal(tree);
      expect(layout.locate(["r", "shared"], "index.js")).to.equal(tree);
      expect(layout.locate(["r", "shared", "dep"], "index.js")).to.equal(path.join(POOL, dep.toManifestHash(), "index.js"));
      expect(layout.locate(["l", "dep"], "index.js"), "no such edge").to.equal(undefined);
    });

    it("locates and names a package to unplug within the unplugged tree, where unplugging is asked for", async () => {
      const addon = new PackageFileSet(
        new Map<string, IFile>([["lib/x.node", MemoryFile.from("addon")]]),
        "addon",
        "1.0.0",
        dependenciesOn(b)
      );
      const top = pkg("top", "top", [addon]);
      const plain = await laid([top], PNP);
      expect(plain.locate(["top", "addon"], "lib/x.node")).to.equal(path.join(POOL, addon.toManifestHash(), "lib", "x.node"));
      const layout = await laid([top], PNP, undefined, undefined, true);
      const located = layout.locate(["top", "addon"], "lib/x.node")!;
      const unplugged = path.dirname(path.dirname(path.dirname(path.dirname(located))));
      expect(located).to.equal(path.join(unplugged, "node_modules", "addon", "lib", "x.node"));
      expect(layout.locate(["top", "addon", "b"], "index.js"), "what an addon reaches").to.equal(
        path.join(POOL, b.toManifestHash(), "index.js")
      );
      expect(layout.locate(["top"], "index.js"), "a package with no addon").to.equal(
        path.join(POOL, top.toManifestHash(), "index.js")
      );
      expect(row(layout.nameRead(located))).to.deep.equal({ route: ["top", "addon"], path: "lib/x.node", pkg: "addon" });
    });
  });
});
