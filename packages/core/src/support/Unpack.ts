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

import { Readable, Writable } from "stream";
import { createUnzip } from "zlib";
import { createDecompressStream } from "@napi-rs/lzma/xz";
import type { IOutputHandle } from "./Execute";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { MIME_GZIP, MIME_TAR, MIME_XZ, MIME_ZIP, SNIFF_LENGTH, sniffMime } from "./Mime";
import { FabrError } from "../core/Errors";
import { extractTar } from "./UnpackTar";
import { extractZip } from "./UnpackZip";

/* The most compression layers (gzip or xz) an archive may nest. Keep the
 * bound: an archive is untrusted, and one nesting layer upon layer is
 * malformed or hostile. Nothing bounds the total decompressed size. */
const MAX_COMPRESSION_LAYERS = 4;

/**
 * Unpack an archive stream into a {@link FileSet}: a tar or zip archive, under
 * any number of gzip or xz layers up to {@link MAX_COMPRESSION_LAYERS}, judged
 * by its leading bytes.
 *
 * Each file is written to an output of its own from `createOutput` (a zip is
 * first written whole to one, then read from it); an entry's name never
 * places bytes at a path on disk. An absolute entry name is made relative; an
 * entry whose name escapes the tree with `../` is dropped. Two names differing
 * only in case stay two files.
 *
 * Rejects where the archive is of no known kind, nests too many compression
 * layers, or fails to read or write.
 */
export function unpackStream(ins: Readable, createOutput: () => IOutputHandle): Computable<FileSet> {
  /* Several listeners may report a failure (a short header, a dropped
   * connection, a write error); Computable.from keeps the first outcome. */
  return Computable.from((resolve, reject) => {
    let depth = 0;
    function handleHeader(data: Buffer): Writable | null {
      switch (sniffMime(data)) {
        case MIME_GZIP: {
          if (++depth > MAX_COMPRESSION_LAYERS) {
            reject(new FabrError(`Archive nests more than ${MAX_COMPRESSION_LAYERS} compression layers`));
            return null;
          }
          const zip = createUnzip();
          magicByteStream(zip, SNIFF_LENGTH, handleHeader, reject);
          return zip;
        }
        case MIME_XZ: {
          /* A compression layer like gzip's (`.tar.xz`), counted against the same bound. */
          if (++depth > MAX_COMPRESSION_LAYERS) {
            reject(new FabrError(`Archive nests more than ${MAX_COMPRESSION_LAYERS} compression layers`));
            return null;
          }
          const xz = createDecompressStream();
          magicByteStream(xz, SNIFF_LENGTH, handleHeader, reject);
          return xz;
        }
        case MIME_TAR: {
          const { sink, result } = extractTar(createOutput);
          resolve(result);
          return sink;
        }
        case MIME_ZIP: {
          const { sink, result } = extractZip(createOutput);
          resolve(result);
          return sink;
        }
        default:
          reject(new FabrError("Unsupported archive file (expected a tarball, compressed or not, or a zip)"));
          return null;
      }
    }

    magicByteStream(ins, SNIFF_LENGTH, handleHeader, reject);
  });
}

/** Buffer the first `headerSize` bytes of `ins` (fewer where it ends first),
 * hand them to `cb`, and pipe the whole stream into the sink `cb` returns, or
 * destroy it where `cb` returns null. Failures are reported to `onError`. */
function magicByteStream(
  ins: Readable,
  headerSize: number,
  cb: (data: Buffer) => Writable | null,
  onError: (err: Error) => void
): void {
  const buffers: Buffer[] = [];
  let bufferSize = 0;

  function headerEnd(): void {
    /* The input ended before a whole header: judge what arrived. */
    invokeCallback();
  }

  function headerError(err: Error): void {
    /* The input failed before a whole header arrived. */
    onError(err);
  }

  function headerData(data: Buffer): void {
    buffers.push(data);
    bufferSize += data.length;
    if (bufferSize >= headerSize) {
      invokeCallback();
    }
  }

  function invokeCallback(): void {
    ins.removeListener("data", headerData);
    ins.removeListener("end", headerEnd);
    ins.removeListener("error", headerError);
    const head = Buffer.concat(buffers);
    const outs = cb(head);
    if (!outs) {
      ins.destroy();
    } else {
      outs.write(head);
      ins.pipe(outs);
      /* Report a failure of either side through `onError`: an unhandled
       * 'error' event would end the process. */
      ins.on("error", err => outs.destroy(err));
      outs.on("error", onError);
    }
  }

  ins.on("data", headerData);
  ins.on("end", headerEnd);
  ins.on("error", headerError);
}
