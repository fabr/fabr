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
import { PackageFileSet } from "../core/PackageFileSet";
import { FSFileSource } from "../core/FSFileSource";
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

const repository = (): FabrHomeRepository => new FabrHomeRepository("@fabr-build", new FSFileSource("/"), host);

describe("FabrHomeRepository", () => {
  it("delivers the installed package, its nested node_modules left out, with its installed dependencies", async () => {
    const repo = repository();
    const delivered = (await toPromise(repo.deliver(repo.getRepositoryRef(Name.fromLiteral("tool"))))) as PackageFileSet;
    expect(delivered.packageName).to.equal("@fabr-build/tool");
    expect(delivered.version).to.equal("1.2.3");
    expect([...delivered].map(([name]) => name).sort()).to.deep.equal(["index.js", "lib/x.js", "package.json"]);
    /* The optional dependency that is not installed is simply absent. */
    const deps = delivered.packages;
    expect(deps.map(dep => `${dep.packageName}@${dep.version}`)).to.deep.equal(["helper@1.0.0"]);
  });

  it("projects into the package after a ':'", () => {
    const ref = repository().getRepositoryRef(Name.fromLiteral("tool:lib/x.js"));
    expect(ref.name.toString()).to.equal("tool");
    expect(ref.projections).to.have.lengthOf(1);
  });

  it("fails for a package not installed with fabr", async () => {
    const repo = repository();
    const failure = await toPromise(repo.deliver(repo.getRepositoryRef(Name.fromLiteral("missing")))).then(
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
    const delivered = (await toPromise(repo.deliver(repo.getRepositoryRef(Name.fromLiteral("native"))))) as PackageFileSet;
    expect(delivered.dependencies).to.deep.equal([]);
  });

  it("names the installed manifest it cannot read", async () => {
    fs.writeFileSync(path.join(root, "node_modules", "helper", "package.json"), JSON.stringify({ version: 1 }));
    const repo = repository();
    const failure = await toPromise<FileSet>(repo.deliver(repo.getRepositoryRef(Name.fromLiteral("tool")))).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(failure).to.match(/Invalid .*node_modules\/helper\/package\.json: 'version' is not a string/);
  });

  it("fails for a required dependency that is not installed", async () => {
    fs.rmSync(path.join(root, "node_modules", "helper"), { recursive: true });
    const repo = repository();
    const failure = await toPromise<FileSet>(repo.deliver(repo.getRepositoryRef(Name.fromLiteral("tool")))).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(failure).to.match(/@fabr-build\/tool requires helper, which is not installed with fabr/);
  });
});
