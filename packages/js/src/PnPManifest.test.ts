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
import { IPnpPackageInfo, pnpManifestOf, PnpDependencyTarget, treeMountOf } from "./PnPManifest";

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
    /* Same bytes, so one directory — the location is content, the row is not. */
    expect(rows[0][1].packageLocation).to.equal(rows[1][1].packageLocation);
    expect(dependencyOf(rows[0][1], "core")).to.not.equal(dependencyOf(rows[1][1], "core"));
  });

  it("gives the same content under two environments distinct references sharing one location", () => {
    /* Two deliveries of one package differing only in what they resolve: PnP's
     * virtual instances, content-addressed — the fork costs table rows, not a
     * second tree on disk. */
    const content = new Map<string, IFile>([["index.js", MemoryFile.from("// shared")]]);
    const left = new PackageFileSet(content, "shared", "1.0.0", [pkg("dep", "1.0.0")]);
    const right = new PackageFileSet(content, "shared", "1.0.0", [pkg("dep", "2.0.0")]);
    const manifest = pnpManifestOf([pkg("left", "1.0.0", [left]), pkg("right", "1.0.0", [right])]);
    const rows = [...rowsOf(manifest, "shared").values()];
    expect(rows).to.have.lengthOf(2);
    expect(rows[0].packageLocation).to.equal(rows[1].packageLocation);
    expect(dependencyOf(rows[0], "dep")).to.not.equal(dependencyOf(rows[1], "dep"));
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

  it("pools the whole closure, not just the declared surface", () => {
    /* The `reactcss` shape: a delivered package importing something it never
       declared. It works under every other package manager because everything
       is hoisted where everyone can see it, and no build can fix the package,
       so the pool carries the closure rather than the declared roots. */
    const deep = pkg("deep");
    const manifest = pnpManifestOf([pkg("top", "1.0.0", [pkg("middle", "1.0.0", [deep])])]);
    const pooled = manifest.state.fallbackPool.map(([name]) => name);
    expect(pooled).to.deep.equal(["deep", "middle", "top"]);
  });

  it("still supplies a barred package with what the project declared", () => {
    /* The regression this guards: a node-builtin shim is named once for the
       whole bundle (`@dep:path-browserify -> path`) and is meant to answer for
       every package in it — including first-party ones, which is where the
       imports of `path` actually are. Barring those packages from the pool must
       not take the project's own supplies away with it, so the declared surface
       is written into their rows instead. */
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
    expect(wider.state.fallbackPool.map(([name]) => name)).to.contain("buried");
  });

  it("bars the packages this project built from the pool", () => {
    /* The strictness that still pays. A package fabr produced is one whose
       undeclared import is a bug with an author here, and whose `.js` sources
       are transpiled without ever being typechecked — so nothing else would
       catch it. Packages that came from a repository keep the pool. */
    const ours = built("@shorthand/ui", "1.0.0", [pkg("react")]);
    const manifest = pnpManifestOf([ours, pkg("chalk")]);
    expect(manifest.state.fallbackExclusionList.map(([name]) => name)).to.deep.equal(["@shorthand/ui"]);
    /* Everything is still POOLED — the exclusion says who may not read the
       pool, never what is in it, so an excluded package is still reachable. */
    expect(manifest.state.fallbackPool.map(([name]) => name)).to.deep.equal(["@shorthand/ui", "chalk", "react"]);
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
      "ansi-styles",
      ${JSON.stringify(references[0])}
    ],
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
