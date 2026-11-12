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
import type { IOutputHandle } from "./Execute";
import { Computable } from "../core/Computable";
import { mapComputable } from "./Functional";
import { FileSet, IFile } from "../core/FileSet";
import { SymlinkFile } from "../core/SymlinkFile";
import { normalizeEntryName } from "./Paths";
import { TarExtract } from "./TarExtract";

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
  const result = Computable.from<FileSet>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const extract = new TarExtract();
  /* A failure of the stream feeding it (a dropped connection) destroys the sink. */
  extract.on("error", err => reject(err));
  const files: Computable<[string, IFile]>[] = [];
  /* Each file emitted, by its normalized name, for a later hardlink to find. */
  const byName = new Map<string, Computable<IFile>>();
  const emit = (name: string, file: Computable<[string, IFile]>): void => {
    files.push(file);
    byName.set(
      name,
      file.then(([, f]) => f)
    );
  };
  extract.on("entry", (headers, entry, next) => {
    entry.on("end", () => next());
    const name = normalizeEntryName(headers.name);
    if (name === undefined || headers.type === "directory") {
      /* A directory carries no file. Drop a name that escapes the tree (a
       * `../` traversal): the archive is untrusted. */
      entry.resume();
    } else if (headers.type === "symlink") {
      /* A symlink's target (`linkname`) is relative to its own directory, and
       * may escape the tree: writeFileSet refuses that when the set is staged,
       * so keep the target as it is here. */
      emit(name, Computable.resolve([name, new SymlinkFile(headers.linkname)]));
      entry.resume();
    } else if (headers.type === "link") {
      /* A hardlink's `linkname` names an earlier entry whose content it
       * shares: the link takes that entry's file. A link to an entry not
       * emitted (dropped for escaping the tree, or absent) is dropped too. */
      const target = byName.get(normalizeEntryName(headers.linkname) ?? "");
      if (target) {
        emit(
          name,
          target.then(f => [name, f])
        );
      }
      entry.resume();
    } else {
      /* A regular file: its body streamed into its output, which `finalize`
       * stores with the entry's permission bits (setuid, setgid and sticky
       * included). Pipe with `{ end: false }`: finalize ends the stream. */
      const mode = headers.mode & 0o7777;
      const output = createOutput();
      emit(
        name,
        Computable.from<[string, IFile]>((resolveFile, rejectFile) => {
          /* A read or write failure discards the output and rejects both this
           * file and the whole extraction, whose `finish` may never fire. */
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
