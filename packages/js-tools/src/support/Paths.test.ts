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
import * as path from "node:path";
import { posixRelative, toPosix } from "./Paths";

describe("Paths", () => {
  it("spells a Windows path with `/`", () => {
    expect(toPosix("C:\\w\\.fabr-tree\\x", path.win32)).to.equal("C:/w/.fabr-tree/x");
    expect(toPosix("..\\.fabr-tree\\x", path.win32)).to.equal("../.fabr-tree/x");
    expect(toPosix("/w/x", path.posix)).to.equal("/w/x");
  });

  it("makes a relative path /-separated", () => {
    expect(posixRelative("/w", "/w/build/a.js")).to.equal("build/a.js");
    expect(posixRelative("/w", "/w")).to.equal("");
  });
});
