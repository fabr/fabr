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
import { isArchiveMime, MIME_GZIP, MIME_TAR, MIME_UNKNOWN, MIME_ZIP, SNIFF_LENGTH, sniffMime } from "./Mime";

describe("sniffMime", () => {
  it("classifies the archive magics", () => {
    expect(sniffMime(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).to.equal(MIME_GZIP);
    expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).to.equal(MIME_ZIP);
    const tarHead = Buffer.alloc(SNIFF_LENGTH);
    tarHead.write("ustar", 257, "ascii");
    expect(sniffMime(tarHead)).to.equal(MIME_TAR);
  });

  it("classifies everything else — including short and empty heads — as unknown", () => {
    expect(sniffMime(Buffer.from("plain text, nothing magic"))).to.equal(MIME_UNKNOWN);
    expect(sniffMime(Buffer.from([0x1f]))).to.equal(MIME_UNKNOWN);
    expect(sniffMime(Buffer.alloc(0))).to.equal(MIME_UNKNOWN);
  });

  it("isArchiveMime admits exactly the expandable types", () => {
    expect(isArchiveMime(MIME_GZIP)).to.equal(true);
    expect(isArchiveMime(MIME_TAR)).to.equal(true);
    expect(isArchiveMime(MIME_ZIP)).to.equal(true);
    expect(isArchiveMime(MIME_UNKNOWN)).to.equal(false);
    expect(isArchiveMime("inode/symlink")).to.equal(false);
  });
});
