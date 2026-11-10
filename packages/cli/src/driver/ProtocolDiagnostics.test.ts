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
import { EMPTY_FILESET, StringReader } from "@fabr-build/core";
import { rangeOf } from "./ProtocolDiagnostics";

describe("rangeOf", () => {
  it("counts a range's characters in UTF-16 code units, as a client counts them", () => {
    const text = "X = \u{1F600} b;\nnext";
    const reader = new StringReader(text);
    while (!reader.eof()) {
      reader.next();
    }
    const offset = text.indexOf("b");
    expect(rangeOf({ fs: EMPTY_FILESET, file: "BUILD.fabr", reader, offset, endOffset: offset + 1 })).to.deep.equal({
      start: { line: 0, character: 7 },
      end: { line: 0, character: 8 },
    });
  });
});
