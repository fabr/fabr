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

/**
 * Zip archives, read by random access with `yauzl`: a zip records each
 * entry's mode, and whether it is a symlink, only in its central directory at
 * the end, so an archive is read once it is whole, from the file holding it.
 * An archive that arrives as a stream is first written out in full.
 */

import { Readable, Writable } from "stream";
import { crc32 } from "zlib";
import * as yauzl from "yauzl";
import type { IOutputHandle } from "./Execute";
import { Computable } from "../core/Computable";
import { FabrError, toError } from "../core/Errors";
import { readStream } from "../core/Fetch";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile, MemoryOutput } from "../core/MemoryFS";
import { SymlinkFile } from "../core/SymlinkFile";
import { normalizeEntryName } from "./Paths";

/** The name an archive arriving as a stream is written out under. */
const SPOOL_NAME = "archive.zip";
/* Version-made-by host: unix, whose external attributes carry the file mode. */
const ZIP_HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const ZIP_OPTIONS = { lazyEntries: true, autoClose: true, validateEntrySizes: true };

function zipError(err: unknown, entry?: yauzl.Entry): Error {
  return new FabrError(`${entry === undefined ? "ZIP archive" : `ZIP entry '${entry.fileName}'`} cannot be read: ${toError(err).message}`);
}

/** Open a zip archive: by path where it is on disk, else from memory. */
function openZip(archive: IFile): Computable<yauzl.ZipFile> {
  const opened = (resolve: (zip: yauzl.ZipFile) => void, reject: (err: Error) => void) => (err: Error | null, zip: yauzl.ZipFile) =>
    err ? reject(zipError(err)) : resolve(zip);
  const path = archive.getAbsPath();
  if (path !== undefined) {
    return Computable.fromOnce<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, ZIP_OPTIONS, opened(resolve, reject)));
  }
  return archive.getBuffer().then(buffer => Computable.fromOnce<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, ZIP_OPTIONS, opened(resolve, reject))));
}

/**
 * Read each entry of `zip` that `select` admits (by its normalized name), one
 * at a time, with `read`. Directories are passed over; an entry named outside
 * the tree, or encrypted, refuses the archive.
 */
function readEntries<T>(
  zip: yauzl.ZipFile,
  select: (name: string) => boolean,
  read: (entry: yauzl.Entry, name: string, stream: Readable) => Computable<T>
): Computable<T[]> {
  return Computable.fromOnce<T[]>((resolve, reject) => {
    const results: Computable<T>[] = [];
    const fail = (err: Error): void => {
      zip.close();
      reject(err);
    };
    zip.on("error", err => fail(zipError(err)));
    zip.on("end", () => resolve(Computable.forAll(results, (...values: T[]) => values)));
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName.endsWith("/") ? undefined : normalizeEntryName(entry.fileName);
      if (name === undefined || !select(name)) {
        zip.readEntry();
        return;
      }
      if (entry.isEncrypted()) {
        fail(new FabrError(`ZIP entry '${entry.fileName}' is encrypted, which fabr cannot read`));
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err) {
          fail(zipError(err, entry));
          return;
        }
        const result = read(entry, name, stream);
        results.push(result);
        result.then(() => zip.readEntry(), fail);
      });
    });
    zip.readEntry();
  });
}

/** @return the Unix mode an entry's central directory records, or 0 where it records none. */
function unixModeOf(entry: yauzl.Entry): number {
  return entry.versionMadeBy >> 8 === ZIP_HOST_UNIX ? entry.externalFileAttributes >>> 16 : 0;
}

function corrupt(entry: yauzl.Entry): Error {
  return new FabrError(`ZIP entry '${entry.fileName}' is corrupt: its content does not match its CRC-32`);
}

/** Write one entry to an output of its own, checked against its CRC-32: a
 *  symlink as the {@link SymlinkFile} its content names. */
function writeEntry(entry: yauzl.Entry, name: string, stream: Readable, createOutput: () => IOutputHandle): Computable<[string, IFile]> {
  const mode = unixModeOf(entry);
  if ((mode & S_IFMT) === S_IFLNK) {
    return readStream(stream).then(target => {
      if (crc32(target) !== entry.crc32) {
        throw corrupt(entry);
      }
      return [name, new SymlinkFile(target.toString("utf8"))];
    });
  }
  const output = createOutput();
  return Computable.fromOnce<[string, IFile]>((resolve, reject) => {
    let crc = 0;
    /* Reported once the output is gone, so nothing of the entry is left behind. */
    const fail = (err: Error): void => {
      output.discard().then(() => reject(err));
    };
    stream.on("data", (data: Buffer) => {
      crc = crc32(data, crc);
    });
    stream.on("error", err => fail(zipError(err, entry)));
    stream.on("end", () => {
      if (crc !== entry.crc32) {
        fail(corrupt(entry));
      } else {
        output.finalize(name, mode & 0o7777 || 0o644).then(file => resolve([name, file]), fail);
      }
    });
    stream.pipe(output.stream, { end: false });
  });
}

/**
 * Unzip an archive in hand: each file written to an output of its own, with
 * the mode its central directory records, a symlink as a {@link SymlinkFile}.
 */
export function unzipFile(archive: IFile, createOutput: () => IOutputHandle): Computable<FileSet> {
  return openZip(archive)
    .then(zip => readEntries(zip, () => true, (entry, name, stream) => writeEntry(entry, name, stream, createOutput)))
    .then(files => new FileSet(new Map(files)));
}

/**
 * Read a zip archive arriving as a stream: written out whole to one output,
 * then unzipped from it (see {@link unzipFile}).
 * @return the sink to stream the archive into, and the files it holds.
 */
export function extractZip(createOutput: () => IOutputHandle): { sink: Writable; result: Computable<FileSet> } {
  const spool = createOutput();
  let settle!: { resolve: (files: Computable<FileSet>) => void; reject: (err: Error) => void };
  const result = Computable.fromOnce<FileSet>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
      if (spool.stream.write(chunk)) {
        done();
      } else {
        spool.stream.once("drain", () => done());
      }
    },
    final(done: () => void): void {
      settle.resolve(spool.finalize(SPOOL_NAME).then(archive => unzipFile(archive, createOutput)));
      done();
    },
  });
  /* A failure of the stream feeding it (a dropped connection) destroys the sink. */
  sink.on("error", err => {
    spool.discard().then(() => settle.reject(err));
  });
  return { sink, result };
}

/**
 * Read the members of a zip archive held in memory that `select` accepts, by
 * name, passing over the rest unread.
 */
export function readZipMembers(zip: Buffer, select: (name: string) => boolean): Computable<Map<string, Buffer>> {
  return openZip(new MemoryFile(zip))
    .then(opened => readEntries(opened, select, (entry, entryName, stream) => writeEntry(entry, entryName, stream, () => new MemoryOutput())))
    .then(members =>
      Computable.forAll(
        members.map(([name, output]) => output.getBuffer().then((buffer): [string, Buffer] => [name, buffer])),
        (...read: Array<[string, Buffer]>) => new Map(read)
      )
    );
}

/**
 * Read one member of a zip archive held in memory (a jar's
 * `META-INF/MANIFEST.MF`), passing over the rest unread: undefined where it
 * has no such member.
 */
export function readZipMember(zip: Buffer, name: string): Computable<Buffer | undefined> {
  return readZipMembers(zip, entry => entry === name).then(members => members.get(name));
}
