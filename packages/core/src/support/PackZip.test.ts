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
 */

import * as zlib from "zlib";
import { expect } from "chai";
import { packToZip } from "./PackZip";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { SymlinkFile } from "../core/SymlinkFile";

function fileSetOf(entries: Record<string, string>): FileSet {
  const map = new Map<string, IFile>();
  for (const [name, content] of Object.entries(entries)) {
    map.set(name, MemoryFile.from(content));
  }
  return new FileSet(map);
}

/** Read a zip's entries back through its central directory: name, mode and
 *  content (undefined for a directory), in archive order. */
function readZip(zip: Buffer): Array<{ name: string; mode: number; content?: string }> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).to.equal(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: Array<{ name: string; mode: number; content?: string }> = [];
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(at)).to.equal(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    expect(zip.readUInt32LE(local)).to.equal(0x04034b50);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + compressed);
    const content = method === 8 ? zlib.inflateRawSync(data) : data;
    expect(zlib.crc32(content)).to.equal(crc);
    entries.push(name.endsWith("/") ? { name, mode } : { name, mode, content: content.toString("utf8") });
    at += 46 + nameLength;
  }
  return entries;
}

describe("packToZip", () => {
  it("writes every file and the directories above it, leading entries first", async () => {
    const zip = await packToZip(
      fileSetOf({ "com/x/A.class": "a".repeat(200), "app.properties": "k=v", "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\n" }),
      { first: ["META-INF/MANIFEST.MF"] }
    );
    const entries = readZip(zip);
    expect(entries.map(entry => entry.name)).to.deep.equal([
      "META-INF/",
      "META-INF/MANIFEST.MF",
      "app.properties",
      "com/",
      "com/x/",
      "com/x/A.class",
    ]);
    expect(entries[5].content).to.equal("a".repeat(200));
    expect(entries[2].content).to.equal("k=v");
    expect(entries[0].mode).to.equal(0o40755);
  });

  it("is a function of its contents", async () => {
    const files = fileSetOf({ "b.txt": "two", "a.txt": "one" });
    const reordered = fileSetOf({ "a.txt": "one", "b.txt": "two" });
    expect((await packToZip(files)).equals(await packToZip(reordered))).to.equal(true);
  });

  it("stamps every entry with the DOS epoch and no other timestamp", async () => {
    const zip = await packToZip(fileSetOf({ "a/b.txt": "one", "c.txt": "two" }));
    let at = zip.readUInt32LE(zip.length - 22 + 16);
    const stamps: Array<[number, number, number]> = [];
    while (zip.readUInt32LE(at) === 0x02014b50) {
      stamps.push([zip.readUInt16LE(at + 12), zip.readUInt16LE(at + 14), zip.readUInt16LE(at + 30)]);
      at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    }
    /* 1980-01-01 00:00 is DOS time 0, date (0 << 9) | (1 << 5) | 1; no extra field, so no extended timestamp. */
    expect(stamps).to.deep.equal(Array.from({ length: 3 }, () => [0, 0x21, 0]));
  });

  it("refuses a symlink", async () => {
    const files = new FileSet(new Map<string, IFile>([["link", new SymlinkFile("target")]]));
    const refused = await packToZip(files).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(refused).to.match(/symlink/);
  });
});

