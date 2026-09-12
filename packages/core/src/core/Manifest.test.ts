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

import { ISourceIndexRow, parseSourceIndex, serializeSourceIndex } from "./Manifest";
import { expect } from "chai";

const META = { root: "/home/dev/proj", algorithm: "sha256", writtenAt: 1726000000000 };

function rows(...entries: ISourceIndexRow[]): Map<string, ISourceIndexRow> {
  return new Map(entries.map(row => [row.name, row]));
}

describe("source index dialect", () => {
  it("round-trips rows, including names with spaces and fractional mtimes", () => {
    const written = rows(
      { name: "src/a.ts", hash: "aa11", size: 120, mtimeMs: 1712345678901.125, mime: "text/plain" },
      { name: "docs/read me.md", hash: "bb22", size: 0, mtimeMs: 1712345678000, mime: "text/markdown" }
    );
    const parsed = parseSourceIndex(serializeSourceIndex(META, written));
    expect(parsed).to.not.equal(undefined);
    expect(parsed!.meta).to.deep.equal(META);
    expect(parsed!.rows.size).to.equal(2);
    expect(parsed!.rows.get("src/a.ts")).to.deep.equal(written.get("src/a.ts"));
    expect(parsed!.rows.get("docs/read me.md")).to.deep.equal(written.get("docs/read me.md"));
  });

  it("rejects a document without the magic", () => {
    expect(parseSourceIndex('{"root":"/x","algorithm":"sha256","writtenAt":1,"rows":0}\n')).to.equal(undefined);
  });

  it("rejects a truncated document via the header count", () => {
    const text = serializeSourceIndex(META, rows({ name: "a", hash: "aa", size: 1, mtimeMs: 2, mime: "text/plain" }));
    const torn = text.substring(0, text.lastIndexOf("\n", text.length - 2) + 1);
    expect(parseSourceIndex(torn)).to.equal(undefined);
  });

  it("rejects a malformed row", () => {
    const text = serializeSourceIndex(META, rows({ name: "a", hash: "aa", size: 1, mtimeMs: 2, mime: "text/plain" }));
    expect(parseSourceIndex(text.replace("aa 1 2", "aa one 2"))).to.equal(undefined);
  });

  it("rejects a row with an empty field (Number('') would read as 0)", () => {
    const text = serializeSourceIndex(META, rows({ name: "a", hash: "aa", size: 1, mtimeMs: 2, mime: "text/plain" }));
    expect(parseSourceIndex(text.replace("aa 1 2", "aa  2"))).to.equal(undefined);
    expect(parseSourceIndex(text.replace(" text/plain", " "))).to.equal(undefined);
  });
});
