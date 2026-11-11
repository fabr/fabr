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
import { IPackageLayout, layoutPackages, NODE_MODULES, PNP } from "./Layout";
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
function laid(deps: FileSet[], layout: string, self?: { name: string; location: string }, mount?: string): Promise<IPackageLayout> {
  const action = new BuildAction(
    STEP,
    {},
    { layout, ...(self ? { selfName: self.name, selfLocation: self.location } : {}) },
    { discoverable: { deps } }
  );
  return toPromise(layoutPackages(action, DIR, tree => Computable.resolve(path.join(POOL, tree.toManifestHash())), mount));
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
      expect(layout.nameRead(path.join(DIR, "build", "a.test.js"))).to.deep.equal({ file: "build/a.test.js" });
      expect(layout.nameRead(path.join(POOL, "0000", "index.js")), "a tree of no package here").to.equal(undefined);
    });
  });
});
