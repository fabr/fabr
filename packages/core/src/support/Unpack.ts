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

/* Cap on nested compression layers: a real package is a single gzip layer over
 * a tar (`.tgz`), so anything beyond a small bound is a malformed or hostile
 * archive (an unbounded gzip-of-gzip nesting from a compromised registry). The
 * cumulative decompressed-size ceiling — the real bomb defense — is future work. */
const MAX_COMPRESSION_LAYERS = 4;

/**
 * Unpack an archive stream into a {@link FileSet}, streaming each entry directly
 * into the content-addressed store via `createOutput` — no scratch directory. So
 * an archive name never places bytes at an on-disk path: tar-slip is structurally
 * impossible, and two entries differing only in case survive as distinct blobs
 * (rejected only if actually staged to a case-folding filesystem — see
 * writeFileSet). An absolute entry name is made relative (leading `/` stripped,
 * standard tar behavior); a `../` traversal that escapes the tree is dropped.
 */
export function unpackStream(ins: Readable, createOutput: () => IOutputHandle): Computable<FileSet> {
  /* This is fed the live network response, so any hop can fail (a header
   * truncated below SNIFF_LENGTH, a mid-stream connection drop, a write
   * error) via several independent listeners: Computable.fromOnce keeps the first
   * outcome so a later terminal event can't re-settle. */
  return Computable.fromOnce((resolve, reject) => {
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
          /* `.tar.xz` — the shape most native toolchains publish. A compression
           * layer like gzip's, re-sniffed the same way and counted against the
           * same bound. */
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

function magicByteStream(
  ins: Readable,
  headerSize: number,
  cb: (data: Buffer) => Writable | null,
  onError: (err: Error) => void
): void {
  const buffers: Buffer[] = [];
  let bufferSize = 0;

  function headerEnd(): void {
    /* Input stream ended early. Well, try anway */
    invokeCallback();
  }

  function headerError(err: Error): void {
    /* Input stream failed before we had a full header — settle the build rather
     * than hanging forever on a Computable that never resolves. */
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
      /* Past the header, the pipe is live: a mid-stream input drop or an output
       * (decompressor/tar-parse) failure must reject, not throw an uncaught
       * 'error' that takes down the process. */
      ins.on("error", err => outs.destroy(err));
      outs.on("error", onError);
    }
  }

  ins.on("data", headerData);
  ins.on("end", headerEnd);
  ins.on("error", headerError);
}
