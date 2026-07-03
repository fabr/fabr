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
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Computable } from "./Computable";
import { hashFile } from "./FSWrapper";
import { FSFile, FSFileSource } from "./FSFileSource";

export interface ISourceFileCacheEntry {
  size: number;
  mtime: number;
  hash: string;
}

/**
 * FileSource for the local source tree. In addition to wrapping the basic filesystem
 * handling (and keeping the results within the tree), it also caches source file hashes
 * so that we don't have to keep recomputing them.
 *
 * TODO: Locking
 */
export class SourceFileSource extends FSFileSource {
  private cacheFile: string;
  private cache: Map<string, FSFile>;

  constructor(sourceRoot: string, cacheFile: string) {
    super(sourceRoot);
    this.cache = new Map();
    this.cacheFile = path.resolve(sourceRoot, cacheFile);
  }

  public async load(): Promise<void> {
    if (fs.existsSync(this.cacheFile)) {
      const data = await fsPromises.readFile(this.cacheFile);
      const result = new Map<string, FSFile>();
      data
        .toString()
        .split("\n")
        .forEach(line => {
          const [hash, mtime, size, ...name] = line.split(" ");
          if (name.length > 0) {
            const filename = name.join(" ");
            result.set(
              filename,
              new FSFile(this.root, filename, { mtime: new Date(parseInt(mtime, 10)), size: parseInt(size, 10) }, hash)
            );
          }
        });
      this.cache = result;
    }
  }

  public async save(): Promise<void> {
    let content = "";
    this.cache.forEach((entry, name) => {
      content += `${entry.hash} ${entry.stat.mtime.getTime()} ${entry.stat.size} ${name}\n`;
    });
    await fsPromises.writeFile(this.cacheFile, content);
  }

  /**
   * @return the hash of the given file + timestamp. If the file can't be read,
   * throws an Error.
   * @param filename
   * @param stat
   */
  fileAdded(filename: string, stat?: fs.Stats): Computable<FSFile> {
    const filepath = path.resolve(this.root, filename);
    const fileStat = stat ?? fs.statSync(filepath);
    const entry = this.cache.get(filename);
    if (entry && entry.stat.mtime.getTime() === fileStat.mtime.getTime() && entry.stat.size === fileStat.size) {
      return Computable.resolve(entry);
    } else {
      return hashFile(filepath).then(hash => {
        const result = new FSFile(this.root, filename, { size: fileStat.size, mtime: fileStat.mtime }, hash);
        this.cache.set(filename, result);
        return result;
      });
    }
  }
}

export async function getSourceFileSource(root: string, cacheFilename: string): Promise<SourceFileSource> {
  const source = new SourceFileSource(root, cacheFilename);
  await source.load();
  return source;
}
