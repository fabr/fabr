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
import { Computable, ComputableSource } from "./Computable";
import { hashString } from "./FSWrapper";
import { BuildCache } from "./BuildCache";
import { staticPath } from "./FSFileSource";
import { FileSet, FileSource, IFile } from "./FileSet";
import { IndexedFileSource } from "./IndexedFileSource";
import { Name } from "./Name";
import { WatchController } from "./WatchController";
import { IResolvedWriteBack, IWriteBackObserver, treeNameOf, writeBackFile } from "./WriteBack";
import { mapComputable } from "../support/Functional";
import { FabrError } from "./Errors";
import { toPosix } from "../support/Paths";

/** The prefix that makes a project file's path from the root its source path. */
const SOURCE_PATH_PREFIX = "./";

/**
 * FileSource for the local (mutable) source tree: an {@link IndexedFileSource}
 * whose files are read as snapshots and whose whole tree is watched. Beside
 * reading, it names its files' source paths and writes back into the tree,
 * recognizing the watch events its own writes cause.
 *
 * TODO: Locking
 */
export class SourceFileSource extends IndexedFileSource {
  /**
   * The paths fabr wrote into the tree, name → content hash. A watch event for
   * one of them is fabr's own write, and is deferred rather than arming a
   * rebuild (see {@link applyWriteBack}). An entry stays while the file holds
   * those bytes, so a repeated or late event is recognized too; it is dropped
   * when a read finds different bytes ({@link confirmIngested}), or the path
   * is removed ({@link isExpectedChange}).
   *
   * `undefined` marks a path whose content is not checked: the temp file a
   * write renames from, a directory it created.
   */
  private readonly expected = new Map<string, string | undefined>();

  constructor(sourceRoot: string, cache: BuildCache, watchController?: WatchController) {
    super(sourceRoot, cache, { read: "snapshot", watch: "root" }, watchController);
  }

  public override get sourcePathPrefix(): string {
    return SOURCE_PATH_PREFIX;
  }

  /** Get where in the tree the file with source path `sourcePath` lives;
   *  undefined for a source path that names no file of the tree. */
  public locate(sourcePath: string): string | undefined {
    return sourcePath.startsWith(SOURCE_PATH_PREFIX) ? path.join(this.root, sourcePath.slice(SOURCE_PATH_PREFIX.length)) : undefined;
  }

  protected override isExpectedChange(rel: string, removed = false): boolean {
    if (!removed) {
      return this.expected.has(rel);
    }
    /* A write-back removes only its temp file, recorded with no hash. A
     * removal at or under a path recorded with a hash is someone else's change
     * (a record deleted, an `rm -rf __snapshots__`), and no read will check
     * it, so it is reported as a change here. Every entry at or under the path
     * is dropped, so a file made there again is judged afresh. Match the
     * subtree: the filesystem reports a directory's deletion as one event. */
    let sawOwn = false;
    let refuted = false;
    for (const [name, hash] of this.expected) {
      if (name === rel || name.startsWith(rel + "/")) {
        sawOwn = true;
        if (hash !== undefined) {
          refuted = true;
        }
        this.expected.delete(name);
      }
    }
    return sawOwn && !refuted;
  }

  /**
   * Write each of `writes` into the source tree (refreshed test expectations,
   * a coverage report), recording every path a write touches, so that the
   * watch events the writes cause are deferred rather than arming a rebuild
   * (see {@link isExpectedChange}). Resolves to the paths written. A
   * destination outside the tree, judged by real path, is not written, and
   * the result rejects. The caller chooses what to write and where.
   */
  public applyWriteBack(writes: ReadonlyArray<IResolvedWriteBack>): Computable<string[]> {
    /* `root` may be reached through a symlink (macOS /var -> /private/var);
     * judge containment against its real path. */
    const realRoot = fs.realpathSync(path.resolve(this.root));
    return mapComputable(writes, write => {
      const name = treeNameOf(write.destination, realRoot);
      if (name === undefined) {
        /* Check here whatever the caller checked: this is the last point
         * before the disk. */
        return Computable.reject(
          new FabrError(`Refusing to write '${write.destination}': it is outside the project directory '${realRoot}'`)
        );
      }
      return this.writeOne({ file: write.file, destination: path.resolve(this.root, name) }, realRoot);
    });
  }

  /**
   * Write `file` to `destination`, a path the user chose (a report): through
   * {@link applyWriteBack}'s echo recognition where it lies inside the tree, as a
   * plain write anywhere else.
   */
  public writeFile(destination: string, file: IFile): Computable<void> {
    const realRoot = fs.realpathSync(path.resolve(this.root));
    const name = treeNameOf(destination, realRoot);
    if (name !== undefined) {
      return this.writeOne({ file, destination: path.resolve(this.root, name) }, realRoot).then(() => undefined);
    }
    return file.getBuffer().then(buffer => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, buffer);
    });
  }

  private writeOne(write: IResolvedWriteBack, realRoot: string): Computable<string> {
    const observer: IWriteBackObserver = {
      content: (destination, buffer) => this.expect(destination, hashString(buffer)),
      touches: touched => this.expect(touched, undefined),
    };
    return writeBackFile(write, realRoot, observer);
  }

  /** Record that fabr wrote the path `absolute`, under its name in the tree,
   * which is how a watch event names it. */
  private expect(absolute: string, hash: string | undefined): void {
    const rel = toSourceName(this.root, absolute);
    if (rel !== undefined) {
      this.expected.set(rel, hash);
    }
  }

  /** @return true if `name` lies inside the root lexically (no `..` climb out,
   * no absolute path elsewhere), otherwise false. A symlink inside the tree is
   * not followed for this. */
  private contains(name: string): boolean {
    const rel = path.relative(this.root, path.resolve(this.root, name));
    return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
  }

  public override get(name: string): ComputableSource<IFile | undefined> {
    if (!this.contains(name)) {
      return Computable.reject(new FabrError(`'${name}' is outside the source tree`));
    }
    return super.get(name);
  }

  public override find(name: Name, prefix = ""): ComputableSource<FileSet> {
    /* Judge containment on the path the walk starts from (`staticPath`: the
     * name's static leading path, `:` read as a separator), not on the
     * written name: a `<k=v>` or `-> tmpl` facet is no path, and an alias
     * prefix may hide a `..`. The glob remainder never moves the walk's base. */
    if (!this.contains(staticPath(name))) {
      return Computable.reject(new FabrError(`'${name.toString()}' is outside the source tree`));
    }
    return super.find(name, prefix);
  }

  /**
   * Check a path fabr wrote against the hash a read found there. Different
   * bytes mean someone else edited the file: drop the entry and arm the watch
   * flush, since the change was recorded as dirty but deferred. Matching bytes
   * leave the entry in place.
   */
  protected override confirmIngested(filename: string, hash: string): void {
    const expected = this.expected.get(filename);
    /* A stored `undefined` is a path with no content to check (see
     * `expected`), not a mismatch. */
    if (this.expected.has(filename) && expected !== undefined && expected !== hash) {
      this.expected.delete(filename);
      this.watchController?.armFlush();
    }
  }
}

/** The source tree as a consumer sees it: readable like any {@link FileSource},
 *  and the one source fabr writes into. */
export type WritableSourceTree = FileSource & Pick<SourceFileSource, "root" | "locate" | "applyWriteBack" | "writeFile">;

/** Name `destination` as the source rooted at `root` does (relative to the
 * root, `/`-separated); undefined where it lies outside the tree. */
function toSourceName(root: string, destination: string): string | undefined {
  const rel = path.relative(root, destination);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) {
    return undefined;
  }
  return toPosix(rel);
}

export function getSourceFileSource(root: string, cache: BuildCache, watchController?: WatchController): SourceFileSource {
  return new SourceFileSource(root, cache, watchController);
}
