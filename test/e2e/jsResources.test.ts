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

/* `resources` ships files as package content without building them: prebuilt
 * JavaScript and its hand-written declarations (generated code, a vendored
 * library, a tool's output). The distinguishing case is `.js`/`.d.ts`, which
 * `srcs` would route into the compile — the reason that is wrong being visible
 * in the second test here. */
describe("e2e: js_package resources", () => {
  const project = {
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\njs_package thing {\n  srcs = src:**/*.ts;\n  resources = prebuilt:**;\n}\n",
    "src/index.ts": "export const x = 1;\n",
    /* Deliberately paired: a prebuilt module and the declarations written for
     * it, the shape generated toolchains emit. */
    "prebuilt/vendor.js": "exports.answer = 42;\n",
    "prebuilt/vendor.d.ts": "export declare const answer: 42;\n",
  };

  it("ships a resource verbatim into the built package", () => {
    const result = runFabr(project, ["cat", "thing:vendor.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain("exports.answer = 42");
  });

  it("ships the hand-written declaration beside it", () => {
    const result = runFabr(project, ["cat", "thing:vendor.d.ts"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain("export declare const answer: 42");
  });

  it("does not route a resource through the compile", () => {
    /* Were the .js compiled, tsc (declaration + allowJs) would synthesise a
     * second vendor.d.ts, which would collide with the shipped one — the
     * failure this property exists to avoid. Building at all proves it did
     * not, and the target's own sources still compile alongside. */
    const result = runFabr(project, ["cat", "thing:index.js"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain("export const x = 1");
  });
});
