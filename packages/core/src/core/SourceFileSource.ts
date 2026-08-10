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
import { hashString, isDirectoryError, isNotFound, readFileBuffer, stat } from "./FSWrapper";
import { BuildCache } from "./BuildCache";
import { FSFile, FSFileSource, staticPath } from "./FSFileSource";
import { FileSet, FileSource, IFile } from "./FileSet";
import { Name } from "./Name";
import { WatchController } from "./WatchController";
import { IResolvedWriteBack, IWriteBackObserver, writeBackFile } from "./WriteBack";
import { sniffMime } from "../support/Mime";

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
    super(sourceRoot, watchController);
    this.cache = cache;
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
   * Write refreshed content back into the source tree — recorded test
   * expectations, a golden test's blessed output.
   *
   * It lives here, on the source that owns the tree, for one reason that no
   * other placement can supply: under watch these destinations are *inputs
   * being watched*, so the write is an input change and would rebuild on its
   * own. Only the object holding the tree's content identity can say "this
   * change is mine, and its content is already what I just produced" — so the
   * write and the suppression of its echo are the same object's business.
   *
   * The DECISION stays the driver's — only under `-u`, only after a green
   * build, and it is the driver that resolved each destination from the
   * offering rule's input-relative names. This performs the writes it is asked
   * to make, it does not choose which, and every one is a real change by
   * construction (see {@link writeBackFile}). Containment is asserted here
   * regardless of caller: the tree's boundary is this source's own invariant.
   */
  public applyWriteBack(writes: ReadonlyArray<IResolvedWriteBack>): Computable<string[]> {
    /* Resolved once: `root` may be a symlinked form (macOS /var -> /private/var)
     * and containment is judged against the real path. */
    const realRoot = fs.realpathSync(path.resolve(this.root));
    return Computable.forAll(
      writes.map(write => this.writeOne(write, realRoot)),
      (...results) => results
    );
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
          this.confirmExpected(filename, hash);
          return this.cache
            .ensureBlob(hash, bytes, fileStat.mode)
            .then(
              blobPath =>
                new FSFile(this.root, filename, { size: fileStat.size, mtime: fileStat.mtime, mode: fileStat.mode }, hash, sniffMime(bytes), blobPath)
            );
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
  private confirmExpected(filename: string, hash: string): void {
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
export type WritableSourceTree = FileSource & Pick<SourceFileSource, "root" | "applyWriteBack">;

/** A destination as this source names it (tree-relative, posix), or undefined
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
