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

/* A compiled package's maps name each source by the fabr reference that
 * resolves to it: a project file by its path from the project root, a file a
 * declared target built by that target. The stub tsc writes the map from the
 * table the build staged, so what is tested is the build's half: the
 * references the files carry, and the table and flags that reach the tool. */
describe("e2e: source maps name their sources by reference", () => {
  const project = {
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\nscript gen_tool { entry = gen.sh; }\n" +
      "generate gen { run = gen_tool > made.ts; }\n" +
      "js_package lib { srcs = src:**/*.ts gen:made.ts; }\n",
    "gen.sh": "echo 'export const made = 1;'\n",
    "src/index.ts": "export const x = 1;\n",
    "src/sub/deep.ts": "export const y = 2;\n",
  };

  const sources = (name: string): string[] => {
    const result = runFabr(project, ["cat", name]);
    expect(result.status, result.stderr).to.equal(0);
    return (JSON.parse(result.stdout) as { sources: string[] }).sources;
  };

  it("names a project file by its path from the project root", () => {
    expect(sources("lib:index.js.map")).to.deep.equal(["fabr:./src/index.ts"]);
    expect(sources("lib:sub/deep.js.map")).to.deep.equal(["fabr:./src/sub/deep.ts"]);
  });

  it("names a file a declared target built by that target", () => {
    expect(sources("lib:made.js.map")).to.deep.equal(["fabr:gen:made.ts"]);
  });

  it("names a source by a reference fabr resolves to it", () => {
    const result = runFabr(project, ["cat", "gen:made.ts"]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal("export const made = 1;\n");
  });

  it("names nothing in a release build, which emits no maps", () => {
    const result = runFabr(project, ["ls", "lib<BUILD_TYPE=release>"]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).not.to.contain(".map");
  });
});
