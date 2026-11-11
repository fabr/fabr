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

import * as path from "path";
import { Readable } from "stream";
import * as yazl from "yazl";
import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { readStream } from "../core/Fetch";
import { mapComputable } from "./Functional";
import { FileSet, IFile } from "../core/FileSet";
import { contentStream } from "../core/FSWrapper";
import { SymlinkFile } from "../core/SymlinkFile";
import type { IOutputHandle } from "./Execute";
import { MIME_ZIP } from "./Mime";
import { archiveEntryNames, normalizeEntryName } from "./Paths";

export interface ZipOptions {
  /** Names to write before every other entry, in this order (a jar's
   *  `META-INF/MANIFEST.MF`); the rest follow in sorted order. */
  first?: readonly string[];
  /** Whether a {@link SymlinkFile} is written as a symlink entry, its content the
   *  link's target, which must name a place within the archive; otherwise it is refused. */
  symlinks?: boolean;
}

/* The date stamped on every entry: 1980-01-01 00:00, the format's epoch. Built
 * from local components, as yazl writes the DOS date from local time, so the
 * same bytes come out in every timezone; with `forceDosTimestamp`, it is the
 * only time recorded. */
const ZIP_DATE = new Date(1980, 0, 1);
const ZIP_DIRECTORY_MODE = 0o40755;
const ZIP_FILE_TYPE = 0o100000;
const ZIP_SYMLINK_MODE = 0o120777;

/**
 * Pack a FileSet into a zip archive (a jar) in memory; see {@link writeZip}.
 */
export function packToZip(files: FileSet, options: ZipOptions = {}): Computable<Buffer> {
  return archiveOf(files, options).then(({ zip, output }) => {
    const archive = readStream(output);
    zip.end();
    return archive;
  });
}

/**
 * Write a FileSet as a zip archive (a jar) into `output`, and answer the stored
 * file, named `name`, with `yazl`. Each file is deflated, streamed from where
 * its content is when the archive reaches it, except one that is itself a zip
 * archive (a nested jar): that is stored uncompressed, since deflating it gains
 * nothing and a loader reading it in place needs it stored, and is read whole
 * first, as a stored entry's checksum and size must precede its data for
 * `java.util.zip.ZipInputStream` to read it. Every directory above a file gets
 * an entry of its own, entries are written in sorted name order after
 * `options.first`, and each carries a fixed date and the file's own mode, so
 * the output is deterministic.
 */
export function writeZip(files: FileSet, output: IOutputHandle, name: string, options: ZipOptions = {}): Computable<IFile> {
  return archiveOf(files, options)
    .then(archive =>
      Computable.from<void>((resolve, reject) => {
        archive.output.on("error", reject);
        archive.output.on("end", () => resolve());
        output.stream.on("error", reject);
        archive.output.pipe(output.stream, { end: false });
        archive.zip.end();
      })
    )
    .then(
      () => output.finalize(name),
      (err: Error) =>
        output.discard().then(() => {
          throw err;
        })
    );
}

/** One entry of an archive, in the order written. */
type ArchiveEntry =
  | { kind: "directory"; name: string }
  | { kind: "stored"; name: string; content: Buffer; mode: number }
  | { kind: "deflated"; name: string; file: IFile };

/** Make the archive of `files`, its entries added but not ended, and the stream it is
 *  written to, on which the failure of any entry is reported. */
function archiveOf(files: FileSet, options: ZipOptions): Computable<{ zip: yazl.ZipFile; output: Readable }> {
  return entriesOf(files, options).then(entries => {
    const zip = new yazl.ZipFile();
    const output = zip.outputStream as Readable;
    /* yazl reports a failed entry on the ZipFile, and leaves an entry's own read stream's errors unhandled. */
    const fail = (err: Error): void => {
      output.destroy(err);
    };
    zip.on("error", fail);
    for (const entry of entries) {
      if (entry.kind === "directory") {
        zip.addEmptyDirectory(entry.name, { mtime: ZIP_DATE, mode: ZIP_DIRECTORY_MODE, forceDosTimestamp: true });
      } else if (entry.kind === "stored") {
        zip.addBuffer(entry.content, entry.name, { mtime: ZIP_DATE, mode: entry.mode, forceDosTimestamp: true, compress: false });
      } else {
        const { file } = entry;
        /* Opened only when yazl reaches the entry, so an archive of many files holds one open at a time. */
        zip.addReadStreamLazy(
          entry.name,
          { mtime: ZIP_DATE, mode: ZIP_FILE_TYPE | (file.mode & 0o7777), forceDosTimestamp: true },
          done => {
            contentStream(file).then(
              stream => done(null, stream.on("error", fail)),
              (err: Error) => done(err, undefined as unknown as Readable)
            );
          }
        );
      }
    }
    return { zip, output };
  });
}

/** @return the entries of the archive of `files`, in order, a stored entry's content read. */
function entriesOf(files: FileSet, options: ZipOptions): Computable<ArchiveEntry[]> {
  const ordered = archiveEntryNames(
    [...files].map(([name]) => name),
    { directories: true, first: (options.first ?? []).filter(name => files.getFile(name) !== undefined) }
  );
  return mapComputable(ordered, (name): ArchiveEntry | Computable<ArchiveEntry> => {
    if (name.endsWith("/")) {
      return { kind: "directory", name };
    }
    const file = files.getFile(name)!;
    if (file instanceof SymlinkFile) {
      return { kind: "stored", name, content: Buffer.from(linkTarget(name, file, options), "utf8"), mode: ZIP_SYMLINK_MODE };
    }
    if (file.mime === MIME_ZIP) {
      return file
        .getBuffer()
        .then(content => ({ kind: "stored" as const, name, content, mode: ZIP_FILE_TYPE | (file.mode & 0o7777) }));
    }
    return { kind: "deflated", name, file };
  });
}

/** @return the target of the link at `name`, refused where symlinks are not to be stored or the target leaves the archive. */
function linkTarget(name: string, file: SymlinkFile, options: ZipOptions): string {
  if (!options.symlinks) {
    throw new FabrError(`cannot zip '${name}': it is a symlink`);
  }
  /* normalizeEntryName makes an absolute name relative, which for a link's target would change what it names. */
  if (path.posix.isAbsolute(file.target) || normalizeEntryName(path.posix.join(path.posix.dirname(name), file.target)) === undefined) {
    throw new FabrError(`cannot zip '${name}': it links to '${file.target}', outside the archive`);
  }
  return file.target;
}
