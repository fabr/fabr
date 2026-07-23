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

/* A constrained reference (`target<KEY=VALUE>`) applies a build-config delta to
 * just that reference's build. It works in a build script and, per these tests,
 * on the command line for the target-taking verbs (build/shell/…) exactly as it
 * does for ls/cat — the reference is parsed identically everywhere. `${MSG}` in
 * the run command makes the applied constraint observable in the output. */
const project = {
  "PROJECT.fabr":
    "default MSG = hello;\n" +
    "script greet { entry = ./greet.sh; }\n" +
    "generate out {\n  run = greet ${MSG} > result.txt;\n}\n",
  "greet.sh": "echo \"got:$1\"\n",
};

describe("e2e: constrained references on the command line", () => {
  it("applies the constraint delta when building via a constrained reference", () => {
    const result = runFabr(project, ["cat", "out<MSG=world>:result.txt"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("got:world\n");
  });

  it("leaves the ambient config in place for a plain reference", () => {
    const result = runFabr(project, ["cat", "out:result.txt"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("got:hello\n");
  });

  it("accepts a constrained reference on the bare `build` verb", () => {
    const result = runFabr(project, ["build", "out<MSG=world>"]);
    expect(result.status).to.equal(0);
  });
});
