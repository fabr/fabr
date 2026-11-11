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
import { Catalog } from "./Catalog";
import { renderBuildFile, renderCatalogFile, renderProjectFile } from "./Emit";
import { readManifest } from "./Manifest";
import { Report } from "./Report";
import { writeProject } from "./TestProject";

describe("rendering the fabr files", () => {
  it("writes the catalog's entries, then its pins and sanctions by section", () => {
    const catalog = new Catalog(new Map([["@corp", "@corp-registry"]]));
    catalog.entries.set("a", { address: "a", repository: "@npm", packageName: "a", range: "^1.0.0" });
    catalog.entries.set("f", {
      address: "f",
      repository: "@npm",
      packageName: "f",
      range: "2.0.0",
      forced: true,
      note: "forced: an override",
    });
    catalog.raise("b", "1.4.0", "raise");
    catalog.raise("@types/c", "3.0.0", "floorless");
    catalog.sanction("ms", "2.1.3");
    catalog.sanction("ms", "2.0.0");
    const text = renderCatalogFile(catalog, {
      lockfile: "yarn.lock",
      scopeRegistries: new Map([["@corp", "https://npm.corp.example/"]]),
    });
    expect(text).to.equal(
      [
        "# Written by fabr-migrate from package.json and yarn.lock.",
        "",
        "npm_repository @corp-registry {",
        "  url = https://npm.corp.example/;",
        "}",
        "",
        "catalog @dep {",
        "  deps =",
        "    @npm:a:^1.0.0",
        "    # forced: an override",
        "    @npm:f:2.0.0!",
        "",
        "    # Raised to the versions yarn.lock installs, where the declared floors give lower ones.",
        "    @npm:b:^1.4.0",
        "",
        "    # Required only without a lower bound: the versions yarn.lock installs.",
        "    @npm:@types/c:^3.0.0",
        "",
        "    # Packages that ship at several versions, as yarn.lock installs them.",
        "    @npm:ms:2.0.0? @npm:ms:2.1.3?;",
        "}",
        "",
      ].join("\n")
    );
  });

  it("writes the project file", () => {
    expect(renderProjectFile({ buildFiles: ["a/BUILD.fabr"], typescript: "@dep:typescript", testFramework: "jest" })).to.equal(
      [
        "# Written by fabr-migrate.",
        "plugin @fabr-build/js;",
        "",
        "# The registry dependencies, with the pins the project needs.",
        "include ./CATALOG.fabr;",
        "",
        "include ./a/BUILD.fabr;",
        "",
        "TYPESCRIPT = @dep:typescript;",
        "JS_TEST_FRAMEWORK = jest;",
        "",
      ].join("\n")
    );
  });

  it("writes a package's target, one value per line where they do not fit on one", () => {
    const manifest = readManifest(writeProject({ "package.json": { name: "@s/a", version: "1.0.0" } }), "");
    const deps = Array.from({ length: 8 }, (_, at) => `@dep:package-number-${at}`);
    const text = renderBuildFile({
      manifest,
      target: "@s/a",
      srcs: ["src:**/*.ts"],
      tests: [],
      deps,
      provided: ["@dep:react"],
      optionalProvided: [],
      report: new Report(),
    });
    expect(text.split("\n")).to.deep.equal([
      "# Written by fabr-migrate from package.json.",
      "js_package @s/a {",
      "  srcs = src:**/*.ts;",
      ...deps.map((dep, at) => `${at === 0 ? "  deps = " : "         "}${dep}${at === deps.length - 1 ? ";" : ""}`),
      "  provided_deps = @dep:react;",
      "  version = 1.0.0;",
      "}",
      "",
    ]);
  });
});
