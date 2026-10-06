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
  FileSet,
  Flag,
  IFile,
  MemoryFile,
  PACKAGE_RESOLUTION_PROVENANCE,
  PackageFileSet,
  PackageGraphBuilder,
  } from "@fabr-build/core";
import { packageNodeSignature } from "@fabr-build/core";
import * as path from "path";
import { assertOnePackagePerName, IPnpPackageInfo, pnpManifestOf, PnpDependencyTarget, TREE_MOUNT, treeMountOf } from "./PnPManifest";
import { resolveVirtual } from "./pnp/VirtualPath";

/** A package as a REPOSITORY delivered it — carrying a resolution provenance,
 * which is what marks it as something this build did not produce and therefore
 * cannot be held to a complete dependency list. */
function pkg(name: string, version = "1.0.0", deps: PackageFileSet[] = [], body = ""): PackageFileSet {
  return built(name, version, deps, body).withOrigin({ kind: PACKAGE_RESOLUTION_PROVENANCE });
}

/** A package as a target of THIS project produced it: no resolution provenance,
 * so its declared surface is held to be complete. */
function built(name: string, version = "1.0.0", deps: PackageFileSet[] = [], body = ""): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}${body}`)]]),
    name,
    version,
    deps
  );
}

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** The row for one package name, by reference. */
function rowsOf(manifest: ReturnType<typeof pnpManifestOf>, name: string | null): Map<string | null, IPnpPackageInfo> {
  const entry = manifest.state.packageRegistryData.find(([rowName]) => rowName === name);
  return new Map(entry?.[1] ?? []);
}

function dependencyOf(info: IPnpPackageInfo, name: string): PnpDependencyTarget | undefined {
  return info.packageDependencies.find(([dependency]) => dependency === name)?.[1];
}

describe("pnpManifestOf", () => {
  it("refuses two versions of one package among the direct deps, which no import could tell apart", () => {
    expect(() => pnpManifestOf([pkg("dep", "1.0.0"), pkg("dep", "2.0.0")])).to.throw("Conflicting packages for dep");
    expect(() => assertOnePackagePerName([pkg("dep", "1.0.0"), pkg("dep", "2.0.0")])).to.throw("Conflicting packages for dep");
    /* The same version twice is one package; two versions BELOW the direct
     * deps are each their requirer's own. */
    expect(() => assertOnePackagePerName([pkg("dep", "1.0.0"), pkg("dep", "1.0.0")])).to.not.throw();
    expect(() => pnpManifestOf([pkg("a", "1.0.0", [pkg("dep", "1.0.0")]), pkg("b", "1.0.0", [pkg("dep", "2.0.0")])])).to.not.throw();
  });

  it("emits the compilation as the top-level package, seeing exactly its declared deps", () => {
    const manifest = pnpManifestOf([pkg("left-pad"), pkg("chalk", "1.0.0", [pkg("ansi-styles")])]);
    const top = rowsOf(manifest, null).get(null)!;
    expect(top.packageLocation).to.equal("./");
    expect(top.linkType).to.equal("SOFT");
    expect(top.packageDependencies.map(([name]) => name)).to.deep.equal(["chalk", "left-pad"]);
    /* The transitive dep is a row of its own, but the sources cannot name it —
     * the undeclared-transitive rule, now a table lookup rather than a position. */
    expect(rowsOf(manifest, "ansi-styles").size).to.equal(1);
    expect(dependencyOf(top, "ansi-styles")).to.equal(undefined);
  });

  it("locates every package by its content key, and gives each row its own edges", () => {
    const styles = pkg("ansi-styles");
    const chalk = pkg("chalk", "1.0.0", [styles]);
    const manifest = pnpManifestOf([chalk]);
    const [reference, info] = [...rowsOf(manifest, "chalk")][0];
    expect(info.packageLocation).to.equal(`./${treeMountOf(chalk)}/`);
    expect(info.linkType).to.equal("HARD");
    /* Its own name resolves to itself (a package may import itself), and its
     * edge to the row that answers it. */
    expect(dependencyOf(info, "chalk")).to.equal(reference);
    expect(dependencyOf(info, "ansi-styles")).to.equal([...rowsOf(manifest, "ansi-styles").keys()][0]);
  });

  it("keys a row by content AND edges, so identical bytes resolving differently cannot collapse", () => {
    /* The case content-keyed references would break: one package, byte-identical
     * (a republish that changed nothing, or one instance reached by two
     * requirers), bound to different versions of a requirement. One row would
     * hand half its requirers a dependency table that is not theirs. */
    const content = new Map<string, IFile>([["index.js", MemoryFile.from("// plugin")]]);
    const left = new PackageFileSet(content, "plugin", "1.0.0", [pkg("core", "1.0.0")]);
    const right = new PackageFileSet(content, "plugin", "1.0.0", [pkg("core", "2.0.0")]);
    const manifest = pnpManifestOf([pkg("left", "1.0.0", [left]), pkg("right", "1.0.0", [right])]);
    const rows = [...rowsOf(manifest, "plugin")];
    expect(rows).to.have.lengthOf(2);
    expect(rows[0][0]).to.not.equal(rows[1][0]);
    expect(dependencyOf(rows[0][1], "core")).to.not.equal(dependencyOf(rows[1][1], "core"));
  });

  it("gives each wiring of one content its own virtual location over the content's tree", () => {
    /* A location is how the resolver tells which row a file belongs to, so two
     * wirings of one content in one directory could not be told apart — each
     * gets a PnP virtual location resolving to the one tree, and neither owns
     * the tree itself. */
    const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
    const left = new PackageFileSet(content, "shared", "1.0.0", [pkg("dep", "1.0.0")]);
    const right = new PackageFileSet(content, "shared", "1.0.0", [pkg("dep", "2.0.0")]);
    const manifest = pnpManifestOf([pkg("left", "1.0.0", [left]), pkg("right", "1.0.0", [right])]);
    const rows = [...rowsOf(manifest, "shared").values()];
    expect(rows).to.have.lengthOf(2);
    expect(rows[0].packageLocation).to.not.equal(rows[1].packageLocation);
    const tree = `/root/${treeMountOf(left)}/`;
    for (const row of rows) {
      expect(row.packageLocation).to.match(new RegExp(`^\\./${TREE_MOUNT}/__virtual__/[0-9a-f]{16}/0/`));
      expect(resolveVirtual(path.posix.join("/root", row.packageLocation))).to.equal(tree);
    }
    expect(dependencyOf(rows[0], "dep")).to.not.equal(dependencyOf(rows[1], "dep"));
  });

  it("tells apart wirings that differ only below their direct dependencies", () => {
    /* shared@1 → mid@1 in both deliveries; the two mids differ only in which
     * leaf they bind. The id-level line of shared is the same for both, so only
     * structural identity sees two nodes — and each shared must resolve mid to
     * its own mid. */
    const shared = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
    const mid = new Map<string, IFile>([["index.js", MemoryFile.from("// mid")]]);
    const left = new PackageFileSet(shared, "shared", "1.0.0", [new PackageFileSet(mid, "mid", "1.0.0", [pkg("leaf", "1.0.0")])]);
    const right = new PackageFileSet(shared, "shared", "1.0.0", [new PackageFileSet(mid, "mid", "1.0.0", [pkg("leaf", "2.0.0")])]);
    const manifest = pnpManifestOf([pkg("left", "1.0.0", [left]), pkg("right", "1.0.0", [right])]);
    const rows = [...rowsOf(manifest, "shared").values()];
    expect(rows).to.have.lengthOf(2);
    expect(dependencyOf(rows[0], "mid")).to.not.equal(dependencyOf(rows[1], "mid"));
    expect(rows[0].packageLocation).to.not.equal(rows[1].packageLocation);
  });

  it("keeps one location for one wiring of a content, whatever it is called", () => {
    const real = pkg("stream-browserify", "3.0.0");
    const manifest = pnpManifestOf([real, pkg("user", "1.0.0", [real.withPackageName("stream")])]);
    expect(manifest.mountOf(real)).to.equal(treeMountOf(real));
    expect(manifest.mountOf(real.withPackageName("stream"))).to.equal(treeMountOf(real));
  });

  it("mounts an aliased package under the name its requirer knows it by", () => {
    const real = pkg("stream-browserify", "3.0.0");
    const manifest = pnpManifestOf([real.withPackageName("stream")]);
    const aliased = [...rowsOf(manifest, "stream").values()][0];
    /* One content entry, reached under the alias: the restamp is a row, never a
     * copy. */
    expect(aliased.packageLocation).to.equal(`./${treeMountOf(real)}/`);
    expect(rowsOf(manifest, "stream-browserify").size).to.equal(0);
  });

  it("gives a cycle's members rows that resolve each other, without recursion", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// a")]]), "a", "1.0.0");
    const b = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// b")]]), "b", "1.0.0");
    builder.wire(a, [b]);
    builder.wire(b, [a]);
    builder.seal();

    const manifest = pnpManifestOf([a]);
    const [referenceA, rowA] = [...rowsOf(manifest, "a")][0];
    const [referenceB, rowB] = [...rowsOf(manifest, "b")][0];
    /* A reference is a label, not a summary of what it reaches — so a cycle
     * needs no special treatment at all: each member is its own row, and they
     * name each other. */
    expect(referenceA).to.not.equal(referenceB);
    expect(dependencyOf(rowA, "b")).to.equal(referenceB);
    expect(dependencyOf(rowB, "a")).to.equal(referenceA);
    expect(rowA.packageLocation).to.not.equal(rowB.packageLocation);
  });

  it("ignores deps that are not packages", () => {
    const manifest = pnpManifestOf([pkg("left-pad"), new Flag("ts/no_strict", []), new FileSet(new Map())]);
    expect(manifest.packages.map(pkg => pkg.packageName)).to.deep.equal(["left-pad"]);
  });

  it("pools the declared direct deps, never a transitive package", () => {
    /* The `reactcss` shape: a delivered package importing something it never
       declared resolves when the consumer declares that name itself — and only
       then, so the remedy for the failure is adding the dep. */
    const deep = pkg("deep");
    const manifest = pnpManifestOf([pkg("top", "1.0.0", [pkg("middle", "1.0.0", [deep])]), pkg("peer")]);
    const pooled = manifest.state.fallbackPool.map(([name]) => name);
    expect(pooled).to.deep.equal(["peer", "top"]);
  });

  it("still supplies a barred package with what the project declared", () => {
    /* A node-builtin shim is named once for the whole bundle
       (`@dep:path-browserify -> path`) and is meant to answer for every package
       in it — including first-party ones, which is where the imports of `path`
       actually are. A package barred from the pool carries the declared surface
       in its own row instead. */
    const shim = pkg("path");
    const ours = built("@shorthand/appcore", "1.0.0", [pkg("lodash")]);
    const manifest = pnpManifestOf([ours, shim, pkg("three")]);
    const row = [...rowsOf(manifest, "@shorthand/appcore").values()][0]!;
    const visible = row.packageDependencies.map(([name]) => name);
    /* Its own name, its own dependency, and the project's declared supplies. */
    expect(visible).to.deep.equal(["@shorthand/appcore", "lodash", "path", "three"]);
    /* A package the project did NOT declare stays out of reach: the row carries
       the declared surface, not the closure the pool holds. */
    const deep = built("@shorthand/other", "1.0.0", [pkg("outer", "1.0.0", [pkg("buried")])]);
    const wider = pnpManifestOf([deep]);
    const otherRow = [...rowsOf(wider, "@shorthand/other").values()][0]!;
    expect(otherRow.packageDependencies.map(([name]) => name)).to.deep.equal(["@shorthand/other", "outer"]);
    expect(wider.state.fallbackPool.map(([name]) => name)).to.not.contain("buried");
  });

  it("bars the packages this project built from the pool", () => {
    /* A package fabr produced does not read the pool (its row carries the
       declared surface instead — see above); packages that came from a
       repository do. */
    const ours = built("@shorthand/ui", "1.0.0", [pkg("react")]);
    const manifest = pnpManifestOf([ours, pkg("chalk")]);
    expect(manifest.state.fallbackExclusionList.map(([name]) => name)).to.deep.equal(["@shorthand/ui"]);
    /* The exclusion says who may not read the pool, never what is in it: an
       excluded direct dep is still pooled. */
    expect(manifest.state.fallbackPool.map(([name]) => name)).to.deep.equal(["@shorthand/ui", "chalk"]);
  });

  it("is byte-stable: the same graph in any order yields the same manifest", async () => {
    const shared = pkg("shared");
    const first = pnpManifestOf([pkg("a", "1.0.0", [shared]), pkg("b", "1.0.0", [shared])]);
    const second = pnpManifestOf([pkg("b", "1.0.0", [shared]), pkg("a", "1.0.0", [shared])]);
    expect(await toPromise(second.toFile().readString())).to.equal(await toPromise(first.toFile().readString()));
  });

  it("emits the documented schema, verbatim", async () => {
    /* A golden test on the BYTES: this file is what every PnP-aware consumer
     * reads (esbuild natively, fabr's tsc driver, a node loader later), and it
     * is also the one input the compile's cache key hashes — so a change to it
     * is a change to both, and must be a deliberate one. */
    const manifest = pnpManifestOf([pkg("chalk", "1.0.0", [pkg("ansi-styles")])]);
    const bytes = await toPromise(manifest.toFile().readString());
    /* Read back by NAME, not by position: what the golden text pins is the
     * shape and the ordering of the emitted document, not the order the graph
     * happened to be walked in. */
    const locate = (name: string): string => rowsOf(manifest, name).values().next().value!.packageLocation;
    const reference = (name: string): string => [...rowsOf(manifest, name).keys()][0]!;
    const keys = [locate("ansi-styles"), locate("chalk")];
    const references = [reference("ansi-styles"), reference("chalk")];
    expect(bytes).to.equal(
      `{
  "__info": [
    "This file is generated by fabr. It maps every package this build resolved to",
    "its content-addressed directory in the build cache's tree pool."
  ],
  "dependencyTreeRoots": [],
  "enableTopLevelFallback": true,
  "ignorePatternData": null,
  "fallbackExclusionList": [],
  "fallbackPool": [
    [
      "chalk",
      ${JSON.stringify(references[1])}
    ]
  ],
  "packageRegistryData": [
    [
      null,
      [
        [
          null,
          {
            "packageLocation": "./",
            "packageDependencies": [
              [
                "chalk",
                ${JSON.stringify(references[1])}
              ]
            ],
            "linkType": "SOFT"
          }
        ]
      ]
    ],
    [
      "ansi-styles",
      [
        [
          ${JSON.stringify(references[0])},
          {
            "packageLocation": ${JSON.stringify(keys[0])},
            "packageDependencies": [
              [
                "ansi-styles",
                ${JSON.stringify(references[0])}
              ]
            ],
            "linkType": "HARD"
          }
        ]
      ]
    ],
    [
      "chalk",
      [
        [
          ${JSON.stringify(references[1])},
          {
            "packageLocation": ${JSON.stringify(keys[1])},
            "packageDependencies": [
              [
                "ansi-styles",
                ${JSON.stringify(references[0])}
              ],
              [
                "chalk",
                ${JSON.stringify(references[1])}
              ]
            ],
            "linkType": "HARD"
          }
        ]
      ]
    ]
  ]
}
`
    );
  });
});

describe("treeMountOf", () => {
  it("keys a package by its content alone", () => {
    /* Not by its name, its version, or what it resolves against: an entry
     * carries none of those, so two deliveries of the same bytes are one
     * directory however differently they are composed. */
    const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
    const left = new PackageFileSet(content, "shared", "1.0.0", [pkg("dep", "1.0.0")]);
    const right = new PackageFileSet(content, "shared", "2.0.0", [pkg("dep", "2.0.0")]);
    expect(treeMountOf(left)).to.equal(treeMountOf(right));
  });

  it("names the entry by the content digest the rest of the system uses", () => {
    /* The point of using it raw: one hex string traces a pool directory back to
     * the package node that named it, through a signature or an action
     * manifest, with nothing to un-salt on the way — and it is the same name
     * the cache derives for itself from the files (BuildCache.ensureTree). */
    const delivered = pkg("tar-stream", "1.0.0", [pkg("b4a")]);
    expect(treeMountOf(delivered)).to.equal(`.fabr-tree/${delivered.toManifestHash()}`);
    expect(packageNodeSignature(delivered)).to.contain(delivered.toManifestHash());
  });

  it("keys different bytes apart, including a mode change", () => {
    expect(treeMountOf(pkg("a"))).to.not.equal(treeMountOf(pkg("a", "2.0.0")));
    const executable = new PackageFileSet(
      new Map<string, IFile>([["index.js", new MemoryFile(Buffer.from("// a@1.0.0"), 0o755)]]),
      "a",
      "1.0.0"
    );
    expect(treeMountOf(executable)).to.not.equal(treeMountOf(pkg("a")));
  });
});
