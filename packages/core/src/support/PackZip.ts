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

import { Readable } from "stream";
import * as yazl from "yazl";
import { Computable } from "../core/Computable";
import { readStream } from "../core/Fetch";
import { mapComputable } from "./Functional";
import { FileSet } from "../core/FileSet";
import { MIME_ZIP, sniffMime } from "./Mime";
import { SymlinkFile } from "../core/SymlinkFile";

export interface ZipOptions {
  /** Names to write before every other entry, in this order (a jar's
   *  `META-INF/MANIFEST.MF`); the rest follow in sorted order. */
  first?: readonly string[];
}

/* The date stamped on every entry: 1980-01-01 00:00, the format's epoch. Built
 * from local components, as yazl writes the DOS date from local time, so the
 * same bytes come out in every timezone; with `forceDosTimestamp`, it is the
 * only time recorded. */
const ZIP_DATE = new Date(1980, 0, 1);
const ZIP_DIRECTORY_MODE = 0o40755;
const ZIP_FILE_TYPE = 0o100000;

/** @return the directory entries above `name`, outermost first (`a/`, `a/b/`). */
function ancestorsOf(name: string): string[] {
  const ancestors: string[] = [];
  for (let slash = name.indexOf("/"); slash !== -1; slash = name.indexOf("/", slash + 1)) {
    ancestors.push(name.substring(0, slash + 1));
  }
  return ancestors;
}

/**
 * Pack a FileSet into a zip archive (a jar), with `yazl`. Each file is
 * deflated, except one that is itself a zip archive (a nested jar), which is
 * stored uncompressed: deflating it gains nothing, and a loader reading it in
 * place needs it stored. Every directory above a file gets an entry of its
 * own, entries are written in sorted name order after `options.first`, and
 * each carries a fixed date and the file's own mode, so the output is
 * deterministic. Symlinks are refused.
 */
export function packToZip(files: FileSet, options: ZipOptions = {}): Computable<Buffer> {
  const names = [...files].map(([name]) => name);
  const directories = new Set(names.flatMap(ancestorsOf));
  const first = (options.first ?? []).filter(name => files.getFile(name) !== undefined);
  const leading = first.flatMap(name => [...ancestorsOf(name), name]).filter((name, index, all) => all.indexOf(name) === index);
  const ordered = [...leading, ...[...directories, ...names].filter(name => !leading.includes(name)).sort()];
  return mapComputable(ordered, (name): Buffer | undefined | Computable<Buffer> => {
    if (name.endsWith("/")) {
      return undefined;
    }
    const file = files.getFile(name)!;
    if (file instanceof SymlinkFile) {
      throw new Error(`cannot zip '${name}': it is a symlink`);
    }
    return file.getBuffer();
  }).then(contents => {
    const zip = new yazl.ZipFile();
    ordered.forEach((name, index) => {
      const content = contents[index];
      if (content === undefined) {
        zip.addEmptyDirectory(name, { mtime: ZIP_DATE, mode: ZIP_DIRECTORY_MODE, forceDosTimestamp: true });
      } else {
        zip.addBuffer(content, name, {
          mtime: ZIP_DATE,
          mode: ZIP_FILE_TYPE | (files.getFile(name)!.mode & 0o7777),
          forceDosTimestamp: true,
          compress: sniffMime(content) !== MIME_ZIP,
        });
      }
    });
    /* yazl's output stream is a PassThrough. */
    const archive = readStream(zip.outputStream as Readable);
    zip.end();
    return archive;
  });
}
