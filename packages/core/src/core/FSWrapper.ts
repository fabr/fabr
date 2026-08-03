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
import { Computable } from "./Computable";
import { sniffMime } from "../support/Mime";

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

/** Whether an fs error means the path simply isn't there (vanished, or never
 * existed) rather than a genuine IO failure — so a caller can treat a file that
 * disappeared mid-event as absent instead of erroring. */
export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** True if `err` is an EISDIR — the path is a directory where a file operation
 * (open/read) expected a regular file. */
export function isDirectoryError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EISDIR";
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

/** Write a file. With `exclusive`, the write fails (EEXIST) rather than
 * overwriting an existing file — the `wx` flag — so a caller can let the
 * filesystem reject a clobber (e.g. two staged names that collide only in case
 * on a case-insensitive filesystem) instead of silently losing one. */
export function writeFile(filepath: string, data: string | Buffer, opts?: { exclusive?: boolean }): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.writeFile(filepath, data, { flag: opts?.exclusive ? "wx" : "w" }, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
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
      Computable.forAll(
        entries.map(entry => {
          const abs = path.join(dir, entry.name);
          onEntry(entry, abs);
          return entry.isDirectory() && !skipDir(entry, abs) ? walkTree(abs, onEntry, skipDir) : Computable.resolve<void>(undefined);
        }),
        () => undefined
      ),
    /* An unreadable directory contributes nothing. */
    () => undefined
  );
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

/** The read-only permission bits for a content-addressed file: 0o444, or 0o555
 * when `mode` is executable. Cache blobs and any file staged to mirror one (a
 * hardlink into the pool, or an in-memory file materialized alongside them) use
 * this — read-only so a launched tool can't write through into a shared blob,
 * executable-if-executable so a staged tool still runs. Never writable, never
 * setuid. The file's *real* mode is preserved separately (IFile.mode / the cache
 * manifest) and reapplied on export to user space (`fabr cp`, tar pack). */
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

/** Copy a file's contents to a new path — an independent duplicate, unlike
 * {@link hardlink} which shares the inode. Used when the destination is durable
 * user-space (e.g. `fabr cp`), where a hardlink into the content-addressed cache
 * would let an edit of the copy write through to the shared cache blob. */
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
/** A file's content identity and classification, from one read: the hash, and
 * the mime sniffed from the same bytes (see IFile.mime — classification rides
 * every read the identity already requires, so it is never a read of its own). */
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

export function hashString(data: string | Buffer): string {
  return crypto.createHash(HASH_ALGORITHM).update(data).digest("hex");
}
