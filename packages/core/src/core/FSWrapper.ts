/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

/* Computable<> versions of common fs functions */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Readable } from "stream";
import { Computable } from "./Computable";
import type { IFile } from "./FileSet";
import { mapComputable } from "../support/Functional";
import { SNIFF_LENGTH, sniffMime } from "../support/Mime";

export const HASH_ALGORITHM = "sha256";

export function stat(filename: string): Computable<fs.Stats> {
  return Computable.from((resolve, reject) => {
    fs.stat(filename, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        resolve(stats);
      }
    });
  });
}

/** @return true if `err` is an ENOENT (the path is not there: it vanished, or
 * never existed), otherwise false. */
export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** @return true if `err` is an EISDIR (the path is a directory where a file
 * operation expected a regular file), otherwise false. */
export function isDirectoryError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EISDIR";
}

/** @return true if `err` is an ENOTDIR (a path component that must be a
 * directory is a file, so nothing below it can be read), otherwise false. */
export function isNotDirectoryError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOTDIR";
}

export function readFile(filepath: string, encoding: BufferEncoding = "utf8"): Computable<string> {
  return Computable.from<string>((resolve, reject) => {
    fs.readFile(filepath, encoding, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

export function readFileBuffer(filepath: string): Computable<Buffer> {
  return Computable.from<Buffer>((resolve, reject) => {
    fs.readFile(filepath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/** Write a file. With `exclusive` (the `wx` flag), the write fails with EEXIST
 * where the file exists, so two staged names that collide only in case on a
 * case-insensitive filesystem fail instead of one replacing the other. */
export function writeFile(filepath: string, data: string | Buffer, opts?: { exclusive?: boolean; mode?: number }): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.writeFile(
      filepath,
      data,
      { flag: opts?.exclusive ? "wx" : "w", ...(opts?.mode === undefined ? {} : { mode: opts.mode }) },
      err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

/**
 * Write `content` at `target` atomically: to `tempPath`, then renamed into
 * place, replacing any existing file, so a crash mid-write leaves no truncated
 * file. Creates `target`'s directory as needed. `tempPath` must be on
 * `target`'s filesystem. On failure `tempPath` is removed and the error
 * rethrown.
 */
export function writeFileAtomic(target: string, content: string, tempPath: string): Computable<void> {
  return mkdir(path.dirname(target))
    .then(() => writeFile(tempPath, content))
    .then(() => rename(tempPath, target))
    .catch(err => {
      deleteFile(tempPath).catch(() => undefined);
      throw err;
    });
}

export function deleteFile(filepath: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.unlink(filepath, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Set `filepath`'s access and modification times, both to `time`. */
export function updateFileTime(filepath: string, time: Date): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.utimes(filepath, time, time, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Remove `filepath` and everything under it; absence is success. */
export function deleteTree(filepath: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.rm(filepath, { recursive: true, force: true }, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function rename(from: string, to: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.rename(from, to, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function readdir(dirpath: string): Computable<fs.Dirent[]> {
  return Computable.from<fs.Dirent[]>((resolve, reject) => {
    fs.readdir(dirpath, { withFileTypes: true }, (err, entries) => {
      if (err) {
        reject(err);
      } else {
        resolve(entries);
      }
    });
  });
}

/**
 * Recursively walk `dir`, calling `onEntry` with every entry (its Dirent and
 * absolute path) and descending into real subdirectories. Symlinks are NOT
 * followed: `withFileTypes` classifies by lstat, so a symlinked directory is a
 * symlink (not a directory) and is never recursed into — the walk visits each
 * path once and cannot cycle, even through a tree that links to itself.
 * `skipDir` can veto descent into a directory (the directory entry is still
 * reported to `onEntry` first). An unreadable directory contributes nothing.
 */
export function walkTree(
  dir: string,
  onEntry: (entry: fs.Dirent, abspath: string) => void,
  skipDir: (entry: fs.Dirent, abspath: string) => boolean = () => false
): Computable<void> {
  return readdir(dir).then(
    entries =>
      mapComputable(entries, entry => {
        const abs = path.join(dir, entry.name);
        onEntry(entry, abs);
        return entry.isDirectory() && !skipDir(entry, abs) ? walkTree(abs, onEntry, skipDir) : undefined;
      }).then(() => undefined),
    /* An unreadable directory contributes nothing. */
    () => undefined
  );
}

/**
 * Create a directory and any missing parents (`mkdir -p`), succeeding if it
 * already exists. Use it rather than `mkdirSync` where many are made (staging
 * a tree): a synchronous one blocks the event loop, and with it every other
 * step of the build.
 */
export function mkdir(dirpath: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.mkdir(dirpath, { recursive: true }, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function symlink(target: string, filepath: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.symlink(target, filepath, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Resolve `filepath` to its concrete path, every symlink followed. */
export function realpath(filepath: string): Computable<string> {
  return Computable.from<string>((resolve, reject) => {
    fs.realpath(filepath, (err, resolved) => {
      if (err) {
        reject(err);
      } else {
        resolve(resolved);
      }
    });
  });
}

/** Get the read-only permission bits for a content-addressed file: 0o444, or
 * 0o555 where `mode` is executable; never writable, never setuid. Cache blobs
 * and files staged beside them use these, so a launched tool cannot write
 * into a shared blob. The file's own mode is kept in IFile.mode (and the cache
 * manifest) and applied on export (`fabr cp`, packing a tar). */
export function readOnlyPermissions(mode: number): number {
  return mode & 0o111 ? 0o555 : 0o444;
}

export function hardlink(target: string, filepath: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.link(target, filepath, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Copy a file's contents to a new path, an independent copy where
 * {@link hardlink} shares the inode. Use it for a destination the user owns
 * (`fabr cp`), where an edit through a hardlink would change the cache blob. */
export function copyFile(target: string, filepath: string): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.copyFile(target, filepath, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
/** A file's content hash and its mime (see IFile.mime), sniffed from the same
 * read. */
export interface HashedContent {
  readonly hash: string;
  readonly mime: string;
}

export function hashFile(filepath: string): Computable<HashedContent> {
  return Computable.from<HashedContent>((resolve, reject) => {
    fs.readFile(filepath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve({ hash: hashString(data), mime: sniffMime(data) });
      }
    });
  });
}

/** Hash the file at `filepath` as it streams, holding none of it beyond the
 *  leading bytes its mime is sniffed from — for a file too large to read whole
 *  (a host program). */
export function hashFileStreamed(filepath: string): Computable<HashedContent> {
  return Computable.from<HashedContent>((resolve, reject) => {
    const hash = crypto.createHash(HASH_ALGORITHM);
    let head = Buffer.alloc(0);
    fs.createReadStream(filepath)
      .on("data", (data: string | Buffer) => {
        const chunk = typeof data === "string" ? Buffer.from(data) : data;
        if (head.length < SNIFF_LENGTH) {
          head = Buffer.concat([head, chunk.subarray(0, SNIFF_LENGTH - head.length)]);
        }
        hash.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve({ hash: hash.digest("hex"), mime: sniffMime(head) }));
  });
}

export function hashString(data: string | Buffer): string {
  return crypto.createHash(HASH_ALGORITHM).update(data).digest("hex");
}

/** @return a stream of `file`'s content: read from disk where the file has a path, else from memory. */
export function contentStream(file: IFile): Computable<Readable> {
  const where = file.getAbsPath();
  return where !== undefined
    ? Computable.resolve(fs.createReadStream(where))
    : file.getBuffer().then(buffer => Readable.from([buffer]));
}

/** @return the size of `file`'s content in bytes: from disk where the file has a path, else from memory. */
export function contentSize(file: IFile): Computable<number> {
  const where = file.getAbsPath();
  return where !== undefined ? stat(where).then(stats => stats.size) : file.getBuffer().then(buffer => buffer.length);
}
