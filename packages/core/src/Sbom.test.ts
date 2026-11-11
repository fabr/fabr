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
import { Computable } from "./core/Computable";
import { EMPTY_FILESET } from "./core/FileSet";
import { Dependency, ResolvedNode } from "./core/PackageFileSet";
import { IVersionMetadata, RefSource, RepositoryRef } from "./core/Repository";
import { TargetRef, TargetSource } from "./core/TargetRef";
import { ResolvedRequirements, ResolvedTarget } from "./context/index";
import { PackageFormat } from "./resolver/PackageFormat";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./resolver/ResolutionProvenance";
import { NO_CONFLICTS } from "./resolver/StrictCollection";
import { ResolvedCollection } from "./resolver/Types";
import { ResolvedName } from "./Fabr";
import { cycloneDxHash, cycloneDxLicense, cycloneDxNaming, sbom } from "./Sbom";

/** A collection for requirements made by hand, which nothing here asks of. */
const NO_COLLECTION = {} as ResolvedCollection;

/** A format whose purls are `pkg:test/<name>@<version>`; nothing here resolves with it. */
const TEST_FORMAT = { purl: (name: string, version: string) => `pkg:test/${name}@${version}` } as unknown as PackageFormat<
  unknown,
  unknown
>;

function resolvedFrom(name: string, version: string): IResolutionOrigin<string> {
  return {
    kind: PACKAGE_RESOLUTION_PROVENANCE,
    root: { name, versionConstraint: undefined },
    selections: [{ name, version }],
    versionToString: version => version,
    format: TEST_FORMAT,
  };
}

/** A registry package at `version`, resolved and unfetched, publishing `metadata` where given. */
function registry(name: string, version: string, dependencies: Dependency[] = [], metadata?: IVersionMetadata): Dependency {
  const content = {
    key: `fetch ${name}@${version}`,
    files: () => Computable.resolve(EMPTY_FILESET),
    ...(metadata === undefined ? {} : { metadata: () => Computable.resolve(metadata) }),
  };
  return {
    reference: new RepositoryRef({} as RefSource, { name, versionConstraint: `^${version}` }),
    package: new ResolvedNode(content, name, version, dependencies, resolvedFrom(name, version)),
  };
}

/** A target's node, resolved and unbuilt, in `configuration`. */
function built(name: string, configuration = "", dependencies: Dependency[] = []): Dependency {
  return {
    reference: new TargetRef({} as TargetSource, name),
    package: new ResolvedNode(
      { key: `built ${name} ${configuration}`, files: () => Computable.resolve(EMPTY_FILESET), builds: name, configuration },
      name,
      undefined,
      dependencies,
      { kind: "target" }
    ),
  };
}

/** A target made from the package `from` is the edge to, as `patched` makes one, its build declared to fix `fixes`. */
class PatchedTarget extends ResolvedTarget {
  public readonly resolved: ResolvedRequirements;

  constructor(name: string, from: Dependency, fixes: string[]) {
    const pkg = from.package!;
    super(
      { key: `built ${name}`, files: () => Computable.resolve(EMPTY_FILESET), builds: name },
      name,
      pkg.version,
      pkg.dependencies,
      {
        kind: "target",
      }
    );
    this.resolved = new ResolvedRequirements(
      new Map([["extends", { sources: [pkg], references: [from.reference], reading: "packages", part: 0 }]]) as never,
      [{ conflicts: NO_CONFLICTS, conflictsAmong: () => Computable.resolve(NO_CONFLICTS), collection: NO_COLLECTION }],
      false,
      undefined,
      fixes
    );
  }

  public materialize(): Computable<never[]> {
    return Computable.resolve([]);
  }

  public projectBuilt(): never[] {
    return [];
  }
}

/** A target `name` building `builds` whose rule requires the one requirement
 * `requirement`, holding `deps`: the package each edge binds, or its reference
 * where it binds none (a target read for its files). */
class RequiringTarget extends ResolvedTarget {
  public readonly resolved: ResolvedRequirements;

  constructor(name: string, builds: string, requirement: string, deps: Dependency[]) {
    super({ key: `built ${name} ${requirement}`, files: () => Computable.resolve(EMPTY_FILESET), builds }, name, undefined, [], {
      kind: "target",
    });
    this.resolved = new ResolvedRequirements(
      new Map([
        [
          requirement,
          {
            sources: deps.map(dep => dep.package ?? dep.reference),
            references: deps.map(dep => dep.reference),
            reading: "packages",
            part: 0,
          },
        ],
      ]) as never,
      [{ conflicts: NO_CONFLICTS, conflictsAmong: () => Computable.resolve(NO_CONFLICTS), collection: NO_COLLECTION }],
      false
    );
  }

  public materialize(): Computable<never[]> {
    return Computable.resolve([]);
  }

  public projectBuilt(): never[] {
    return [];
  }
}

/** What `title` resolved to: the one package `dep` is the edge to. */
function named(title: string, dep: Dependency): ResolvedName {
  return { title, resolved: ResolvedRequirements.of([dep.package!], [dep.reference], NO_CONFLICTS, NO_COLLECTION) };
}

describe("sbom", () => {
  it("describes a package by its closure: each package a component by purl, with its licences, digests and edges", async () => {
    const semver = registry("semver", "7.6.3", [], {
      licenses: [{ text: "ISC" }],
      hashes: [{ algorithm: "sha512", encoding: "base64", value: Buffer.from("0123456789abcdef", "hex").toString("base64") }],
    });
    const lib = built("lib", "BUILD_TYPE=release", [semver]);
    const lodash = registry("lodash", "4.17.21", [], {
      licenses: [{ text: "MIT OR Apache-2.0" }],
      hashes: [{ algorithm: "sha1", encoding: "hex", value: "ABCDEF" }],
    });
    const express = registry("express", "4.19.2", [lodash, semver, lib], {
      licenses: [{ text: "Some Custom License", url: "https://example.com/LICENSE" }],
      hashes: [{ algorithm: "md5", encoding: "hex", value: "00" }],
    });
    const bom = await sbom(named("@npm:express:4.19.2", express), { version: "1.2.3" });
    expect(bom.bomFormat).to.equal("CycloneDX");
    expect(bom.specVersion).to.equal("1.6");
    expect(bom.metadata.tools.components).to.deep.equal([{ type: "application", "bom-ref": "fabr", name: "fabr", version: "1.2.3" }]);
    expect(bom.metadata.component).to.deep.equal({
      type: "library",
      "bom-ref": "pkg:test/express@4.19.2",
      name: "express",
      version: "4.19.2",
      purl: "pkg:test/express@4.19.2",
      licenses: [{ license: { name: "Some Custom License", url: "https://example.com/LICENSE" } }],
    });
    expect(bom.components).to.deep.equal([
      { type: "library", "bom-ref": "lib<BUILD_TYPE=release>", name: "lib" },
      {
        type: "library",
        "bom-ref": "pkg:test/lodash@4.17.21",
        name: "lodash",
        version: "4.17.21",
        purl: "pkg:test/lodash@4.17.21",
        licenses: [{ expression: "MIT OR Apache-2.0" }],
        hashes: [{ alg: "SHA-1", content: "abcdef" }],
      },
      {
        type: "library",
        "bom-ref": "pkg:test/semver@7.6.3",
        name: "semver",
        version: "7.6.3",
        purl: "pkg:test/semver@7.6.3",
        licenses: [{ license: { id: "ISC" } }],
        hashes: [{ alg: "SHA-512", content: "0123456789abcdef" }],
      },
    ]);
    expect(bom.dependencies).to.deep.equal([
      { ref: "pkg:test/express@4.19.2", dependsOn: ["lib<BUILD_TYPE=release>", "pkg:test/lodash@4.17.21", "pkg:test/semver@7.6.3"] },
      { ref: "lib<BUILD_TYPE=release>", dependsOn: ["pkg:test/semver@7.6.3"] },
      { ref: "pkg:test/lodash@4.17.21", dependsOn: [] },
      { ref: "pkg:test/semver@7.6.3", dependsOn: [] },
    ]);
  });

  it("makes a target read for its files a component of its reader, with everything it requires, however deep the reader", async () => {
    const lodash = registry("lodash", "4.17.21");
    const app = new RequiringTarget("app", "app", "deps", [lodash]);
    const read: Dependency = {
      reference: new TargetRef({ resolvedTarget: () => Computable.resolve(app) } as unknown as TargetSource, "app"),
    };
    const image = new RequiringTarget("image", "image", "files", [read]);
    const outer = new RequiringTarget("outer", "outer", "dependencies", [
      { reference: new TargetRef({} as TargetSource, "image"), package: image },
    ]);
    const bom = await sbom(
      {
        title: "outer",
        resolved: ResolvedRequirements.of([outer], [new TargetRef({} as TargetSource, "outer")], NO_CONFLICTS, NO_COLLECTION),
      },
      { version: "1.2.3" }
    );
    expect(bom.dependencies).to.deep.equal([
      { ref: "outer", dependsOn: ["image"] },
      { ref: "app", dependsOn: ["pkg:test/lodash@4.17.21"] },
      { ref: "image", dependsOn: ["app"] },
      { ref: "pkg:test/lodash@4.17.21", dependsOn: [] },
    ]);
  });

  it("gives a target made from a registry package that package as its ancestor, and the advisories its build fixes", async () => {
    const lodash = registry("lodash", "4.17.15");
    const patched: Dependency = {
      reference: new TargetRef({} as TargetSource, "lodash"),
      package: new PatchedTarget("lodash", lodash, ["CVE-2021-23337"]),
    };
    const bom = await sbom(named("app", built("app", "", [patched])), { version: "1.2.3" });
    expect(bom.components).to.deep.equal([
      {
        type: "library",
        "bom-ref": "lodash@4.17.15",
        name: "lodash",
        version: "4.17.15",
        pedigree: {
          ancestors: [{ type: "library", name: "lodash", version: "4.17.15", purl: "pkg:test/lodash@4.17.15" }],
          patches: [{ type: "unofficial", resolves: [{ type: "security", id: "CVE-2021-23337" }] }],
        },
      },
    ]);
  });

  it("describes a target under another operation by what its build requires", async () => {
    const lodash = registry("lodash", "4.17.15");
    const build = new RequiringTarget("app", "app", "deps", [lodash]);
    const run = new RequiringTarget("app", "app", "build", [{ reference: new TargetRef({} as TargetSource, "app"), package: build }]);
    const bom = await sbom(named("app", { reference: new TargetRef({} as TargetSource, "app"), package: run }), { version: "1.2.3" });
    expect(bom.components.map(component => component["bom-ref"])).to.deep.equal(["pkg:test/lodash@4.17.15"]);
    expect(bom.dependencies[0].dependsOn).to.deep.equal(["pkg:test/lodash@4.17.15"]);
  });

  it("refuses a name resolving to several things", () => {
    const a = registry("a", "1.0.0");
    const b = registry("b", "1.0.0");
    const name: ResolvedName = {
      title: "BOTH",
      resolved: ResolvedRequirements.of([a.package!, b.package!], [a.reference, b.reference], NO_CONFLICTS, NO_COLLECTION),
    };
    expect(() => sbom(name, { version: "1" })).to.throw(/'BOTH' resolves to 2 things/);
  });

  it("describes a declaration's requirements (a catalog's) as the declaration, by its name", async () => {
    const lodash = registry("lodash", "4.17.15");
    const express = registry("express", "4.17.1", [lodash]);
    const side = { sources: [express.package!], references: [express.reference], reading: "packages", part: 0 };
    const name: ResolvedName = {
      title: "@cat",
      resolved: new ResolvedRequirements(
        new Map([
          ["deps", side],
          ["run_deps", side],
        ]) as never,
        [{ conflicts: NO_CONFLICTS, conflictsAmong: () => Computable.resolve(NO_CONFLICTS), collection: NO_COLLECTION }],
        false
      ),
    };
    const bom = await sbom(name, { version: "1" });
    expect(bom.metadata.component).to.deep.equal({ type: "application", "bom-ref": "@cat", name: "@cat" });
    expect(bom.components.map(component => component["bom-ref"])).to.deep.equal([
      "pkg:test/express@4.17.1",
      "pkg:test/lodash@4.17.15",
    ]);
    expect(bom.dependencies[0]).to.deep.equal({ ref: "@cat", dependsOn: ["pkg:test/express@4.17.1"] });
  });
});

describe("cycloneDxNaming", () => {
  it("splits a purl's namespace from its name, decoded", () => {
    expect(cycloneDxNaming("pkg:npm/lodash@4.17.21")).to.deep.equal({ name: "lodash" });
    expect(cycloneDxNaming("pkg:npm/%40babel/core@7.24.0")).to.deep.equal({ group: "@babel", name: "core" });
    expect(cycloneDxNaming("pkg:maven/org.jacoco/org.jacoco.core@0.8.14")).to.deep.equal({
      group: "org.jacoco",
      name: "org.jacoco.core",
    });
  });
});

describe("cycloneDxLicense", () => {
  it("spells an SPDX id as an id, an expression as an expression, and anything else as a name", () => {
    expect(cycloneDxLicense({ text: "Apache-2.0" })).to.deep.equal({ license: { id: "Apache-2.0" } });
    expect(cycloneDxLicense({ text: "(MIT AND Zlib)" })).to.deep.equal({ expression: "(MIT AND Zlib)" });
    /* A bare token is an id only where the SPDX licence list has it. */
    expect(cycloneDxLicense({ text: "GPL-2.0" })).to.deep.equal({ license: { id: "GPL-2.0" } });
    expect(cycloneDxLicense({ text: "UNLICENSED" })).to.deep.equal({ license: { name: "UNLICENSED" } });
    expect(cycloneDxLicense({ text: "BSD" })).to.deep.equal({ license: { name: "BSD" } });
    expect(
      cycloneDxLicense({ text: "The Apache Software License, Version 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0.txt" })
    ).to.deep.equal({
      license: { name: "The Apache Software License, Version 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0.txt" },
    });
  });
});

describe("cycloneDxHash", () => {
  it("names the algorithm as CycloneDX does and writes the digest in hex", () => {
    expect(
      cycloneDxHash({ algorithm: "sha512", encoding: "base64", value: Buffer.from("ff00", "hex").toString("base64") })
    ).to.deep.equal({ alg: "SHA-512", content: "ff00" });
    expect(cycloneDxHash({ algorithm: "sha1", encoding: "hex", value: "ABC" })).to.deep.equal({ alg: "SHA-1", content: "abc" });
    expect(cycloneDxHash({ algorithm: "md5", encoding: "hex", value: "00" })).to.equal(undefined);
  });
});
