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

/* A js_package's own .js/.jsx sources are routed through the compile (tsc
 * allowJs), so they land in the built package (previously they were silently
 * dropped) and a .ts may import a local .js. The stub tsc mirrors allowJs by
 * copying .js verbatim; the real downlevel-to-JS_TARGET is tsc's own job,
 * covered by the tsconfig unit test (allowJs + target). */
describe("e2e: js_package with plain JS sources", () => {
  const project = {
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr/js;\n\n" + STUB_TSC_CONFIG + "\njs_package thing { srcs = src:**/*; }\n",
    "src/helper.js": "module.exports.answer = 42;\n",
    "src/index.ts": 'export const x = 1;\n',
  };

  it("emits a plain .js source into the built package (no longer dropped)", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:helper.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain("answer = 42");
  });

  it("still emits the .ts alongside it", () => {
    const result = runFabr(project, ["-DJS_TARGET=es2020", "cat", "thing:index.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain("export const x = 1");
  });
});
