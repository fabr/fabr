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
import { buildCatalog, Catalog, compareFloors, entryReference } from "./Catalog";
import { Report } from "./Report";
import { writeProject } from "./TestProject";
import { readWorkspace } from "./Workspace";

/** @return each entry of `catalog` as its reference is written. */
const written = (catalog: Catalog): string[] => [...catalog.entries.values()].map(entryReference).sort();

describe("building the catalog", () => {
  it("takes a higher floor within a major, and reports a major the manifests disagree on", () => {
    const root = writeProject({
      "package.json": { workspaces: ["p/*"], devDependencies: { a: "^1.0.0", b: "^2.0.0" } },
      "p/x/package.json": { name: "x", dependencies: { a: "^1.4.0", b: "^3.0.0", y: "*" } },
      "p/y/package.json": { name: "y", version: "1.0.0" },
    });
    const report = new Report();
    const { catalog, addressOf } = buildCatalog(readWorkspace(root), undefined, report);
    expect(written(catalog)).to.deep.equal(["@npm:a:^1.4.0", "@npm:b:^2.0.0"]);
    expect(report.render().join("\n")).to.include("b: ^2.0.0, and ^3.0.0 in p/x/package.json");
    expect(addressOf(readWorkspace(root).packages[0], "y")).to.equal(undefined);
  });

  it("writes an alias as a rename, and a peer only where nothing else names the package", () => {
    const root = writeProject({
      "package.json": {
        dependencies: { "typescript-6": "npm:typescript@^6.0.0", react: "^18.2.0" },
        peerDependencies: { react: ">=16.8.0", "react-dom": ">=16.8.0" },
      },
    });
    const { catalog } = buildCatalog(readWorkspace(root), undefined, new Report());
    expect(written(catalog)).to.deep.equal(['@npm:react-dom:">=16.8.0"', "@npm:react:^18.2.0", "@npm:typescript:^6.0.0 -> typescript-6"]);
  });

  it("writes a named pnpm catalog's differing version under an alias", () => {
    const root = writeProject({
      "package.json": { workspaces: ["p/*"] },
      "pnpm-workspace.yaml": "catalog:\n  react: ^18.2.0\ncatalogs:\n  legacy:\n    react: ^17.0.2\n",
      "p/a/package.json": { name: "a", dependencies: { react: "catalog:" } },
      "p/b/package.json": { name: "b", dependencies: { react: "catalog:legacy" } },
    });
    const workspace = readWorkspace(root);
    const { catalog, addressOf } = buildCatalog(workspace, undefined, new Report());
    expect(written(catalog)).to.deep.equal(["@npm:react:^17.0.2 -> react-legacy", "@npm:react:^18.2.0"]);
    expect(addressOf(workspace.packages[1], "react")).to.deep.equal({ address: "react-legacy" });
  });

  it("forces an override that says what '!' says, and writes any other as a floor", () => {
    const root = writeProject({
      "package.json": {
        dependencies: { a: "^1.0.0", c: "^3.0.0" },
        pnpm: { overrides: { a: "1.2.3", "x>b": "2.0.0", c: "^3.4.0", "d@<2": "2.1.0" } },
      },
    });
    const report = new Report();
    const { catalog } = buildCatalog(readWorkspace(root), undefined, report);
    expect(written(catalog)).to.deep.equal(["@npm:a:1.2.3!", "@npm:b:2.0.0", "@npm:c:^3.4.0", "@npm:d:2.1.0"]);
  });

  it("writes a dist-tag as the version the lockfile installs", () => {
    const root = writeProject({ "package.json": { dependencies: { a: "latest" } } });
    const lockfile = { file: "yarn.lock", versions: new Map([["a", new Set(["1.0.0", "1.3.0"])]]) };
    const { catalog } = buildCatalog(readWorkspace(root), lockfile, new Report());
    expect(written(catalog)).to.deep.equal(["@npm:a:^1.3.0"]);
  });

  it("resolves a scope's packages from its registry", () => {
    const root = writeProject({ "package.json": { dependencies: { "@corp/a": "^1.0.0" } }, ".npmrc": "@corp:registry=https://npm.corp.example/\n" });
    const { catalog } = buildCatalog(readWorkspace(root), undefined, new Report());
    expect(written(catalog)).to.deep.equal(["@corp-registry:@corp/a:^1.0.0"]);
  });

  it("compares floors within a major", () => {
    expect(compareFloors("^1.4.0", "^1.2.0")).to.equal("raise");
    expect(compareFloors("^1.0.0", "^1.2.0")).to.equal("");
    expect(compareFloors("^2.0.0", "^1.2.0")).to.equal("differ");
    expect(compareFloors("*", "^1.2.0")).to.equal("");
    expect(compareFloors("^1.0.0", "*")).to.equal("raise");
    expect(compareFloors("2.0.0-rc.1", "^1.0.0")).to.equal("");
  });
});

describe("pinning the catalog", () => {
  it("raises an entry, keeping a '~', and adds one for a package no manifest declares", () => {
    const catalog = new Catalog();
    catalog.entries.set("a", { address: "a", repository: "@npm", packageName: "a", range: "~1.0.0" });
    expect(catalog.raise("a", "1.0.4", "raise")).to.equal(true);
    expect(catalog.raise("a", "1.0.4", "raise")).to.equal(false);
    expect(catalog.raise("b", "2.1.0", "raise")).to.equal(true);
    expect([...catalog.entries.values()].map(entry => [entryReference(entry), entry.pin])).to.deep.equal([
      ["@npm:a:~1.0.4", undefined],
      ["@npm:b:^2.1.0", "raise"],
    ]);
  });

  it("leaves a forced entry as it is", () => {
    const catalog = new Catalog();
    catalog.entries.set("a", { address: "a", repository: "@npm", packageName: "a", range: "1.0.0", forced: true });
    expect(catalog.raise("a", "1.2.0", "raise")).to.equal(false);
  });
});
