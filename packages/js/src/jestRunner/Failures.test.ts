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
import { presentable } from "./Failures";

/** A failure as jest-message-util renders one: the bulleted title, a blank
 * line, then the body indented four spaces with the stack indented six. */
const JEST_OUTPUT =
  "  ● Camera › initStyle › reads the canvas\n" +
  "\n" +
  "    expect(received).toEqual(expected)\n" +
  "\n" +
  "    - Expected  - 1\n" +
  "    + Received  + 1\n" +
  "\n" +
  "      at Object.<anonymous> (src/Camera.test.ts:12:5)\n";

describe("presentable", () => {
  it("drops the title the report already prints", () => {
    expect(presentable(JEST_OUTPUT)).to.not.contain("●");
    expect(presentable(JEST_OUTPUT).split("\n")[0]).to.equal("expect(received).toEqual(expected)");
  });

  it("removes jest's own indent but keeps the relative structure", () => {
    const lines = presentable(JEST_OUTPUT).split("\n");
    /* The diff sits at the body's own level; the stack frame stays deeper. */
    expect(lines).to.contain("- Expected  - 1");
    expect(lines).to.contain("  at Object.<anonymous> (src/Camera.test.ts:12:5)");
  });

  it("keeps the blank lines that separate the matcher's sections", () => {
    expect(presentable(JEST_OUTPUT)).to.contain("\n\n- Expected");
  });

  it("leaves a message with no title alone", () => {
    /* Not a shape jest produces, but the split must not eat the whole thing. */
    expect(presentable("just a message")).to.equal("just a message");
  });
});
