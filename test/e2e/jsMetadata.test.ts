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

/* A js_package's `metadata` MAP overlays descriptive fields onto the generated
 * package.json; a key fabr computes itself (name/version/...) is rejected. */
describe("e2e: js_package metadata", () => {
  const base = {
    ...STUB_TSC,
    "src/index.ts": "export const x = 1;\n",
  };
  const projectWith = (metadata: string): Record<string, string> => ({
    ...base,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      `\njs_package thing { srcs = src:**/*; metadata = { ${metadata} } }\n`,
  });

  it("overlays declared metadata onto the generated package.json", () => {
    const result = runFabr(projectWith("description = A build tool; license = MIT;"), [
      "-DJS_TARGET=es2020",
      "cat",
      "thing:package.json",
    ]);
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg.description).to.equal("A build tool");
    expect(pkg.license).to.equal("MIT");
    /* fabr-computed identity is unaffected. */
    expect(pkg.name).to.equal("thing");
  });

  it("rejects a metadata key fabr computes itself", () => {
    const result = runFabr(projectWith("name = evil;"), ["-DJS_TARGET=es2020", "cat", "thing:package.json"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("metadata key 'name' is set by fabr");
  });

  it("rejects ${...}-interpolating a map, teaching the bare-name idiom", () => {
    const project = {
      ...base,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\nSHARED_META = { license = MIT; };\n" +
        "js_package thing { srcs = src:**/*; metadata = ${SHARED_META}; }\n",
    };
    const result = runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:package.json"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("'SHARED_META' is a map and cannot be used as a string");
    expect(result.stderr).to.contain("referenced by bare name");
  });

  it("encodes sub-maps as objects and block lists as arrays of objects", () => {
    const result = runFabr(
      projectWith(
        "repository = { type = git; url = https://example.com/r.git; }; " +
          "maintainers = { name = ann; } { name = bob; };"
      ),
      ["-DJS_TARGET=es2020", "cat", "thing:package.json"]
    );
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg.repository).to.deep.equal({ type: "git", url: "https://example.com/r.git" });
    expect(pkg.maintainers).to.deep.equal([{ name: "ann" }, { name: "bob" }]);
  });

  it("splices a shared map and overrides per-target entries", () => {
    const project = {
      ...base,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\nSHARED_META = { license = MIT; description = generic; };\n" +
        "js_package thing { srcs = src:**/*; metadata = { SHARED_META; description = CLI package; }; }\n",
    };
    const result = runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:package.json"]);
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg.license).to.equal("MIT");
    expect(pkg.description).to.equal("CLI package");
  });

  it("attributes a rejected computed key through the splice it arrived by", () => {
    const project = {
      ...base,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\nSHARED_META = { name = evil; };\n" +
        "js_package thing { srcs = src:**/*; metadata = { SHARED_META; }; }\n",
    };
    const result = runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:package.json"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("metadata key 'name' is set by fabr");
    /* The origin chain: the written entry in the shared map, via the splice. */
    expect(result.stderr).to.contain("(via 'SHARED_META')");
    expect(result.stderr).to.contain("name = evil;");
  });

  it("shares a block-valued property across targets by bare reference", () => {
    const project = {
      ...base,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\nSHARED_META = { license = MIT; author = fabr; };\n" +
        "js_package thing { srcs = src:**/*; metadata = SHARED_META; }\n",
    };
    const result = runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:package.json"]);
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg.license).to.equal("MIT");
    expect(pkg.author).to.equal("fabr");
  });
});
