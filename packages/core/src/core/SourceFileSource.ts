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

import * as path from "path";
import { Computable, ComputableSource } from "./Computable";
import { hashString, isDirectoryError, isNotFound, readFileBuffer, stat } from "./FSWrapper";
import { BuildCache } from "./BuildCache";
import { FSFile, FSFileSource, staticPath } from "./FSFileSource";
import { FileSet, IFile } from "./FileSet";
import { Name } from "./Name";
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

  /** Lexical containment: the source tree is this source's whole namespace, so a
   * name escaping the root — a `..` climb or an out-of-tree absolute — is refused.
   * The boundary is the *name*; symlinked content inside the tree reads as usual. */
  private contains(name: string): boolean {
    const rel = path.relative(this.root, path.resolve(this.root, name));
    return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
  }

  public override get(name: string): ComputableSource<IFile | undefined> {
    if (!this.contains(name)) {
      return Computable.reject(new Error(`'${name}' is outside the source tree`));
    }
    return super.get(name);
  }

  public override find(name: Name, prefix = ""): ComputableSource<FileSet> {
    /* Judge containment on the name's PATH interpretation (its static leading
     * path, `:` read as a path separator — where the walk actually lands), not
     * its written form: a `<k=v>`/`-> tmpl` facet is not path structure and
     * must not trip the check, and an alias prefix hiding a `..` climb must
     * not slip past it. The glob remainder never moves the walk base, so it
     * plays no part. */
    if (!this.contains(staticPath(name))) {
      return Computable.reject(new Error(`'${name.toString()}' is outside the source tree`));
    }
    return super.find(name, prefix);
  }

  /**
   * Read the file once, hash those exact bytes, and ingest them into the blob
   * store; return an FSFile whose content is read from the immutable blob.
   */
  public override ingest(filename: string): Computable<FSFile | undefined> {
    const filepath = path.resolve(this.root, filename);
    return readFileBuffer(filepath)
      .then(bytes =>
        stat(filepath).then(fileStat => {
          const hash = hashString(bytes);
          return this.cache
            .ensureBlob(hash, bytes, fileStat.mode)
            .then(blobPath => new FSFile(this.root, filename, { size: fileStat.size, mtime: fileStat.mtime, mode: fileStat.mode }, hash, blobPath));
        })
      )
      .catch(err => {
        /* Gone since the event fired, or the path is a directory (a watch event
         * on a directory the tree gained — e.g. a served tool's own cache/output
         * dirs): either way it is not a file, so treat it as absent, not an error
         * (and never a sync throw into the watcher callback, as the old statSync
         * could be). Mirrors the base FSFileSource.ingest. */
        if (isNotFound(err) || isDirectoryError(err)) {
          return undefined;
        }
        throw err;
      });
  }
}

export function getSourceFileSource(root: string, cache: BuildCache, watchController?: WatchController): SourceFileSource {
  return new SourceFileSource(root, cache, watchController);
}
