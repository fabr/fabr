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

import { createGzip } from "zlib";
import * as tar from "tar-stream";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { SymlinkFile } from "../core/SymlinkFile";

/**
 * A fixed mtime stamped on every entry: the tarball must be a pure function of
 * its file contents (it is content-addressed and cached like any other build
 * output), so the wall-clock at pack time must not leak into the bytes. The
 * exact value is arbitrary; a constant is all that matters.
 */
const FIXED_MTIME = new Date(0);

/**
 * The tar-ready form of one entry — the dual of the split {@link unpackStream}
 * produces on the way in:
 *   - `file`: a regular file, its content + normalized mode.
 *   - `symlink`: names its target (`linkname`), no body. Fixed 0o777 mode (its
 *     content is the target, so it has no exec bit of its own).
 *   - `hardlink`: a later entry whose content is byte-identical to an earlier
 *     one — emitted as a tar hardlink (`type: "link"`) to that first entry
 *     rather than packing the bytes twice. Content-addressed storage already
 *     dedups the blob; this dedups the archive. No body; fixed mode (a hardlink
 *     shares the target inode, so its own mode field is ignored on extraction).
 */
type PackEntry =
  | { kind: "file"; buffer: Buffer; mode: number }
  | { kind: "symlink"; linkname: string }
  | { kind: "hardlink"; linkname: string };

function entryContent(file: IFile): Computable<PackEntry> {
  if (file instanceof SymlinkFile) {
    return Computable.resolve({ kind: "symlink", linkname: file.target });
  }
  /* The file's original mode (full 0o7777, from the manifest) — the tarball is a
   * faithful export, and it is deterministic because mode is a stored property,
   * not read from the read-only blob's own permission bits. */
  return file.getBuffer().then((buffer: Buffer) => ({ kind: "file", buffer, mode: file.mode & 0o7777 }));
}

/**
 * Pack a FileSet into a single gzip-compressed tar archive — the inverse of
 * {@link unpackStream}. Entries are emitted in sorted name order with a fixed
 * mtime and each file's own (stored) mode, so the output is deterministic
 * (byte-identical for identical content).
 * Names are taken verbatim: any layout convention (npm's `package/` prefix,
 * say) is the caller's to impose on the FileSet first.
 */
export function packToTarball(files: FileSet): Computable<Buffer> {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  /* First entry (in sorted order) to carry each content hash — a repeat becomes
   * a hardlink to it, so identical content is packed once. Symlinks are excluded
   * (their "content" is the target text); the sorted order keeps this stable. */
  const firstByHash = new Map<string, string>();
  return Computable.forAll(
    entries.map(([name, file]) => {
      if (!(file instanceof SymlinkFile)) {
        const linkname = firstByHash.get(file.hash);
        if (linkname !== undefined) {
          return Computable.resolve<PackEntry>({ kind: "hardlink", linkname });
        }
        firstByHash.set(file.hash, name);
      }
      return entryContent(file);
    }),
    (...contents: PackEntry[]) => contents
  ).then(
    contents =>
      Computable.from<Buffer>((resolve, reject) => {
        const pack = tar.pack();
        const gzip = createGzip();
        const chunks: Buffer[] = [];
        gzip.on("data", chunk => chunks.push(chunk));
        gzip.on("end", () => resolve(Buffer.concat(chunks)));
        gzip.on("error", err => reject(err));
        pack.on("error", err => reject(err));
        pack.pipe(gzip);

        let index = 0;
        const writeNext = (): void => {
          if (index >= entries.length) {
            pack.finalize();
            return;
          }
          const [name] = entries[index];
          const entry = contents[index];
          index++;
          const done = (err?: Error | null): void => (err ? reject(err) : writeNext());
          if (entry.kind === "symlink") {
            /* A symlink carries no body; its target rides in `linkname`. */
            pack.entry({ name, type: "symlink", linkname: entry.linkname, mtime: FIXED_MTIME, mode: 0o777 }, done);
          } else if (entry.kind === "hardlink") {
            /* A hardlink carries no body; `linkname` names the entry it shares
             * content with (packed earlier in sorted order). */
            pack.entry({ name, type: "link", linkname: entry.linkname, mtime: FIXED_MTIME, mode: 0o644 }, done);
          } else {
            pack.entry({ name, size: entry.buffer.length, mtime: FIXED_MTIME, mode: entry.mode }, entry.buffer, done);
          }
        };
        writeNext();
      })
  );
}
