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

import { createHash, Hash } from "crypto";
import { PassThrough, Writable } from "stream";
import { Computable, FabrError, HASH_ALGORITHM, IOutputHandle, normalizeEntryName, sniffMime, SNIFF_LENGTH } from "@fabr-build/core";

/** What an entry of a layer is. Device nodes, fifos and sockets are `other`: recorded, never presented. */
export type LayerEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

/**
 * One entry of a layer's tar, as its filesystem manifest records it: its path
 * (relative to the image's root, `.` and `..` collapsed), what it is, and its
 * stored metadata; a regular file also where its bytes are in the uncompressed
 * tar, their hash (as the blob pool names content) and their mime.
 */
export interface ILayerEntry {
  readonly path: string;
  readonly type: LayerEntryType;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  /** A symlink's target, or the path a hardlink shares its content with. */
  readonly linkname?: string;
  readonly offset?: number;
  readonly size?: number;
  readonly hash?: string;
  readonly mime?: string;
}

/** What indexing a layer finds: its entries, in order, and the digest of the whole uncompressed tar (its `diff_id`). */
export interface ILayerIndex {
  readonly entries: readonly ILayerEntry[];
  readonly diffId: string;
}

const BLOCK = 512;

/** The fields a pax or GNU long-name header sets on the entry that follows it. */
interface IPending {
  path?: string;
  linkname?: string;
  size?: number;
  uid?: number;
  gid?: number;
}

/** A header whose body is still being read: an entry's content, or a pax/GNU record for the next. */
interface IBody {
  readonly remaining: number;
  readonly entry?: { header: IHeader; offset: number; hash: Hash; head: Buffer[]; headLength: number };
  readonly record?: { kind: "pax" | "longname" | "longlink"; chunks: Buffer[] };
}

interface IHeader {
  readonly path: string;
  readonly type: LayerEntryType;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly linkname: string;
}

/**
 * Index a layer's uncompressed tar as it streams through: write the tar into
 * the returned sink, and read the index from `result` once it has finished.
 * Reads ustar, pax (`path`, `linkpath`, `size`, `uid`, `gid`) and GNU long
 * names; a name leaving the tree is refused, as an unpacked archive's is.
 */
export function indexLayer(): { sink: Writable; result: () => ILayerIndex } {
  const entries: ILayerEntry[] = [];
  const whole = createHash(HASH_ALGORITHM);
  let position = 0;
  let header: Buffer[] = [];
  let headerLength = 0;
  let body: IBody | undefined;
  let padding = 0;
  let pending: IPending = {};
  let ended = false;

  const finishBody = (finished: IBody): void => {
    if (finished.entry !== undefined) {
      const { header: h, offset, hash, head } = finished.entry;
      entries.push({ ...entryOf(h), offset, size: h.size, hash: hash.digest("hex"), mime: sniffMime(Buffer.concat(head)) });
    } else if (finished.record !== undefined) {
      const data = Buffer.concat(finished.record.chunks);
      if (finished.record.kind === "pax") {
        pending = { ...pending, ...paxFields(data) };
      } else {
        const text = data.toString("utf8").replace(/\0.*$/s, "");
        pending = finished.record.kind === "longname" ? { ...pending, path: text } : { ...pending, linkname: text };
      }
    }
  };

  const startEntry = (block: Buffer): void => {
    if (block.every(byte => byte === 0)) {
      ended = true;
      return;
    }
    const raw = parseHeader(block);
    const size = pending.size ?? raw.size;
    const typeflag = String.fromCharCode(block[156]);
    padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      const kind = typeflag === "L" ? "longname" : typeflag === "K" ? "longlink" : "pax";
      /* A global pax header applies to every entry after it; fabr reads none of its fields, so it is skipped. */
      body = { remaining: size, ...(typeflag === "g" ? {} : { record: { kind, chunks: [] } }) };
    } else {
      const h: IHeader = {
        ...raw,
        size,
        path: checkedPath(pending.path ?? raw.path),
        linkname: pending.linkname ?? raw.linkname,
        uid: pending.uid ?? raw.uid,
        gid: pending.gid ?? raw.gid,
      };
      pending = {};
      if (h.type === "file") {
        body = { remaining: size, entry: { header: h, offset: position, hash: createHash(HASH_ALGORITHM), head: [], headLength: 0 } };
      } else {
        entries.push(entryOf(h));
        body = { remaining: size };
      }
    }
    if (body.remaining === 0) {
      finishBody(body);
      body = undefined;
    }
  };

  const consume = (chunk: Buffer): void => {
    let at = 0;
    while (at < chunk.length && !ended) {
      if (body !== undefined) {
        const take = Math.min(body.remaining, chunk.length - at);
        const piece = chunk.subarray(at, at + take);
        if (body.entry !== undefined) {
          body.entry.hash.update(piece);
          if (body.entry.headLength < SNIFF_LENGTH) {
            body.entry.head.push(piece.subarray(0, SNIFF_LENGTH - body.entry.headLength));
            body.entry.headLength += Math.min(piece.length, SNIFF_LENGTH - body.entry.headLength);
          }
        } else if (body.record !== undefined) {
          body.record.chunks.push(piece);
        }
        at += take;
        position += take;
        body = { ...body, remaining: body.remaining - take };
        if (body.remaining === 0) {
          finishBody(body);
          body = undefined;
        }
      } else if (padding > 0) {
        const take = Math.min(padding, chunk.length - at);
        at += take;
        position += take;
        padding -= take;
      } else {
        const take = Math.min(BLOCK - headerLength, chunk.length - at);
        header.push(chunk.subarray(at, at + take));
        headerLength += take;
        at += take;
        position += take;
        if (headerLength === BLOCK) {
          const block = Buffer.concat(header);
          header = [];
          headerLength = 0;
          startEntry(block);
        }
      }
    }
  };

  const sink = new Writable({
    write(chunk: Buffer, _encoding, done): void {
      whole.update(chunk);
      try {
        consume(chunk);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
  const result = (): ILayerIndex => {
    if (!ended || body !== undefined) {
      throw new FabrError("a layer's tar ends before its end-of-archive marker");
    }
    return { entries, diffId: `sha256:${whole.digest("hex")}` };
  };
  return { sink, result };
}

function entryOf(h: IHeader): ILayerEntry {
  return {
    path: h.path,
    type: h.type,
    mode: h.mode,
    uid: h.uid,
    gid: h.gid,
    ...(h.type === "symlink" || h.type === "hardlink" ? { linkname: h.type === "hardlink" ? checkedPath(h.linkname) : h.linkname } : {}),
  };
}

/** Read an entry's path relative to the tree's root, `.` and `..` collapsed and a trailing `/` dropped, refusing one that leaves the tree; the root itself is the empty path. */
function checkedPath(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") {
    return "";
  }
  const normalized = normalizeEntryName(trimmed);
  if (normalized === undefined) {
    throw new FabrError(`a layer's entry '${raw}' leaves the image's filesystem`);
  }
  return normalized;
}

function parseHeader(block: Buffer): IHeader & { size: number } {
  const checksum = numberField(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (checksum !== sum) {
    throw new FabrError("a layer's tar has a header whose checksum does not match");
  }
  const ustar = block.toString("latin1", 257, 262) === "ustar";
  const prefix = ustar ? textField(block, 345, 155) : "";
  const name = textField(block, 0, 100);
  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    type: entryType(String.fromCharCode(block[156])),
    mode: numberField(block, 100, 8) & 0o7777,
    uid: numberField(block, 108, 8),
    gid: numberField(block, 116, 8),
    size: numberField(block, 124, 12),
    linkname: textField(block, 157, 100),
  };
}

function entryType(flag: string): LayerEntryType {
  switch (flag) {
    case "0":
    case "\0":
    case "7":
      return "file";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "5":
      return "directory";
    default:
      return "other";
  }
}

function textField(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end === -1 ? length : end);
}

/** Read a numeric field: octal text, or GNU's base-256 where its first byte's high bit is set. */
function numberField(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let index = 1; index < length; index++) {
      value = value * 256 + field[index];
    }
    return value;
  }
  const text = field.toString("latin1").replace(/[\0 ]+.*$/s, "").trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/** Read the fields fabr uses from a pax extended header's records (`<length> <key>=<value>\n`). */
function paxFields(data: Buffer): IPending {
  const fields: IPending = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) {
      break;
    }
    const length = parseInt(data.toString("latin1", at, space), 10);
    if (!(length > 0)) {
      break;
    }
    const record = data.toString("utf8", space + 1, at + length - 1);
    const eq = record.indexOf("=");
    const key = record.substring(0, eq);
    const value = record.substring(eq + 1);
    if (key === "path") {
      fields.path = value;
    } else if (key === "linkpath") {
      fields.linkname = value;
    } else if (key === "size") {
      fields.size = Number(value);
    } else if (key === "uid") {
      fields.uid = Number(value);
    } else if (key === "gid") {
      fields.gid = Number(value);
    }
    at += length;
  }
  return fields;
}

/** Make an output whose bytes also go to `sink`, which has finished before the output is finalized. */
export function teeOutput(output: IOutputHandle, sink: Writable): IOutputHandle {
  const stream = new PassThrough();
  stream.pipe(output.stream, { end: false });
  stream.pipe(sink);
  const finished = (): Computable<void> =>
    Computable.from<void>((resolve, reject) => {
      sink.on("error", reject);
      if (sink.writableFinished) {
        resolve();
      } else {
        sink.on("finish", () => resolve());
      }
      stream.end();
    });
  return {
    stream,
    finalize: (name, mode) => finished().then(() => output.finalize(name, mode)),
    discard: () => {
      sink.destroy();
      return output.discard();
    },
  };
}
