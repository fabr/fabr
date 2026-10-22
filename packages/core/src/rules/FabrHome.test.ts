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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { NamespaceRef } from "../core/NamespaceRef";
import { PackageFileSet, reachablePackages } from "../core/PackageFileSet";
import { FSFileSource } from "../core/FSFileSource";
import { RepositoryRef } from "../core/Repository";
import { FabrHomeRepository } from "./FabrHome";

/** A fixture installation: its `node_modules`, holding fabr's own package
 * (with `host` inside it, where fabr's code would be, looked up from) beside
 * the others. */
let root: string;
let host: string;

function install(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-home-")));
  install(path.join(root, "node_modules", "@fabr-build", "core"), { name: "@fabr-build/core", version: "1.0.0" });
  host = path.join(root, "node_modules", "@fabr-build", "core", "build");
  fs.mkdirSync(host, { recursive: true });
  install(
    path.join(root, "node_modules", "@fabr-build", "tool"),
    { name: "@fabr-build/tool", version: "1.2.3", dependencies: { helper: "^1.0.0" }, optionalDependencies: { absent: "^1.0.0" } },
    { "index.js": "tool", "lib/x.js": "x", "node_modules/nested/package.json": "{}" }
  );
  install(path.join(root, "node_modules", "helper"), { name: "helper", version: "1.0.0" }, { "index.js": "helper" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

const repository = (): FabrHomeRepository => new FabrHomeRepository(new FSFileSource("/"), host);

/** The reference `repo` vends for `name`, where that names a package. */
function packageRef(repo: FabrHomeRepository, name: Name): RepositoryRef {
  const ref = repo.getRepositoryRef(name);
  if (!(ref instanceof RepositoryRef)) {
    throw new Error(`'${name.toString()}' vended no package reference`);
  }
  return ref;
}

describe("FabrHomeRepository", () => {
  it("delivers the installed package, its nested node_modules left out, with its installed dependencies", async () => {
    const repo = repository();
    const reference = packageRef(repo, Name.fromLiteral("@fabr-build/tool"));
    const delivered = (await toPromise(repo.resolve(reference))) as PackageFileSet;
    expect(delivered.packageName).to.equal("@fabr-build/tool");
    /* Asked for by its full name, so an edge to it is named as the package is. */
    expect(reference.localName).to.equal(delivered.packageName);
    expect(delivered.version).to.equal("1.2.3");
    expect([...delivered].map(([name]) => name).sort()).to.deep.equal(["index.js", "lib/x.js", "package.json"]);
    /* The optional dependency that is not installed is simply absent. */
    const deps = delivered.packages;
    expect(deps.map(dep => `${dep.packageName}@${dep.version}`)).to.deep.equal(["helper@1.0.0"]);
  });

  it("delivers an installation with a cycle through the package as one graph, the package one node of it", async () => {
    /* helper requires tool back, as a plugin requires its host: the reference's
     * delivery leaves the graph as it is, so the edge back leads to the very
     * package delivered. */
    install(
      path.join(root, "node_modules", "helper"),
      { name: "helper", version: "1.0.0", dependencies: { "@fabr-build/tool": "*" } },
      { "index.js": "helper" }
    );
    const repo = repository();
    const reference = packageRef(repo, Name.fromLiteral("@fabr-build/tool"));
    const delivered = (await toPromise(repo.resolve(reference))) as PackageFileSet;
    expect(reference.applyTo(delivered)).to.equal(delivered);
    const tools = reachablePackages([delivered]).filter(pkg => pkg.packageName === "@fabr-build/tool");
    expect(tools).to.have.lengthOf(1);
    expect(delivered.packages[0].packages[0]).to.equal(delivered);
  });

  it("chains the reference's provenance into every package it delivers for it", async () => {
    const repo = repository();
    const step = { kind: "test-step" };
    const reference = packageRef(repo, Name.fromLiteral("@fabr-build/tool")).withStep(step);
    const delivered = (await toPromise(repo.resolve(reference))) as PackageFileSet;
    for (const pkg of reachablePackages([delivered])) {
      expect(pkg.origin?.kind).to.equal("test-step");
      expect(pkg.origin?.parent?.kind).to.equal("fabr-home");
    }
  });

  it("refuses an override marker: an installed package is not resolved", () => {
    expect(() => repository().getRepositoryRef(Name.fromLiteral("@fabr-build/tool!").withMarker())).to.throw(
      "'@fabr-build/tool!' is installed with fabr, not resolved, so an override marker means nothing on it"
    );
  });

  it("names a bare scope as the namespace of it, which a package name goes on from", () => {
    const scope = repository().getRepositoryRef(Name.fromLiteral("@fabr-build"));
    expect(scope).to.be.instanceOf(NamespaceRef);
    expect((scope as NamespaceRef).name).to.equal("@fabr-build");
  });

  it("projects into the package after a ':'", () => {
    const ref = packageRef(repository(), Name.fromLiteral("@fabr-build/tool:lib/x.js"));
    expect(ref.name.toString()).to.equal("@fabr-build/tool");
    expect(ref.projections).to.have.lengthOf(1);
  });

  it("fails for a package not installed with fabr", async () => {
    const repo = repository();
    const failure = await toPromise(repo.resolve(packageRef(repo, Name.fromLiteral("@fabr-build/missing")))).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(failure).to.match(/@fabr-build\/missing is not installed with fabr/);
  });

  it("treats a name listed as both a dependency and an optional one as optional, as npm does", async () => {
    install(
      path.join(root, "node_modules", "@fabr-build", "native"),
      { name: "@fabr-build/native", version: "1.0.0", dependencies: { "native-other-os": "1.0.0" }, optionalDependencies: { "native-other-os": "1.0.0" } },
      { "index.js": "native" }
    );
    const repo = repository();
    const delivered = (await toPromise(repo.resolve(packageRef(repo, Name.fromLiteral("@fabr-build/native"))))) as PackageFileSet;
    expect(delivered.dependencies).to.deep.equal([]);
  });

  it("names the installed manifest it cannot read", async () => {
    fs.writeFileSync(path.join(root, "node_modules", "helper", "package.json"), JSON.stringify({ version: 1 }));
    const repo = repository();
    const failure = await toPromise<FileSet>(repo.resolve(packageRef(repo, Name.fromLiteral("@fabr-build/tool")))).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(failure).to.match(/Invalid .*node_modules\/helper\/package\.json: 'version' is not a string/);
  });

  it("fails for a required dependency that is not installed", async () => {
    fs.rmSync(path.join(root, "node_modules", "helper"), { recursive: true });
    const repo = repository();
    const failure = await toPromise<FileSet>(repo.resolve(packageRef(repo, Name.fromLiteral("@fabr-build/tool")))).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(failure).to.match(/@fabr-build\/tool requires helper, which is not installed with fabr/);
  });
});
