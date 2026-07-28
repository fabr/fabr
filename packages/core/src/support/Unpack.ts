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
import * as path from "path";
import * as tar from "tar-stream";
import type { IOutputHandle } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { SymlinkFile } from "../core/SymlinkFile";

export enum ArchiveType {
  AUTO,
  GZIP,
  ZIP,
  TAR,
  NONE,
}

const MIN_HEAD_LENGTH = 262; /* For TAR */

/* Cap on nested compression layers: a real package is a single gzip layer over
 * a tar (`.tgz`), so anything beyond a small bound is a malformed or hostile
 * archive (an unbounded gzip-of-gzip nesting from a compromised registry). The
 * cumulative decompressed-size ceiling — the real bomb defense — is future work. */
const MAX_COMPRESSION_LAYERS = 4;

/** Normalize a tar entry name to a safe relative FileSet key: strip a leading
 * `/` (an absolute archive name → relative, standard tar behavior) and collapse
 * `.`/`..` segments. A name that still escapes the tree (a `../` traversal in an
 * untrusted network tarball) or is empty returns undefined — dropped. */
function normalizeEntryName(raw: string): string | undefined {
  const normalized = path.posix.normalize(raw.replace(/^\/+/, ""));
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

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
   * truncated below MIN_HEAD_LENGTH, a mid-stream connection drop, a write
   * error) via several independent listeners: Computable.once keeps the first
   * outcome so a later terminal event can't re-settle. */
  return Computable.once((resolve, reject) => {
    let depth = 0;
    function handleHeader(data: Buffer): Writable | null {
      switch (getMagic(data)) {
        case ArchiveType.GZIP: {
          if (++depth > MAX_COMPRESSION_LAYERS) {
            reject(new Error(`Archive nests more than ${MAX_COMPRESSION_LAYERS} compression layers`));
            return null;
          }
          const zip = createUnzip();
          magicByteStream(zip, MIN_HEAD_LENGTH, handleHeader, reject);
          return zip;
        }
        case ArchiveType.TAR: {
          const extract = tar.extract();
          const files: Computable<[string, IFile]>[] = [];
          /* Every emitted entry, keyed by its (normalized) in-archive name, so a
           * later hardlink can resolve to the file its `linkname` already produced. */
          const byName = new Map<string, Computable<IFile>>();
          const emit = (name: string, file: Computable<[string, IFile]>): void => {
            files.push(file);
            byName.set(name, file.then(([, f]) => f));
          };
          extract.on("entry", (headers, entry, next) => {
            entry.on("end", () => next());
            const name = normalizeEntryName(headers.name);
            if (name === undefined || headers.type === "directory") {
              /* A directory carries no file; a name that escapes the tree (a `../`
               * traversal in an untrusted network tarball) is dropped. */
              entry.resume();
            } else if (headers.type === "symlink") {
              /* A symlink names its target (`linkname`, relative to the link's own
               * directory) and has no body — emit a SymlinkFile carrying the target
               * and drain the (empty) entry. The target may escape the tree; that
               * is guarded when the set is staged (writeFileSet), not here. */
              emit(name, Computable.resolve([name, new SymlinkFile(headers.linkname ?? "")]));
              entry.resume();
            } else if (headers.type === "link") {
              /* A hardlink has no body — its `linkname` names an earlier entry
               * whose content it shares. Content-addressed storage makes that a
               * pure dedup: reuse the target's file (same hash → one blob, two
               * names). An unknown target (dropped for escaping, or malformed)
               * drops the link too. */
              const target = byName.get(normalizeEntryName(headers.linkname ?? "") ?? "");
              if (target) {
                emit(name, target.then(f => [name, f]));
              }
              entry.resume();
            } else {
              /* A regular file: stream its body straight into a CAS blob (the sink
               * hashes as it writes), preserving the entry's full permission bits
               * (setuid/setgid/sticky included) so an executable — e.g. esbuild's
               * native binary in @esbuild/<platform> — lands runnable. `finalize`
               * places the blob under its content hash and yields the file;
               * `{ end: false }` leaves the sink for finalize to end, not the pipe. */
              const mode = (headers.mode ?? 0o644) & 0o7777;
              const output = createOutput();
              emit(
                name,
                Computable.from<[string, IFile]>((resolveFile, rejectFile) => {
                  /* A write/read failure settles this file AND the whole unpack (a
                   * stalled tar whose `finish` never fires can't hang the outer),
                   * and drops the half-written blob. */
                  const fail = (err: Error): void => {
                    output.discard();
                    rejectFile(err);
                    reject(err);
                  };
                  output.stream.on("error", fail);
                  entry.on("error", fail);
                  entry.pipe(output.stream, { end: false });
                  entry.on("end", () => {
                    output.finalize(name, mode).then(file => resolveFile([name, file]), fail);
                  });
                })
              );
            }
          });
          extract.on("finish", () => {
            resolve(
              Computable.forAll(files, (...f) => {
                const fileMap = new Map<string, IFile>();
                f.forEach(([name, file]) => fileMap.set(name, file));
                return new FileSet(fileMap);
              })
            );
          });
          return extract;
        }
        case ArchiveType.ZIP:
          reject(new Error("ZIP archives are not supported (expected a gzip-compressed tarball)"));
          return null;
        default:
          reject(new Error("Unsupported archive file (expected a gzip-compressed tarball)"));
          return null;
      }
    }

    magicByteStream(ins, MIN_HEAD_LENGTH, handleHeader, reject);
  });
}

export function getMagic(buf: Buffer): ArchiveType {
  if (buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) {
    return ArchiveType.GZIP;
  } else if (buf[257] === 0x75 && buf[258] === 0x73 && buf[259] === 0x74 && buf[260] === 0x61 && buf[261] === 0x72) {
    return ArchiveType.TAR;
  } else if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return ArchiveType.ZIP;
  } else {
    return ArchiveType.NONE;
  }
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
