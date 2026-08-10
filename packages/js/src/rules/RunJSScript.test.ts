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
import { compiledEntryName } from "./RunJSScript";

describe("compiledEntryName", () => {
  it("maps plain TypeScript spellings to .js", () => {
    expect(compiledEntryName("bin/tool.ts")).to.equal("bin/tool.js");
    expect(compiledEntryName("bin/app.tsx")).to.equal("bin/app.js");
  });

  it("keeps the module flavour tsc emits for .mts/.cts", () => {
    expect(compiledEntryName("bin/tool.mts")).to.equal("bin/tool.mjs");
    expect(compiledEntryName("bin/tool.cts")).to.equal("bin/tool.cjs");
  });

  it("leaves a non-TypeScript name alone", () => {
    expect(compiledEntryName("bin/tool.js")).to.equal("bin/tool.js");
    expect(compiledEntryName("bin/tool.mjs")).to.equal("bin/tool.mjs");
  });
});
