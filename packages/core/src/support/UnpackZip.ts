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
 * Zip archives, read by random access with `yauzl`. A zip records each entry's
 * mode, and whether it is a symlink, only in its central directory at the end,
 * so an archive is read only once it is whole: one that arrives as a stream is
 * first written out in full.
 */

import * as fs from "fs";
import * as path from "path";
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
import { contentFailure, isNotFound } from "../core/FSWrapper";

/** The count of archives written out to a scratch dir by this process, which names each. */
let spooled = 0;
/* Version-made-by host: unix, whose external attributes carry the file mode. */
const ZIP_HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const ZIP_OPTIONS = { lazyEntries: true, autoClose: true, validateEntrySizes: true };

function zipError(err: unknown, entry?: yauzl.Entry): Error {
  return new FabrError(
    `${entry === undefined ? "ZIP archive" : `ZIP entry '${entry.fileName}'`} cannot be read: ${toError(err).message}`
  );
}

/** Make yauzl's open callback settle `resolve`/`reject`, a missing file
 *  reported as `archive`'s content failure where the archive is a stored file. */
function zipOpened(
  resolve: (zip: yauzl.ZipFile) => void,
  reject: (err: Error) => void,
  archive?: IFile
): (err: Error | null, zip: yauzl.ZipFile) => void {
  return (err, zip) =>
    err ? reject(archive !== undefined && isNotFound(err) ? contentFailure(archive, err) : zipError(err)) : resolve(zip);
}

/** Open the zip archive at the host path `file`. */
function openZipAt(file: string, archive?: IFile): Computable<yauzl.ZipFile> {
  return Computable.from<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, ZIP_OPTIONS, zipOpened(resolve, reject, archive)));
}

/** Open a zip archive held in memory. */
function openZipBuffer(buffer: Buffer): Computable<yauzl.ZipFile> {
  return Computable.from<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, ZIP_OPTIONS, zipOpened(resolve, reject)));
}

/** Open a zip archive: by path where it is on disk, else from memory. */
function openZip(archive: IFile): Computable<yauzl.ZipFile> {
  const file = archive.getAbsPath();
  return file !== undefined ? openZipAt(file, archive) : archive.getBuffer().then(openZipBuffer);
}

/**
 * Read each entry of `zip` that `select` admits (by its normalized name), one
 * at a time, with `read`. Directories, and entries whose names escape the tree,
 * are passed over unread; keep that check, since the archive is untrusted.
 * Rejects where an admitted entry is encrypted, or the archive or an entry
 * cannot be read.
 */
function readEntries<T>(
  zip: yauzl.ZipFile,
  select: (name: string) => boolean,
  read: (entry: yauzl.Entry, name: string, stream: Readable) => Computable<T>
): Computable<T[]> {
  return Computable.from<T[]>((resolve, reject) => {
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

/** Write one entry to an output of its own, with its recorded mode (0o644
 *  where none), or make a symlink entry the {@link SymlinkFile} its content
 *  names. Rejects where the content does not match its CRC-32. */
function writeEntry(
  entry: yauzl.Entry,
  name: string,
  stream: Readable,
  createOutput: () => IOutputHandle
): Computable<[string, IFile]> {
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
  return Computable.from<[string, IFile]>((resolve, reject) => {
    let crc = 0;
    /* Stop reading the entry, and discard the output before rejecting. */
    const fail = (err: Error): void => {
      stream.destroy();
      output.discard().then(() => reject(err));
    };
    stream.on("data", (data: Buffer) => {
      crc = crc32(data, crc);
    });
    stream.on("error", err => fail(zipError(err, entry)));
    output.stream.on("error", fail);
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
  return openZip(archive).then(zip => unzipOpened(zip, createOutput));
}

function unzipOpened(zip: yauzl.ZipFile, createOutput: () => IOutputHandle): Computable<FileSet> {
  return readEntries(
    zip,
    () => true,
    (entry, name, stream) => writeEntry(entry, name, stream, createOutput)
  ).then(files => new FileSet(new Map(files)));
}

/**
 * Read a zip archive arriving as a stream: written out whole, to a temporary
 * file in `scratchDir` or, without one, to memory, then unzipped from there
 * (see {@link unzipFile}). The archive itself is never stored; the file is
 * left for whoever owns `scratchDir` to remove.
 * @return the sink to stream the archive into, and the files it holds.
 */
export function extractZip(createOutput: () => IOutputHandle, scratchDir?: string): { sink: Writable; result: Computable<FileSet> } {
  const { sink, archive } = scratchDir === undefined ? spoolToMemory() : spoolToFile(scratchDir);
  return { sink, result: archive.then(zip => unzipOpened(zip, createOutput)) };
}

/** Write an archive out to a new file in `scratchDir`, opened once it is whole. */
function spoolToFile(scratchDir: string): { sink: Writable; archive: Computable<yauzl.ZipFile> } {
  const file = path.join(scratchDir, `archive-${++spooled}.zip`);
  /* A failure to open the file is the sink's error. */
  const sink = fs.createWriteStream(file, { flags: "wx" });
  const archive = Computable.from<yauzl.ZipFile>((resolve, reject) => {
    let whole = false;
    sink.once("finish", () => {
      whole = true;
    });
    sink.once("error", err => reject(toError(err)));
    /* Open only once the file is closed; a sink destroyed before its end has no archive to open. */
    sink.once("close", () =>
      whole ? resolve(openZipAt(file)) : reject(new FabrError("ZIP archive ended before it was written out whole"))
    );
  });
  return { sink, archive };
}

/** Collect an archive in memory, opened once it is whole. */
function spoolToMemory(): { sink: Writable; archive: Computable<yauzl.ZipFile> } {
  const chunks: Buffer[] = [];
  let settle!: { resolve: (zip: Computable<yauzl.ZipFile>) => void; reject: (err: Error) => void };
  const archive = Computable.from<yauzl.ZipFile>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
      chunks.push(chunk);
      done();
    },
    final(done: () => void): void {
      settle.resolve(openZipBuffer(Buffer.concat(chunks)));
      done();
    },
  });
  /* A failure of the stream feeding it (a dropped connection) destroys the sink. */
  sink.once("error", err => settle.reject(toError(err)));
  sink.once("close", () => settle.reject(new FabrError("ZIP archive ended before it was whole")));
  return { sink, archive };
}

/**
 * Read the members of a zip archive held in memory that `select` accepts, by
 * name, passing over the rest unread.
 */
export function readZipMembers(zip: Buffer, select: (name: string) => boolean): Computable<Map<string, Buffer>> {
  return openZip(new MemoryFile(zip))
    .then(opened =>
      readEntries(opened, select, (entry, entryName, stream) => writeEntry(entry, entryName, stream, () => new MemoryOutput()))
    )
    .then(members =>
      Computable.forAll(
        members.map(([name, output]) => output.getBuffer().then((buffer): [string, Buffer] => [name, buffer])),
        (...read: Array<[string, Buffer]>) => new Map(read)
      )
    );
}

/**
 * Read one member of a zip archive held in memory (a jar's
 * `META-INF/MANIFEST.MF`), passing over the rest unread.
 * @return the member's content, or undefined where the archive has none of that name.
 */
export function readZipMember(zip: Buffer, name: string): Computable<Buffer | undefined> {
  return readZipMembers(zip, entry => entry === name).then(members => members.get(name));
}
