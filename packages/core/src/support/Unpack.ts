import { Readable, Transform, Writable } from "stream";
import { pipeline } from "stream/promises";
import { createUnzip } from "zlib";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as tar from "tar-stream";
import { Computable } from "../core/Computable";
import { HASH_ALGORITHM } from "../core/FSWrapper";
import { FileSet } from "../core/FileSet";
import { FSFile } from "../core/FSFileSource";

export enum ArchiveType {
  AUTO,
  GZIP,
  ZIP,
  TAR,
  NONE,
}

const MIN_HEAD_LENGTH = 262; /* For TAR */

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
          depth++; // TODO
          const zip = createUnzip();
          magicByteStream(zip, MIN_HEAD_LENGTH, handleHeader, reject);
          return zip;
        }
        case ArchiveType.TAR: {
          const extract = tar.extract();
          const files: Computable<FSFile>[] = [];
          const root = path.resolve(targetdir);
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
            } else {
              files.push(
                Computable.from((resolveFile, rejectFile) => {
                  const hash = crypto.createHash(HASH_ALGORITHM);
                  const dir = path.dirname(pathname);
                  fs.mkdirSync(dir, { recursive: true });
                  /* Preserve the entry's permission bits (masked; setuid/setgid/
                   * sticky dropped) so an executable — e.g. esbuild's native
                   * binary in @esbuild/<platform> — lands runnable. Staging
                   * hardlinks the cache file, so the bit propagates for free; it
                   * travels with the content, so it stays out of the hash/manifest. */
                  const mode = (headers.mode ?? 0o644) & 0o777;
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
                      resolveFile(
                        new FSFile(
                          targetdir,
                          headers.name,
                          { mtime: headers.mtime ?? new Date(), size: headers.size ?? 0 },
                          hash.digest("hex")
                        )
                      )
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
                const fileMap = new Map();
                f.forEach(file => fileMap.set(file.name, file));
                return new FileSet(fileMap);
              })
            );
          });
          return extract;
        }
        default:
          reject(new Error("Unsupported archive file"));
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
