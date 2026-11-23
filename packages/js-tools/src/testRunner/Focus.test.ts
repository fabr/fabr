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
import { handleFocus } from "./Focus";

/** Make stand-ins for jest's globals, each focused form telling itself apart. */
function jestGlobals(): Record<string, unknown> {
  const it = Object.assign(() => "it", { only: () => "it.only" });
  const describe = Object.assign(() => "describe", { only: () => "describe.only" });
  return { it, test: it, describe, fit: it.only, fdescribe: describe.only };
}

describe("handleFocus", () => {
  it("leaves focused forms as they are under allow", () => {
    const globals = jestGlobals();
    handleFocus(globals, "allow", "a.test.ts");
    expect((globals.fit as () => string)()).to.equal("it.only");
  });

  it("makes each focused form the plain function under ignore", () => {
    const globals = jestGlobals();
    handleFocus(globals, "ignore", "a.test.ts");
    const it = globals.it as { only: unknown };
    expect([it.only, globals.fit, globals.fdescribe]).to.deep.equal([globals.it, globals.it, globals.describe]);
  });

  it("makes each focused form, and its .each, fail the file under forbid", () => {
    const globals = jestGlobals();
    handleFocus(globals, "forbid", "src/a.test.ts");
    const only = (globals.describe as { only: (() => void) & { each: () => void } }).only;
    expect(only).to.throw("src/a.test.ts focuses tests with .only, which TEST_ONLY_HANDLING=forbid refuses");
    expect(only.each).to.throw("TEST_ONLY_HANDLING=forbid");
    expect(globals.fit as () => void).to.throw("TEST_ONLY_HANDLING=forbid");
  });
});
