/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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
import { FileConflictError } from "./Errors";
import { FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";

describe("MemoryFile", () => {
  it("getDisplayName returns a generic label rather than throwing", () => {
    expect(MemoryFile.from("x").getDisplayName()).to.equal("<generated file>");
  });

  it("a conflict between generated files reports rather than crashing", () => {
    /* Two different generated package.json at one path, with no provenance:
     * the FileConflictError message falls back to getDisplayName, which used to
     * throw "Method not implemented" and mask the real conflict diagnostic. */
    const a = new FileSet(new Map([["pkg/package.json", MemoryFile.from('{"a":1}')]]));
    const b = new FileSet(new Map([["pkg/package.json", MemoryFile.from('{"b":2}')]]));
    let err: unknown;
    try {
      FileSet.unionAll(a, b);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(FileConflictError);
    expect((err as Error).message).to.include("Conflicting files for pkg/package.json");
    expect((err as Error).message).to.include("<generated file>");
  });
});
