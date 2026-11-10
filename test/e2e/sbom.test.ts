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
import { runFabr, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/* `fabr sbom` writes the bill of materials of one target: the target as the
 * component described, and every package among what its rule requires as a
 * component, with the dependency graph. The fixture's packages are all built in
 * the project, so none has a purl, a licence or a digest to publish. */
const PROJECT =
  "plugin @fabr-build/js;\n\n" +
  STUB_TSC_CONFIG +
  "\njs_package sbom_base { srcs = base:**; }\n" +
  "js_package sbom_lib { srcs = lib:**; deps = sbom_base; }\n" +
  "js_package sbom_app { srcs = app:**; deps = sbom_lib sbom_base; version = 1.2.3; }\n";
const FILES = {
  ...STUB_TSC,
  "base/index.ts": 'exports.base = "sbom e2e base";\n',
  "lib/index.ts": 'exports.lib = "sbom e2e lib";\n',
  "app/index.ts": 'exports.app = "sbom e2e app";\n',
};

describe("e2e: fabr sbom", () => {
  it("writes a CycloneDX bill of the target and the packages it requires, building nothing", () => {
    const result = runFabr({ "PROJECT.fabr": PROJECT, ...FILES }, ["sbom", "sbom_app"]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.not.contain("Compiling");
    const bom = JSON.parse(result.stdout);
    expect(bom.bomFormat).to.equal("CycloneDX");
    expect(bom.specVersion).to.equal("1.6");
    expect(bom.metadata.tools.components[0].name).to.equal("fabr");
    expect(bom.metadata.component).to.deep.equal({
      type: "application",
      "bom-ref": "sbom_app@1.2.3",
      name: "sbom_app",
      version: "1.2.3",
    });
    expect(bom.components).to.deep.equal([
      { type: "library", "bom-ref": "sbom_base", name: "sbom_base" },
      { type: "library", "bom-ref": "sbom_lib", name: "sbom_lib" },
    ]);
    expect(bom.dependencies).to.deep.equal([
      { ref: "sbom_app@1.2.3", dependsOn: ["sbom_base", "sbom_lib"] },
      { ref: "sbom_base", dependsOn: [] },
      { ref: "sbom_lib", dependsOn: ["sbom_base"] },
    ]);
  });

  it("makes a target another reads for its files a component of it, with everything it requires", () => {
    const project = PROJECT + "script sbom_tool { entry = ./tool.sh; deps = sbom_lib:**; }\n";
    const result = runFabr({ "PROJECT.fabr": project, ...FILES, "tool.sh": "echo tool\n" }, ["sbom", "sbom_tool"]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.not.contain("Compiling");
    const bom = JSON.parse(result.stdout);
    expect(bom.dependencies).to.deep.equal([
      { ref: "sbom_tool", dependsOn: ["sbom_lib"] },
      { ref: "sbom_base", dependsOn: [] },
      { ref: "sbom_lib", dependsOn: ["sbom_base"] },
    ]);
  });

  it("takes one target", () => {
    const result = runFabr({ "PROJECT.fabr": PROJECT, ...FILES }, ["sbom", "sbom_app", "sbom_lib"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/takes a single target/);
  });
});
