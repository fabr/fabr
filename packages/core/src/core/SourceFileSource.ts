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

/** What a project file's path from the root is prefixed with to make its
 *  source path, a reference to it from the project root. */
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
   * What fabr itself last wrote into the tree: name → content hash. A watch
   * event naming one of these is fabr's own echo, and must not arm a rebuild
   * whose only outcome would be to write the identical bytes again (see
   * {@link applyWriteBack}).
   *
   * Kept rather than consumed, because it states the CONTENT expected at a
   * path, not "one event pending": a filesystem may deliver an event twice, or
   * late, and every one of them is still the echo as long as the file holds
   * those bytes. An entry is dropped the moment {@link ingest} reads different
   * bytes there — that is a real edit, and it arms.
   *
   * `undefined` marks a path whose content is not the point — the temp sibling
   * a write renames from, a directory it had to create. Those are ours too and
   * there is nothing to confirm them against, so they are never refuted.
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
    /* A REMOVAL is never something a write-back does to a destination — the
     * one delete in its choreography is the temp sibling the rename consumes
     * (recorded content-less, `undefined`). So a removal at or under a path
     * whose CONTENT we vouched for is somebody else's change (a stale record
     * deleted mid-watch, an `rm -rf __snapshots__`) — and since the file is
     * gone, the ingest that would normally refute the expectation by hash can
     * never run: it is refuted here instead, the stale entries dropped so a
     * recreation is judged afresh. A removal touching only content-less
     * entries (the temp sibling) stays ours and defers. The subtree scan is
     * what catches a directory delete, which the FS reports as ONE event with
     * no per-child deletes. */
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
   * Write content back into the source tree — refreshed test expectations, or
   * the coverage report.
   *
   * Under watch these destinations are *inputs being watched*, so the write is
   * an input change: this source records what it wrote and its content, and
   * recognizes the resulting events as its own echo (see
   * {@link isExpectedChange}) rather than arming a rebuild.
   *
   * The DECISION stays the driver's: it chooses each write and its
   * destination (an expectation only under `-u`, after a green build, located
   * from the offering rule's input-relative names). This performs the writes
   * it is asked to make, it does not choose which. Containment is asserted here
   * regardless of caller: the tree's boundary is this source's own invariant.
   */
  public applyWriteBack(writes: ReadonlyArray<IResolvedWriteBack>): Computable<string[]> {
    /* Resolved once: `root` may be a symlinked form (macOS /var -> /private/var)
     * and containment is judged against the real path. */
    const realRoot = fs.realpathSync(path.resolve(this.root));
    return mapComputable(writes, write => {
      const name = treeNameOf(write.destination, realRoot);
      if (name === undefined) {
        /* A candidate's path comes from a source file's own recorded location, so
         * this fires only on a genuinely out-of-tree input; it is checked here
         * regardless, as the boundary where a bad path becomes damage to the disk. */
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

  /** Record that a path is fabr's own doing. Keyed as this source names things,
   * which is how a watch event (relative to the tree) finds it. */
  private expect(absolute: string, hash: string | undefined): void {
    const rel = toSourceName(this.root, absolute);
    if (rel !== undefined) {
      this.expected.set(rel, hash);
    }
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
      return Computable.reject(new FabrError(`'${name}' is outside the source tree`));
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
      return Computable.reject(new FabrError(`'${name.toString()}' is outside the source tree`));
    }
    return super.find(name, prefix);
  }

  /**
   * Confirm — or refute — an expected self-write, now that the file's real
   * content is known.
   *
   * The dispatch that deferred the change could only match on the path, being
   * synchronous; this is where the hash it was written with is checked, which
   * is the whole reason the write records one. Matching bytes leave the
   * expectation standing, so a repeated or late event for the same content is
   * recognized as the echo too. DIFFERENT bytes mean somebody else edited the
   * file, so the expectation is dropped and the flush armed — the change was
   * already recorded as dirty by the deferred notify, it only needed a reason
   * to be applied.
   */
  protected override confirmIngested(filename: string, hash: string): void {
    const expected = this.expected.get(filename);
    /* `has` before comparing: a stored `undefined` is a path with no content to
     * confirm (see `expected`), not a mismatch. */
    if (this.expected.has(filename) && expected !== undefined && expected !== hash) {
      this.expected.delete(filename);
      this.watchController?.armFlush();
    }
  }
}

/**
 * The source tree as a consumer sees it: readable like any {@link FileSource},
 * and — alone among sources — writable, for the one thing fabr puts back into
 * the user's tree.
 *
 * A ROLE rather than an implementation, so that `FileSource` itself stays free
 * of a root: a FileSet is a FileSource too and is rooted nowhere on disk, and
 * a containment bound should never come from downcasting a general interface.
 */
export type WritableSourceTree = FileSource & Pick<SourceFileSource, "root" | "locate" | "applyWriteBack" | "writeFile">;

/** Name a destination as this source does (tree-relative, posix), or undefined
 * if it lies outside the tree — which {@link SourceFileSource.applyWriteBack}
 * refuses anyway, so there is nothing to expect an echo from. */
function toSourceName(root: string, destination: string): string | undefined {
  const rel = path.relative(root, destination);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

export function getSourceFileSource(root: string, cache: BuildCache, watchController?: WatchController): SourceFileSource {
  return new SourceFileSource(root, cache, watchController);
}
