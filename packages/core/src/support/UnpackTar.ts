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

import { Writable } from "stream";
import * as tar from "tar-stream";
import type { IOutputHandle } from "./Execute";
import { Computable } from "../core/Computable";
import { mapComputable } from "./Functional";
import { FileSet, IFile } from "../core/FileSet";
import { SymlinkFile } from "../core/SymlinkFile";
import { normalizeEntryName } from "./Paths";

/**
 * Read a tar archive as it streams in: each regular file is written to its
 * own output as it arrives, keeping its mode; a symlink becomes a
 * {@link SymlinkFile} and a hardlink shares its target's file. Directories,
 * and names that escape the tree, are dropped.
 * @return the sink to stream the archive into, and the files it holds.
 */
export function extractTar(createOutput: () => IOutputHandle): { sink: Writable; result: Computable<FileSet> } {
  let resolve!: (files: Computable<FileSet>) => void;
  let reject!: (err: Error) => void;
  const result = Computable.fromOnce<FileSet>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const extract = tar.extract();
  /* A failure of the stream feeding it (a dropped connection) destroys the sink. */
  extract.on("error", err => reject(err));
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
            output.discard().then(() => {
              rejectFile(err);
              reject(err);
            });
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
      mapComputable(files, file => file).then(f => {
        const fileMap = new Map<string, IFile>();
        f.forEach(([name, file]) => fileMap.set(name, file));
        return new FileSet(fileMap);
      })
    );
  });
  return { sink: extract, result };
}
