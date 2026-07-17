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
import { stat } from "../core/FSWrapper";

/**
 * A fixed mtime stamped on every entry: the tarball must be a pure function of
 * its file contents (it is content-addressed and cached like any other build
 * output), so the wall-clock at pack time must not leak into the bytes. The
 * exact value is arbitrary; a constant is all that matters.
 */
const FIXED_MTIME = new Date(0);

/**
 * An entry's tar mode: 0o755 if the backing file is executable, else 0o644 —
 * exactly two values, so the archive stays deterministic. The exec bit rides
 * the on-disk blob, never the IFile or its hash (the dual of {@link unpackStream}
 * preserving it on the way in), so a path-less in-memory file is plain 0o644.
 */
function entryMode(file: IFile): Computable<number> {
  const abspath = file.getAbsPath();
  return abspath === undefined
    ? Computable.resolve(0o644)
    : stat(abspath).then(stats => ((stats.mode & 0o100) !== 0 ? 0o755 : 0o644));
}

/**
 * Pack a FileSet into a single gzip-compressed tar archive — the inverse of
 * {@link unpackStream}. Entries are emitted in sorted name order with a fixed
 * mtime and normalized modes (0o755/0o644 by the source's exec bit) so the
 * output is deterministic (byte-identical for identical content).
 * Names are taken verbatim: any layout convention (npm's `package/` prefix,
 * say) is the caller's to impose on the FileSet first.
 */
export function packToTarball(files: FileSet): Computable<Buffer> {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Computable.forAll(
    entries.map(([, file]) => Computable.forAll([file.getBuffer(), entryMode(file)], (buffer: Buffer, mode: number) => ({ buffer, mode }))),
    (...contents: { buffer: Buffer; mode: number }[]) => contents
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
          const { buffer, mode } = contents[index];
          index++;
          pack.entry({ name, size: buffer.length, mtime: FIXED_MTIME, mode }, buffer, err =>
            err ? reject(err) : writeNext()
          );
        };
        writeNext();
      })
  );
}
