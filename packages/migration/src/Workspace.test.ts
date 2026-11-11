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
import { writeProject } from "./TestProject";
import { parseOverrideKey, readWorkspace } from "./Workspace";

describe("reading a workspace", () => {
  it("finds the packages pnpm-workspace.yaml selects, and leaves out what it excludes", () => {
    const root = writeProject({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": 'packages:\n  - "lib/**"\n  - "app"\n  - "!**/fixtures/**"\n',
      "lib/a/package.json": { name: "a" },
      "lib/a/fixtures/b/package.json": { name: "fixture" },
      "lib/nested/c/package.json": { name: "c" },
      "app/package.json": { name: "app" },
      "other/package.json": { name: "other" },
      "lib/a/node_modules/x/package.json": { name: "x" },
    });
    expect(readWorkspace(root).packages.map(manifest => manifest.dir)).to.deep.equal(["app", "lib/a", "lib/nested/c"]);
  });

  it("finds yarn and npm's workspaces, or takes the root alone", () => {
    const root = writeProject({
      "package.json": { workspaces: { packages: ["packages/*"] } },
      "packages/a/package.json": { name: "a" },
    });
    expect(readWorkspace(root).packages.map(manifest => manifest.name)).to.deep.equal(["a"]);
    const single = writeProject({ "package.json": { name: "solo" } });
    expect(readWorkspace(single).packages.map(manifest => manifest.dir)).to.deep.equal([""]);
  });

  it("reads pnpm's catalogs and each place an override is written", () => {
    const root = writeProject({
      "package.json": {
        resolutions: { "**/a": "1.0.0", "b/@s/c": "2.0.0" },
        overrides: { d: "3.0.0", e: { ".": "4.0.0", f: "5.0.0" } },
      },
      "pnpm-workspace.yaml": "catalog:\n  react: ^18.2.0\ncatalogs:\n  legacy:\n    react: ^17.0.2\noverrides:\n  g>h: 6.0.0\n",
    });
    const workspace = readWorkspace(root);
    expect(workspace.catalogs.get("default")?.get("react")).to.equal("^18.2.0");
    expect(workspace.catalogs.get("legacy")?.get("react")).to.equal("^17.0.2");
    expect(workspace.overrides.map(o => `${[...o.path, o.name].join(">")}=${o.spec}`)).to.deep.equal([
      "g>h=6.0.0",
      "a=1.0.0",
      "b>@s/c=2.0.0",
      "d=3.0.0",
      "e=4.0.0",
      "e>f=5.0.0",
    ]);
  });

  it("reads the registries a scope is installed from", () => {
    const root = writeProject({
      "package.json": {},
      ".npmrc": "@corp:registry=https://npm.corp.example/\nregistry=https://registry.npmjs.org/\n",
      ".yarnrc.yml": "npmScopes:\n  other:\n    npmRegistryServer: https://other.example/\n",
    });
    const workspace = readWorkspace(root);
    expect([...workspace.scopeRegistries]).to.deep.equal([
      ["@corp", "https://npm.corp.example/"],
      ["@other", "https://other.example/"],
    ]);
    expect(workspace.registry).to.equal(undefined);
  });

  it("splits an override key into its path, the package and its range", () => {
    expect(parseOverrideKey("a>b@<2>@s/c@^1", ">")).to.deep.equal({ path: ["a", "b@<2"], name: "@s/c", range: "^1" });
    expect(parseOverrideKey("@s/a@>=1.0.0 <1.4.0", ">")).to.deep.equal({ path: [], name: "@s/a", range: ">=1.0.0 <1.4.0" });
    expect(parseOverrideKey("a/@s/b", "/")).to.deep.equal({ path: ["a"], name: "@s/b" });
  });
});
