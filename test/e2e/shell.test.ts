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

/* `fabr shell <target>` stages a build step's sandbox and drops into a shell.
 * The harness spawns fabr with a closed stdin, so the inherited shell (/bin/sh —
 * no SHELL in the clean child env) reads EOF and exits 0 at once, letting us
 * assert on the intro without an interactive session. */
describe("e2e: fabr shell", () => {
  const project = {
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n" +
      "js_script gen { entry = src:gen.js; }\n" +
      "generate g {\n  srcs = src:data.txt;\n  run = gen > out.txt;\n}\n" +
      "flag ff { }\n",
    "src/gen.js": "require('fs').writeFileSync('out.txt','generated\\n');\n",
    "src/data.txt": "a\nb\n",
  };

  it("stages the target's sandbox and prints the command the step would run", () => {
    const result = runFabr(project, ["shell", "g"]);
    expect(result.status).to.equal(0);
    /* The intro names the target, the staged dir, and the reproducible command. */
    expect(result.stderr).to.match(/Sandbox for 'g' staged at .*fabr-shell-/);
    expect(result.stderr).to.contain("node gen.js");
  });

  it("errors on a target that yields content, not a build command", () => {
    const result = runFabr(project, ["shell", "ff"]);
    expect(result.status).to.equal(1);
    expect(result.stderr).to.match(/no command sandbox to shell into/);
  });
});
