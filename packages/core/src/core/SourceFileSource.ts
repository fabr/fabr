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
import { hashString, readFileBuffer } from "./FSWrapper";
import { BuildCache } from "./BuildCache";
import { FSFile, FSFileSource, FSFileStats } from "./FSFileSource";
import { WatchController } from "./WatchController";

/**
 * FileSource for the local (mutable) source tree. Every source file it hands
 * back is **snapshotted** into the content-addressed blob store at the moment
 * it is hashed: the single read that computes the hash also supplies the bytes,
 * so the hash and the compiled content can never diverge (the manifest key
 * always names exactly what a build step stages). The returned FSFile is
 * blob-backed — its content path is the immutable snapshot — while its
 * name/root still identify the source for diagnostics.
 *
 * TODO: Locking
 */
export class SourceFileSource extends FSFileSource {
  private readonly cache: BuildCache;

  constructor(sourceRoot: string, cache: BuildCache, watchController?: WatchController) {
    super(sourceRoot, watchController);
    this.cache = cache;
  }

  /**
   * Read the file once, hash those exact bytes, and ingest them into the blob
   * store; return an FSFile whose content is read from the immutable blob.
   */
  fileAdded(filename: string, stat?: FSFileStats): Computable<FSFile> {
    const filepath = path.resolve(this.root, filename);
    const fileStat = stat ?? fs.statSync(filepath);
    return readFileBuffer(filepath).then(bytes => {
      const hash = hashString(bytes);
      return this.cache
        .ensureBlob(hash, bytes)
        .then(blobPath => new FSFile(this.root, filename, { size: fileStat.size, mtime: fileStat.mtime }, hash, blobPath));
    });
  }
}

export function getSourceFileSource(root: string, cache: BuildCache, watchController?: WatchController): SourceFileSource {
  return new SourceFileSource(root, cache, watchController);
}
