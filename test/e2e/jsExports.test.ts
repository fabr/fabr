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

/* A js_package's `exports` names its public entry points as the sources they
 * compile from; fabr publishes each at the subpath its emitted file already sits
 * at. Declaring none leaves the package as it was — main/types by convention and
 * every emitted file reachable. */
describe("e2e: js_package exports", () => {
  const base = {
    ...STUB_TSC,
    "src/index.ts": "export const x = 1;\n",
    "src/internal.ts": "export const secret = 2;\n",
    "src/api/v1.ts": "export const v = 1;\n",
    "src/notes.txt": "not a module\n",
  };
  const projectWith = (properties: string): Record<string, string> => ({
    ...base,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + `\njs_package thing { srcs = src:**/*.ts; ${properties} }\n`,
  });

  const manifestOf = (properties: string): { status: number | null; stdout: string; stderr: string } =>
    runFabr(projectWith(properties), ["-DJS_TARGET=es2020", "cat", "thing:package.json"]);

  it("publishes no exports map for a package declaring no entry points", () => {
    const result = manifestOf("");
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg).to.not.have.property("exports");
    expect(pkg.main).to.equal("index.js");
  });

  it("publishes each declared entry point at its emitted file's subpath", () => {
    const result = manifestOf("exports = src:index.ts src:api/v1.ts;");
    expect(result.status).to.equal(0);
    const pkg = JSON.parse(result.stdout);
    expect(pkg.exports).to.deep.equal({
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./api/v1": { types: "./api/v1.d.ts", default: "./api/v1.js" },
      "./package.json": "./package.json",
    });
    /* `internal.ts` still ships — the map decides what is REACHABLE, not what is
     * built — and main/types stay by convention for whatever reads a manifest
     * without resolving one. */
    expect(pkg.main).to.equal("index.js");
  });

  it("compiles an entry point that srcs does not cover", () => {
    /* `exports` is a compile input in its own right (js_bundle's `entry` has the
     * same relation to its `srcs`), so a package may name one that `srcs` misses.
     * Naming a file BOTH ways is not a conflict — a union is by file identity. */
    const project = {
      ...base,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package thing { srcs = src:index.ts; exports = src:index.ts src:api/v1.ts; }\n",
    };
    const listed = runFabr(project, ["-DJS_TARGET=es2020", "ls", "thing"]);
    expect(listed.status).to.equal(0);
    expect(listed.stdout.split("\n")).to.contain("api/v1.js");
    expect(listed.stdout.split("\n")).to.not.contain("internal.js");

    const pkg = JSON.parse(runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:package.json"]).stdout);
    expect(Object.keys(pkg.exports)).to.deep.equal([".", "./api/v1", "./package.json"]);
  });

  it("rejects an entry point that emits no JavaScript", () => {
    const result = manifestOf("resources = src:notes.txt; exports = src:notes.txt;");
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("'notes.txt' is named in exports, but produces no JavaScript");
  });

  it("rejects a dependency named as an entry point", () => {
    const result = manifestOf("exports = es2023;");
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("exports names this package's own source files");
    expect(result.stderr).to.contain("'es2023' is a flag");
  });
});
