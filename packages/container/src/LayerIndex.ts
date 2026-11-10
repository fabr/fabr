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
import {
  Computable,
  decodeBlock,
  decodeLongPath,
  decodePaxRecords,
  FabrError,
  GNU_LONG_LINK_PATH,
  HASH_ALGORITHM,
  headerOf,
  IOutputHandle,
  isDescribingBlock,
  isLongPathBlock,
  ITarBlock,
  normalizeEntryName,
  paddingOf,
  PAX_GLOBAL_HEADER,
  PAX_HEADER,
  sniffMime,
  SNIFF_LENGTH,
  TAR_BLOCK_SIZE,
  TarEntryType,
} from "@fabr-build/core";

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

/** A header whose body is still being read: an entry's content, or a pax/GNU block describing the next. */
interface IBody {
  readonly remaining: number;
  readonly entry?: { header: IHeader; offset: number; hash: Hash; head: Buffer[]; headLength: number };
  readonly describing?: { block: ITarBlock; chunks: Buffer[] };
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
 * Reads ustar, pax and GNU long names, as core's tar reader does; a name
 * leaving the tree is refused, as an unpacked archive's is.
 */
export function indexLayer(): { sink: Writable; result: () => ILayerIndex } {
  const entries: ILayerEntry[] = [];
  const whole = createHash(HASH_ALGORITHM);
  let position = 0;
  let header: Buffer[] = [];
  let headerLength = 0;
  let body: IBody | undefined;
  let padding = 0;
  const globalRecords = new Map<string, Buffer>();
  let records: Map<string, Buffer> | undefined;
  let longPath: string | undefined;
  let longLinkPath: string | undefined;
  let ended = false;

  const finishBody = (finished: IBody): void => {
    if (finished.entry !== undefined) {
      const { header: h, offset, hash, head } = finished.entry;
      entries.push({ ...entryOf(h), offset, size: h.size, hash: hash.digest("hex"), mime: sniffMime(Buffer.concat(head)) });
    } else if (finished.describing !== undefined) {
      const { block, chunks } = finished.describing;
      const content = Buffer.concat(chunks);
      if (block.typeflag === PAX_HEADER) {
        records = decodePaxRecords(content);
      } else if (block.typeflag === PAX_GLOBAL_HEADER) {
        for (const [key, value] of decodePaxRecords(content)) {
          globalRecords.set(key, value);
        }
      } else if (block.typeflag === GNU_LONG_LINK_PATH) {
        longLinkPath = decodeLongPath(content);
      } else if (isLongPathBlock(block.typeflag)) {
        longPath = decodeLongPath(content);
      }
    }
  };

  const startEntry = (raw: Buffer): void => {
    const block = decodeBlock(raw);
    if (block === null) {
      ended = true;
      return;
    }
    if (isDescribingBlock(block.typeflag)) {
      padding = paddingOf(block.size);
      body = { remaining: block.size, describing: { block, chunks: [] } };
    } else {
      const merged = new Map(globalRecords);
      for (const [key, value] of records ?? []) {
        merged.set(key, value);
      }
      const read = headerOf(block, merged, longPath, longLinkPath);
      records = longPath = longLinkPath = undefined;
      const h: IHeader = {
        path: checkedPath(read.name),
        type: entryType(read.type),
        mode: read.mode & 0o7777,
        uid: read.uid,
        gid: read.gid,
        size: read.type === "directory" ? 0 : read.size,
        linkname: read.linkname,
      };
      padding = paddingOf(h.size);
      if (h.type === "file") {
        body = { remaining: h.size, entry: { header: h, offset: position, hash: createHash(HASH_ALGORITHM), head: [], headLength: 0 } };
      } else {
        entries.push(entryOf(h));
        body = { remaining: h.size };
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
        } else if (body.describing !== undefined) {
          body.describing.chunks.push(piece);
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
        const take = Math.min(TAR_BLOCK_SIZE - headerLength, chunk.length - at);
        header.push(chunk.subarray(at, at + take));
        headerLength += take;
        at += take;
        position += take;
        if (headerLength === TAR_BLOCK_SIZE) {
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

function entryType(type: TarEntryType | null): LayerEntryType {
  switch (type) {
    case "file":
    case "contiguous-file":
      return "file";
    case "link":
      return "hardlink";
    case "symlink":
      return "symlink";
    case "directory":
      return "directory";
    default:
      return "other";
  }
}

/** Make an output whose bytes also go to `sink`, which has finished before the output is finalized. */
export function teeOutput(output: IOutputHandle, sink: Writable): IOutputHandle {
  const stream = new PassThrough();
  let failure: Error | undefined;
  sink.on("error", err => {
    failure = err;
  });
  stream.pipe(output.stream, { end: false });
  stream.pipe(sink);
  const finished = (): Computable<void> =>
    Computable.from<void>((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure);
      } else if (sink.writableFinished) {
        resolve();
      } else {
        sink.on("error", reject);
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
