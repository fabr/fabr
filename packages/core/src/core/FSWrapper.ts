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

export function writeFile(filepath: string, data: string | Buffer): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    fs.writeFile(filepath, data, err => {
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
export function hashFile(filepath: string): Computable<string> {
  return Computable.from<string>((resolve, reject) => {
    fs.readFile(filepath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(hashString(data));
      }
    });
  });
}

export function hashString(data: string | Buffer): string {
  return crypto.createHash(HASH_ALGORITHM).update(data).digest("hex");
}
