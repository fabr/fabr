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
