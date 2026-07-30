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

/* Naming a target with no command: the operation comes from what its type's
 * rules support, which is only knowable once the model is loaded — so this is
 * the whole path (deferred parse -> model -> dispatch) through the real CLI. */
describe("e2e: the command inferred from what a target supports", () => {
  const SCRIPT_PROJECT = {
    "PROJECT.fabr": "plugin @fabr-build/js;\n\njs_script prog { entry = src:hello.js; }\n",
    "src/hello.js": 'console.log("hello " + process.argv.slice(2).join(" "));\n',
  };

  it("runs a target whose type only runs", () => {
    const result = runFabr(SCRIPT_PROJECT, ["prog"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello \n");
  });

  it("hands a run-only target the rest of the command line, fabr options included", () => {
    /* `--json` means something to fabr and nothing here: past the target, the
     * line belongs to the program. */
    const result = runFabr(SCRIPT_PROJECT, ["prog", "--json", "Ada"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello --json Ada\n");
  });

  it("still takes fabr's own options before the target", () => {
    const result = runFabr(SCRIPT_PROJECT, ["-q", "prog", "Ada"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello Ada\n");
  });

  it("suggests the command that would work when one is written explicitly", () => {
    const result = runFabr(SCRIPT_PROJECT, ["build", "prog"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/no rule matches target type 'js_script'/);
    expect(result.stderr).to.match(/'js_script' targets support 'run' — try 'fabr run prog'/);
  });
});
