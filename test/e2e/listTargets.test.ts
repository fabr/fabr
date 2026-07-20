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
import { runFabr } from "./harness";

/* `fabr list-targets`: the model-query verb that prints the targets declared in
 * the project (name + type), recursively across namespaces, without building. */
describe("e2e: list-targets", () => {
  /* A `/`-qualified name (`tools/inner`) puts a target in a sub-namespace —
   * there is no `namespace` keyword; the namespace tree is formed from names. */
  const project = {
    "PROJECT.fabr": [
      "flag hello { provides = wibble; }",
      "flag world { provides = wobble; }",
      "flag tools/inner { provides = deep; }",
      "",
    ].join("\n"),
  };

  it("lists declared targets with their types, sub-namespaces qualified", () => {
    const result = runFabr(project, ["list-targets"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.match(/^hello\s+flag$/m);
    expect(result.stdout).to.match(/^world\s+flag$/m);
    /* A target in a sub-namespace carries its namespace path. */
    expect(result.stdout).to.match(/^tools\/inner\s+flag$/m);
    /* Nothing was built. */
    expect(result.stderr).not.to.match(/Building/);
  });

  it("excludes repository instances (not buildable targets)", () => {
    /* Declaring the js plugin brings in its `npm_repository @npm` — a repository
     * instance, which shares the target-decl shape but is not a build target, so
     * it must not appear in the target listing. */
    const withPlugin = {
      "PROJECT.fabr": "plugin @fabr-build/js;\nflag only { provides = x; }\n",
    };
    const result = runFabr(withPlugin, ["list-targets"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.match(/^only\s+flag$/m);
    expect(result.stdout).not.to.match(/@npm/);
  });

  it("adds source locations under -l and filters by name", () => {
    const result = runFabr(project, ["list-targets", "-l", "tools/inner"]);
    expect(result.status).to.equal(0);
    /* The filter narrows to the one named target, with its file:line:column
     * (the name `tools/inner` begins at column 6, after `flag `). */
    expect(result.stdout).to.match(/^tools\/inner\s+flag\s+PROJECT\.fabr:3:6$/m);
    expect(result.stdout).not.to.match(/^hello/m);
  });

  it("--json emits structured data (name, type, location)", () => {
    const result = runFabr(project, ["list-targets", "--json"]);
    expect(result.status).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    const names = parsed.targets.map((t: { name: string }) => t.name);
    expect(names).to.include.members(["hello", "world", "tools/inner"]);
    const hello = parsed.targets.find((t: { name: string }) => t.name === "hello");
    expect(hello.type).to.equal("flag");
    expect(hello.location).to.match(/PROJECT\.fabr:\d+:\d+/);
  });

  it("errors on an unknown target name rather than exiting empty", () => {
    const result = runFabr(project, ["list-targets", "nonesuch"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/No such target: nonesuch/);
  });
});
