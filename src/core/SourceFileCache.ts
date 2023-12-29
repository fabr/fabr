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

import * as fs from "fs";
import * as path from "path";
import { Computable } from "./Computable";

export interface ISourceFileCacheEntry {
  size: number;
  mtime: number;
  hash: string;
}

/**
 * Maintains a cache of file size timestamp + hash - this primarily exists to avoid
 * having to rehash files if the timestamp hasn't changed.
 */
class SourceFileCache {
  private sourceRoot: string;

  private cache: Map<string, ISourceFileCacheEntry>;

  constructor(sourceRoot: string) {
    this.sourceRoot = sourceRoot;
    this.cache = new Map();
  }

  public load(filename: string) : void {

  }

  public save(filename: string) : void {
    
  }

  /**
   * @return the hash of the given file + timestamp. If the file can't be read,
   * throws an Error.
   * @param filename
   * @param stat
   */
  getHash(filename: string, stat?: fs.Stats): Computable<ISourceFileCacheEntry> {
    const fileStat = stat ?? fs.statSync(path.resolve(this.sourceRoot, filename));
    const entry = this.cache.get(filename);
    if (entry && entry.mtime === fileStat.mtime.getTime() && entry.size === fileStat.size) {
      return entry;
    } else {
    }
  }
}
