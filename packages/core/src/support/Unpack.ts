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

import { Readable, Transform, Writable } from "stream";
import { pipeline } from "stream/promises";
import { createUnzip } from "zlib";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as tar from "tar-stream";
import { Computable } from "../core/Computable";
import { HASH_ALGORITHM } from "../core/FSWrapper";
import { FileSet, IFile } from "../core/FileSet";
import { FSFile } from "../core/FSFileSource";
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

/**
 *
 * @param
 * @param targetdir
 */
export function unpackStream(ins: Readable, targetdir: string): Computable<FileSet> {
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
          /* Every emitted entry, keyed by its in-archive name, so a later
           * hardlink can resolve to the file its `linkname` already produced. */
          const byName = new Map<string, Computable<IFile>>();
          const root = path.resolve(targetdir);
          const emit = (name: string, file: Computable<[string, IFile]>): void => {
            files.push(file);
            byName.set(name, file.then(([, f]) => f));
          };
          extract.on("entry", (headers, entry, next) => {
            entry.on("end", () => {
              next();
            });
            const pathname = path.resolve(targetdir, headers.name);
            const contained = pathname === root || pathname.startsWith(root + path.sep);
            if (headers.type === "directory" || !contained) {
              /* Directories carry no file to write; an entry whose path escapes
               * `targetdir` (a tar-slip via a `../` or absolute name — untrusted,
               * these tarballs come from the network) is dropped for security. */
              entry.resume();
            } else if (headers.type === "symlink") {
              /* A symlink names its target (`linkname`, relative to the link's
               * own directory) and has no body — emit a SymlinkFile carrying
               * the target and drain the (empty) entry. The target may escape
               * the tree; that is guarded when the set is staged, not here. */
              emit(headers.name, Computable.resolve([headers.name, new SymlinkFile(headers.linkname ?? "")]));
              entry.resume();
            } else if (headers.type === "link") {
              /* A hardlink has no body — its `linkname` names an earlier entry
               * (archive-root-relative, tar orders targets first) whose content
               * it shares. Content-addressed storage makes that a pure dedup:
               * reuse the target's file (same hash → one blob, two manifest
               * names). An unknown target — dropped for escaping, or malformed —
               * drops the link too. */
              const target = byName.get(headers.linkname ?? "");
              if (target) {
                emit(headers.name, target.then(f => [headers.name, f]));
              }
              entry.resume();
            } else {
              emit(
                headers.name,
                Computable.from<[string, IFile]>((resolveFile, rejectFile) => {
                  /* An entry whose path already exists is a collision — most often
                   * two names differing only in case on a case-insensitive
                   * filesystem (APFS/NTFS), which would otherwise share one inode:
                   * the later write overwrites the earlier, and ingest would then
                   * store one entry's bytes under the other's hash — a blob whose
                   * content doesn't match its key. Fail cleanly instead. */
                  if (fs.existsSync(pathname)) {
                    const err = new Error(`Archive entry '${headers.name}' collides with an existing path (case-insensitive filesystem?)`);
                    rejectFile(err);
                    reject(err);
                    return;
                  }
                  const hash = crypto.createHash(HASH_ALGORITHM);
                  const dir = path.dirname(pathname);
                  fs.mkdirSync(dir, { recursive: true });
                  /* Preserve the entry's full permission bits (including
                   * setuid/setgid/sticky) so an executable — e.g. esbuild's
                   * native binary in @esbuild/<platform> — lands runnable, and so
                   * the original mode survives to a later export. The mode rides
                   * the FSFile (→ manifest); the on-disk work file is written with
                   * it too, but BuildCache re-chmods the pooled blob read-only. */
                  const mode = (headers.mode ?? 0o644) & 0o7777;
                  const outfile = fs.createWriteStream(pathname, { mode });
                  const hashTransform = new Transform({
                    transform: (chunk, _enc, cb) => {
                      hash.update(chunk);
                      cb(null, chunk);
                    },
                  });
                  /* Await the pipeline (not fire-and-forget): its promise is the one
                   * place that settles this file — a write/read failure would
                   * otherwise be an unhandled rejection and leave the entry never
                   * `next()`-ed. A file failure also fails the whole unpack directly,
                   * so a stalled tar (finish never fires) can't hang the outer. */
                  pipeline(entry, hashTransform, outfile)
                    .then(() =>
                      resolveFile([
                        headers.name,
                        new FSFile(
                          targetdir,
                          headers.name,
                          { mtime: headers.mtime ?? new Date(), size: headers.size ?? 0, mode },
                          hash.digest("hex")
                        ),
                      ])
                    )
                    .catch(err => {
                      rejectFile(err);
                      reject(err);
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
