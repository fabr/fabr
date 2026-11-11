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
 *
 * TarHeader.ts, TarExtract.ts and TarPack.ts are derived from tar-stream 3.1.7
 * (https://github.com/mafintosh/tar-stream), distributed under the MIT license:
 *
 *   The MIT License (MIT)
 *
 *   Copyright (c) 2014 Mathias Buus
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *   THE SOFTWARE.
 */

/** The size of a tar block: every header, and the unit a body is padded to. */
export const TAR_BLOCK_SIZE = 512;

/** The kinds of entry a tar header describes. */
export type TarEntryType =
  "file" | "link" | "symlink" | "character-device" | "block-device" | "directory" | "fifo" | "contiguous-file";

/**
 * One entry's header, as read from an archive (see {@link TarExtract}), with
 * any pax records and GNU long names already applied to its fields.
 */
export interface TarHeader {
  /** The entry's path, as the archive spells it. */
  name: string;
  /** The kind of entry, or null for a typeflag none of {@link TarEntryType}
   *  names (packed back as a regular file). */
  type: TarEntryType | null;
  /** The permission bits (0o7777), plus any file-type bits the archive set. */
  mode: number;
  uid: number;
  gid: number;
  /** The length of the entry's content; 0 for an entry that has none. */
  size: number;
  mtime: Date;
  /** A link's target: the path a symlink names, or the entry a hardlink shares
   *  content with. Empty for any other entry. */
  linkname: string;
  uname: string;
  gname: string;
  devmajor: number;
  devminor: number;
  /** The entry's pax records other than those carried by another field (`path`,
   *  `linkpath`, `size`, `mtime`, `uid`, `gid`, `uname`, `gname`, and the
   *  `SCHILY.xattr.*` records in {@link xattrs}), their values read as UTF-8. */
  pax: ReadonlyMap<string, string>;
  /** The entry's extended attributes (pax `SCHILY.xattr.<name>` records), by
   *  name, each value its bytes exactly as archived. */
  xattrs: ReadonlyMap<string, Buffer>;
}

/** A header to pack (see {@link TarPack.entry}): a name, and whichever other
 *  fields differ from their defaults. */
export type TarEntryHeader = Pick<TarHeader, "name"> & Partial<Omit<TarHeader, "name">>;

/** The prefix of a pax record carrying an extended attribute. */
const XATTR_PREFIX = "SCHILY.xattr.";

/** The pax keys {@link TarHeader}'s own fields carry. */
const FIELD_KEYS = new Set(["path", "linkpath", "size", "mtime", "uid", "gid", "uname", "gname"]);

/** The typeflags of the headers that describe the entry after them. */
export const PAX_HEADER = 72; // 'x'
export const PAX_GLOBAL_HEADER = 55; // 'g'
export const GNU_LONG_LINK_PATH = 27; // 'K'
export const GNU_LONG_PATH = 28; // 'L'
const GNU_OLD_LONG_PATH = 30; // 'N'

const TYPEFLAGS: ReadonlyArray<[number, TarEntryType]> = [
  [0, "file"],
  [1, "link"],
  [2, "symlink"],
  [3, "character-device"],
  [4, "block-device"],
  [5, "directory"],
  [6, "fifo"],
  [7, "contiguous-file"],
];
const TYPE_OF_FLAG = new Map<number, TarEntryType>(TYPEFLAGS);
const FLAG_OF_TYPE = new Map<TarEntryType, number>(TYPEFLAGS.map(([flag, type]) => [type, flag]));

const ZEROS = "0000000000000000000";
const SEVENS = "7777777777777777777";
const ZERO_OFFSET = "0".charCodeAt(0);
const USTAR_MAGIC = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]); // ustar\0
const USTAR_VER = Buffer.from([ZERO_OFFSET, ZERO_OFFSET]);
const GNU_MAGIC = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x20]); // ustar\x20
const GNU_VER = Buffer.from([0x20, 0x00]);
const MASK = 0o7777;
const MAGIC_OFFSET = 257;
const VERSION_OFFSET = 263;
/** The largest value of a 7-digit octal field (uid, gid). */
const MAX_ID = 0o7777777;
/** The largest number of seconds an 11-digit octal mtime field holds. */
const MAX_MTIME_SECONDS = 0o77777777777;

/**
 * One header block, decoded: an entry's own header, or one of the headers
 * (pax, GNU long name) describing the entry after it.
 */
export interface ITarBlock {
  /** The typeflag, its ASCII digit's value (`'0'` → 0, `'x'` → 72). */
  typeflag: number;
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: Date;
  linkname: string;
  uname: string;
  gname: string;
  devmajor: number;
  devminor: number;
}

/**
 * Decode one 512-byte header block.
 * @return the block, or null for an all-zero block (the end-of-archive marker).
 * @throws where the checksum is wrong or the format is neither ustar nor GNU.
 */
export function decodeBlock(block: Buffer): ITarBlock | null {
  const typeflag = block[156] === 0 ? 0 : block[156] - ZERO_OFFSET;
  let name = decodeText(block, 0, 100);
  const sum = checksum(block);
  /* The checksum of an all-zero block is that of its spaces alone. */
  if (sum === 8 * 32) {
    return null;
  }
  if (sum !== decodeOct(block, 148, 8)) {
    throw new Error("Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?");
  }
  if (isUstar(block)) {
    if (block[345]) {
      name = decodeText(block, 345, 155) + "/" + name;
    }
  } else if (!isGnu(block)) {
    throw new Error("Invalid tar header: unknown format.");
  }
  return {
    typeflag,
    name,
    mode: decodeOct(block, 100, 8),
    uid: decodeOct(block, 108, 8),
    gid: decodeOct(block, 116, 8),
    size: decodeOct(block, 124, 12),
    mtime: new Date(1000 * decodeOct(block, 136, 12)),
    linkname: block[157] === 0 ? "" : decodeText(block, 157, 100),
    uname: decodeText(block, 265, 32),
    gname: decodeText(block, 297, 32),
    devmajor: decodeOct(block, 329, 8),
    devminor: decodeOct(block, 337, 8),
  };
}

/** @return the path a GNU long name or long link block's content carries: its bytes up to the first NUL, as UTF-8. */
export function decodeLongPath(content: Buffer): string {
  return decodeText(content, 0, content.length);
}

/**
 * Decode the records of a pax header's content (`<length> <key>=<value>\n`
 * each, the length counting the record's bytes, its own digits included).
 * @return each key's value, as bytes; a later record of a key replaces an earlier.
 */
export function decodePaxRecords(content: Buffer): Map<string, Buffer> {
  const records = new Map<string, Buffer>();
  let rest = content;
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    const length = space === -1 ? NaN : parseInt(rest.toString("latin1", 0, space), 10);
    if (!(length > space + 1) || length > rest.length) {
      break;
    }
    /* The record without its length and trailing newline. */
    const record = rest.subarray(space + 1, length - 1);
    const equals = record.indexOf(0x3d);
    if (equals === -1) {
      break;
    }
    records.set(record.toString("utf8", 0, equals), Buffer.from(record.subarray(equals + 1)));
    rest = rest.subarray(length);
  }
  return records;
}

/** Encode pax records as a pax header's content, each value written as its bytes. */
export function encodePaxRecords(records: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  return Buffer.concat(
    records.map(([key, value]) => {
      const body = Buffer.concat([Buffer.from(` ${key}=`, "utf8"), value, Buffer.from("\n")]);
      /* The length counts its own digits: add them, and one more where adding them carried. */
      let length = body.length + String(body.length).length;
      if (String(length).length + body.length !== length) {
        length = body.length + String(length).length;
      }
      return Buffer.concat([Buffer.from(String(length), "latin1"), body]);
    })
  );
}

/**
 * Make an entry's header from its own block and the records describing it:
 * the pax records (global ones first, the entry's own over them) and any GNU
 * long name and link. A pax record overrides a GNU long name, which overrides
 * the block's own field.
 */
export function headerOf(
  block: ITarBlock,
  records: ReadonlyMap<string, Buffer>,
  longPath: string | undefined,
  longLinkPath: string | undefined
): TarHeader {
  const text = (key: string): string | undefined => records.get(key)?.toString("utf8");
  const integer = (key: string, fallback: number): number => {
    const value = parseInt(text(key) ?? "", 10);
    return Number.isNaN(value) ? fallback : value;
  };
  const pax = new Map<string, string>();
  const xattrs = new Map<string, Buffer>();
  for (const [key, value] of records) {
    if (key.startsWith(XATTR_PREFIX)) {
      xattrs.set(key.slice(XATTR_PREFIX.length), value);
    } else if (!FIELD_KEYS.has(key)) {
      pax.set(key, value.toString("utf8"));
    }
  }
  const mtime = parseFloat(text("mtime") ?? "");
  const name = text("path") ?? longPath ?? block.name;
  return {
    name,
    /* An old tar marks a directory by its trailing `/` alone: judged on the
     * whole name, since a long name's truncated copy in the block can end in one. */
    type: block.typeflag === 0 && name.endsWith("/") ? "directory" : (TYPE_OF_FLAG.get(block.typeflag) ?? null),
    mode: block.mode,
    uid: integer("uid", block.uid),
    gid: integer("gid", block.gid),
    size: integer("size", block.size),
    mtime: Number.isNaN(mtime) ? block.mtime : new Date(Math.round(mtime * 1000)),
    linkname: text("linkpath") ?? longLinkPath ?? block.linkname,
    uname: text("uname") ?? block.uname,
    gname: text("gname") ?? block.gname,
    devmajor: block.devmajor,
    devminor: block.devminor,
    pax,
    xattrs,
  };
}

/**
 * Encode an entry's header: one ustar block where every field fits one, else a
 * pax header carrying what does not (and every record of `pax` and `xattrs`,
 * sorted by key), its content padded to a block, then the ustar block.
 */
export function encodeEntryHeader(header: TarHeader): Buffer {
  const typeflag = header.type === null ? 0 : FLAG_OF_TYPE.get(header.type)!;
  const name = typeflag === 5 && !header.name.endsWith("/") ? header.name + "/" : header.name;
  const path = ustarPath(name);
  const records: Array<[string, Buffer]> = [];
  const text = (key: string, value: string): void => {
    records.push([key, Buffer.from(value, "utf8")]);
  };
  if (path === undefined) {
    text("path", name);
  }
  if (!fitsField(header.linkname, 100)) {
    text("linkpath", header.linkname);
  }
  const mtime = header.mtime.getTime();
  if (mtime % 1000 !== 0 || mtime < 0 || mtime / 1000 > MAX_MTIME_SECONDS) {
    text("mtime", paxTime(mtime));
  }
  if (header.uid > MAX_ID) {
    text("uid", String(header.uid));
  }
  if (header.gid > MAX_ID) {
    text("gid", String(header.gid));
  }
  if (!fitsField(header.uname, 32)) {
    text("uname", header.uname);
  }
  if (!fitsField(header.gname, 32)) {
    text("gname", header.gname);
  }
  for (const key of [...header.pax.keys()].sort()) {
    if (!FIELD_KEYS.has(key) && !key.startsWith(XATTR_PREFIX)) {
      text(key, header.pax.get(key)!);
    }
  }
  for (const key of [...header.xattrs.keys()].sort()) {
    records.push([XATTR_PREFIX + key, header.xattrs.get(key)!]);
  }
  const fields: ITarBlock = {
    typeflag,
    name: path?.name ?? name,
    mode: header.mode,
    uid: header.uid,
    gid: header.gid,
    size: header.size,
    mtime: header.mtime,
    linkname: header.linkname,
    uname: header.uname,
    gname: header.gname,
    devmajor: header.devmajor,
    devminor: header.devminor,
  };
  const block = encodeBlock(fields, path?.prefix ?? "");
  if (records.length === 0) {
    return block;
  }
  const content = encodePaxRecords(records);
  const paxBlock = encodeBlock({ ...fields, typeflag: PAX_HEADER, name: "PaxHeader", size: content.length, linkname: "" }, "");
  return Buffer.concat([paxBlock, content, Buffer.alloc(paddingOf(content.length)), block]);
}

/** @return the number of zero bytes that pad content of `size` bytes to a whole block. */
export function paddingOf(size: number): number {
  const over = size % TAR_BLOCK_SIZE;
  return over === 0 ? 0 : TAR_BLOCK_SIZE - over;
}

/** @return `name` split into a ustar name (at most 100 bytes) and prefix (at most 155), or undefined where it is not ASCII or no split fits. */
function ustarPath(name: string): { name: string; prefix: string } | undefined {
  if (!isAscii(name)) {
    return undefined;
  }
  let rest = name;
  let prefix = "";
  while (rest.length > 100) {
    const slash = rest.indexOf("/");
    if (slash === -1) {
      return undefined;
    }
    prefix += prefix ? "/" + rest.slice(0, slash) : rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  return prefix.length > 155 ? undefined : { name: rest, prefix };
}

/** @return true if `text` is ASCII of at most `length` bytes, otherwise false. */
function fitsField(text: string, length: number): boolean {
  return text.length <= length && isAscii(text);
}

function isAscii(text: string): boolean {
  return Buffer.byteLength(text, "utf8") === text.length;
}

/** @return a time in milliseconds as pax spells one: decimal seconds, with a fraction where there is one. */
function paxTime(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const fraction = abs % 1000;
  return `${sign}${Math.floor(abs / 1000)}${fraction === 0 ? "" : "." + String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
}

/** Encode one ustar header block of `fields`, each text field written as far as it fits. */
function encodeBlock(fields: ITarBlock, prefix: string): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_SIZE);
  block.write(fields.name, 0, 100, "utf8");
  block.write(encodeOct(fields.mode & MASK, 6), 100, "latin1");
  block.write(encodeOct(fields.uid, 6), 108, "latin1");
  block.write(encodeOct(fields.gid, 6), 116, "latin1");
  encodeSize(fields.size, block, 124);
  block.write(encodeOct(Math.max(0, Math.floor(fields.mtime.getTime() / 1000)), 11), 136, "latin1");
  block[156] = ZERO_OFFSET + fields.typeflag;
  if (fields.linkname) {
    block.write(fields.linkname, 157, 100, "utf8");
  }
  USTAR_MAGIC.copy(block, MAGIC_OFFSET);
  USTAR_VER.copy(block, VERSION_OFFSET);
  if (fields.uname) {
    block.write(fields.uname, 265, 32, "utf8");
  }
  if (fields.gname) {
    block.write(fields.gname, 297, 32, "utf8");
  }
  block.write(encodeOct(fields.devmajor, 6), 329, "latin1");
  block.write(encodeOct(fields.devminor, 6), 337, "latin1");
  if (prefix) {
    block.write(prefix, 345, 155, "utf8");
  }
  block.write(encodeOct(checksum(block), 6), 148, "latin1");
  return block;
}

function isUstar(block: Buffer): boolean {
  return USTAR_MAGIC.equals(block.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 6));
}

function isGnu(block: Buffer): boolean {
  return (
    GNU_MAGIC.equals(block.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 6)) &&
    GNU_VER.equals(block.subarray(VERSION_OFFSET, VERSION_OFFSET + 2))
  );
}

/** @return true if `typeflag` is a header describing the entry after it (pax or GNU long name), otherwise false. */
export function isDescribingBlock(typeflag: number): boolean {
  return (
    typeflag === PAX_HEADER ||
    typeflag === PAX_GLOBAL_HEADER ||
    typeflag === GNU_LONG_LINK_PATH ||
    typeflag === GNU_LONG_PATH ||
    typeflag === GNU_OLD_LONG_PATH
  );
}

/** @return true if `typeflag` is a GNU long name block (either spelling), otherwise false. */
export function isLongPathBlock(typeflag: number): boolean {
  return typeflag === GNU_LONG_PATH || typeflag === GNU_OLD_LONG_PATH;
}

/** @return the header checksum of `block`: the sum of its bytes, the checksum field counted as spaces. */
function checksum(block: Buffer): number {
  let sum = 8 * 32;
  for (let i = 0; i < 148; i++) {
    sum += block[i];
  }
  for (let i = 156; i < TAR_BLOCK_SIZE; i++) {
    sum += block[i];
  }
  return sum;
}

function encodeOct(value: number, digits: number): string {
  const text = value.toString(8);
  if (text.length > digits) {
    return SEVENS.slice(0, digits) + " ";
  }
  return ZEROS.slice(0, digits - text.length) + text + " ";
}

/** Write a size field: 11 octal digits where it fits, else GNU's base-256 form. */
function encodeSize(size: number, block: Buffer, offset: number): void {
  if (size.toString(8).length > 11) {
    block[offset] = 0x80;
    let rest = size;
    for (let i = 11; i > 0; i--) {
      block[offset + i] = rest & 0xff;
      rest = Math.floor(rest / 0x100);
    }
  } else {
    block.write(encodeOct(size, 11), offset, "latin1");
  }
}

/** @return a base-256 numeric field's value (GNU's form for a number no octal field holds), or 0 where it is malformed. */
function parse256(field: Buffer): number {
  /* The first byte is 0x80 for a positive number, 0xff for a two's-complement negative one. */
  const positive = field[0] === 0x80;
  if (!positive && field[0] !== 0xff) {
    return 0;
  }
  let sum = 0;
  for (let i = 1; i < field.length; i++) {
    sum = sum * 256 + (positive ? field[i] : 0xff - field[i]);
  }
  return positive ? sum : -sum;
}

/** @return the number in an octal (or base-256) numeric field. */
function decodeOct(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if (field[0] & 0x80) {
    return parse256(field);
  }
  /* An old tar may pad the digits with leading spaces. */
  let start = 0;
  while (start < field.length && field[start] === 0x20) {
    start++;
  }
  let end = field.indexOf(0x20, start);
  if (end === -1) {
    end = field.length;
  }
  while (start < end && field[start] === 0) {
    start++;
  }
  if (start === end) {
    return 0;
  }
  return parseInt(field.toString("latin1", start, end), 8);
}

/** @return a text field's bytes up to its first NUL, as UTF-8. */
function decodeText(block: Buffer, offset: number, length: number): string {
  let end = block.indexOf(0, offset);
  if (end === -1 || end > offset + length) {
    end = offset + length;
  }
  return block.toString("utf8", offset, end);
}
