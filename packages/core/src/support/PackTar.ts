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

import * as fs from "fs";
import { pipeline, Readable } from "stream";
import { createGzip } from "zlib";
import { Computable } from "../core/Computable";
import { stat } from "../core/FSWrapper";
import { FileSet, IFile } from "../core/FileSet";
import { SymlinkFile } from "../core/SymlinkFile";
import type { IOutputHandle } from "./Execute";
import { archiveEntryNames } from "./Paths";
import { TarPack } from "./TarPack";

/** The mtime of every entry. Keep it constant: an archive's bytes must depend
 * on its files alone. */
const FIXED_MTIME = new Date(0);

/** The mode of a directory entry (see {@link PackOptions.directories}). */
const DIRECTORY_MODE = 0o755;

/**
 * One entry of an archive, in the order written:
 *   - `directory`: a directory above a file (see {@link PackOptions.directories}).
 *   - `file`: a regular file, its content streamed when the archive reaches it.
 *   - `symlink`: a symlink to `linkname`, with no body.
 *   - `hardlink`: a file whose content is identical to the earlier entry
 *     `linkname`, written as a tar hardlink to it, with no body.
 */
type PackEntry =
  | { kind: "directory"; name: string }
  | { kind: "file"; name: string; file: IFile }
  | { kind: "symlink"; name: string; linkname: string }
  | { kind: "hardlink"; name: string; linkname: string };

export interface PackOptions {
  /**
   * Whether a file with the same content as an earlier one is packed as a tar
   * hardlink to it (see {@link PackEntry}). Default true. Turn it off for an
   * archive whose destination refuses hardlinks (npm's registry rejects an
   * upload containing one): any two files of identical content make one.
   */
  hardlinks?: boolean;
  /** Whether every directory above a file gets an entry of its own, mode 0755,
   *  before the entries within it (an OCI image layer). Default false. */
  directories?: boolean;
}

/** Pack a FileSet into a gzip-compressed tar archive in memory, its entries
 * as {@link writeTar} writes them. */
export function packToTarball(files: FileSet, options: PackOptions = {}): Computable<Buffer> {
  return Computable.from<Buffer>((resolve, reject) => {
    const pack = new TarPack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on("data", chunk => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.on("error", reject);
    pack.pipe(gzip);
    writeEntries(pack, entriesOf(files, options), err => {
      pack.destroy(err);
      gzip.destroy(err);
      reject(err);
    });
  });
}

/**
 * Write a FileSet as an uncompressed tar archive into `output`.
 *
 * Entries are written in sorted name order, a directory before those within
 * it, each with a fixed mtime, owner and group 0, and its file's stored mode,
 * so identical files make identical bytes. Names are written as the FileSet
 * has them: a layout such as npm's `package/` prefix is the caller's to apply
 * first. Each file's content is opened only when the archive reaches it.
 *
 * @return the archive, stored as the file `name`. Rejects with the first
 *   error reading a file or writing the output, the output then discarded.
 */
export function writeTar(files: FileSet, output: IOutputHandle, name: string, options: PackOptions = {}): Computable<IFile> {
  return Computable.from<void>((resolve, reject) => {
    const pack = new TarPack();
    pack.on("error", reject);
    pack.on("end", () => resolve());
    /* A failed output stops the packing; the pack's error settles this. */
    output.stream.on("error", err => pack.destroy(err));
    pack.pipe(output.stream, { end: false });
    writeEntries(pack, entriesOf(files, options), err => pack.destroy(err));
  }).then(
    () => output.finalize(name),
    (err: Error) =>
      output.discard().then(() => {
        throw err;
      })
  );
}

/**
 * Make a stream of `files` as an uncompressed tar archive, its entries as
 * {@link writeTar} writes them, each file's content opened only when the
 * archive reaches it. The stream fails with the first error reading a file.
 */
export function tarStream(files: FileSet, options: PackOptions = {}): Readable {
  const pack = new TarPack();
  writeEntries(pack, entriesOf(files, options), err => pack.destroy(err));
  return pack;
}

/** @return the entries of the archive of `files`, in the order written. */
function entriesOf(files: FileSet, options: PackOptions): PackEntry[] {
  const hardlinks = options.hardlinks ?? true;
  const ordered = archiveEntryNames(
    [...files].map(([name]) => name),
    { directories: options.directories ?? false }
  );
  /* The first entry of each content hash, which a later file of that hash
   * links to. Symlinks are never linked. */
  const firstByHash = new Map<string, string>();
  return ordered.map((name): PackEntry => {
    if (name.endsWith("/")) {
      return { kind: "directory", name };
    }
    const file = files.getFile(name)!;
    if (file instanceof SymlinkFile) {
      return { kind: "symlink", name, linkname: file.target };
    }
    if (hardlinks) {
      const linkname = firstByHash.get(file.hash);
      if (linkname !== undefined) {
        return { kind: "hardlink", name, linkname };
      }
      firstByHash.set(file.hash, name);
    }
    return { kind: "file", name, file };
  });
}

/** Write `entries` into `pack` one at a time and finalize it, or call `fail` with the first error. */
function writeEntries(pack: TarPack, entries: readonly PackEntry[], fail: (err: Error) => void): void {
  let index = 0;
  const next = (err?: Error | null): void => {
    if (err) {
      fail(err);
    } else if (index >= entries.length) {
      pack.finalize();
    } else {
      writeEntry(pack, entries[index++], next);
    }
  };
  next();
}

function writeEntry(pack: TarPack, entry: PackEntry, done: (err?: Error | null) => void): void {
  const header = { name: entry.name, mtime: FIXED_MTIME, uid: 0, gid: 0 };
  if (entry.kind === "directory") {
    pack.entry({ ...header, type: "directory", mode: DIRECTORY_MODE }, done);
  } else if (entry.kind === "symlink") {
    /* A symlink carries no body; its target rides in `linkname`. */
    pack.entry({ ...header, type: "symlink", linkname: entry.linkname, mode: 0o777 }, done);
  } else if (entry.kind === "hardlink") {
    /* A hardlink carries no body; `linkname` names the earlier entry it shares
     * content with. */
    pack.entry({ ...header, type: "link", linkname: entry.linkname, mode: 0o644 }, done);
  } else {
    /* The file's stored mode, never the pooled blob's permission bits. */
    contentOf(entry.file).then(
      ({ size, stream }) => {
        const sink = pack.entry({ ...header, size, mode: entry.file.mode & 0o7777 }, done);
        /* Either side's failure closes the other; the entry's callback reports it. */
        pipeline(stream, sink, () => undefined);
      },
      (err: Error) => done(err)
    );
  }
}

/** @return `file`'s size and a stream of its content: read from the pool where it is there, else from memory. */
function contentOf(file: IFile): Computable<{ size: number; stream: Readable }> {
  const where = file.getAbsPath();
  return where !== undefined
    ? stat(where).then(stats => ({ size: stats.size, stream: fs.createReadStream(where) }))
    : file.getBuffer().then(buffer => ({ size: buffer.length, stream: Readable.from([buffer]) }));
}
