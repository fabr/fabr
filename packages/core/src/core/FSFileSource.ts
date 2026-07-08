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

import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import { Name } from "../model/Name";

import { Computable } from "./Computable";
import { FileSet, IFile, FileSource } from "./FileSet";
import { hashFile, readFile, readFileBuffer } from "./FSWrapper";
import { PreparedUpdate, WatchController, WatchEntry } from "./WatchController";
import * as picomatch from "picomatch";

export interface FSFileStats {
  size: number;
  mtime: Date;
}

export class FSFile implements IFile {
  private root: string;
  public stat: FSFileStats;
  public name: string;
  public hash: string;
  /**
   * The absolute path the file's *content* is read from. Defaults to the file's
   * own location under `root`, but a blob-backed source file (see
   * {@link SourceFileSource}) points this at its immutable content-addressed
   * snapshot, so reads and staging never touch the live source path while the
   * name/root — and thus {@link getDisplayName} — still identify the source.
   */
  private readonly contentPath: string;

  constructor(root: string, name: string, stat: FSFileStats, hash: string, contentPath?: string) {
    this.root = root;
    this.name = name;
    this.stat = stat;
    this.hash = hash;
    this.contentPath = contentPath ?? path.resolve(root, name);
  }

  public readString(encoding?: BufferEncoding): Computable<string> {
    return readFile(this.contentPath, encoding);
  }

  public getDisplayName(): string {
    return path.resolve(this.root, this.name);
  }

  public isSameFile(file: IFile): boolean {
    return file.getAbsPath() === this.getAbsPath();
  }

  public getAbsPath(): string {
    return this.contentPath;
  }

  public getBuffer(): Computable<Buffer> {
    return readFileBuffer(this.contentPath);
  }
}

/**
 * FileSet implementation that loads the directory tree from the real FS on demand
 */
export class FSFileSource implements FileSource {
  protected root: string;
  /**
   * When present, `find` watches persistently and re-settles its result on
   * change, funnelling events through the shared controller (which batches them
   * behind a quiet window). Absent → one-shot: enumerate once and stop watching.
   * Fixed at construction, so a source is watching-or-not for its whole life —
   * `find` never changes behaviour underneath an already-issued result.
   */
  protected readonly watchController?: WatchController;

  constructor(root: string, watchController?: WatchController) {
    this.root = root;
    this.watchController = watchController;
  }

  public find(name: Name, prefix = ""): Computable<FileSet> {
    const nameString = name.toString();
    const colonIdx = nameString.lastIndexOf(":");
    const stripPrefix =
      colonIdx === -1 ? undefined : new RegExp("^" + picomatch.parse(nameString.substring(0, colonIdx) + "/").output);
    const searchString = nameString.replace(":", "/");
    const controller = this.watchController;

    /* The retained leaf: its resolver is called once on `ready` and again on
     * every (debounced) change while watching. We resolve it only with settled
     * plain FileSets (never a Computable) so a re-settle can't orphan a prior
     * resolution nor be clobbered by a stale one. */
    let resolveLeaf!: (value: FileSet) => void;
    let rejectLeaf!: (err: unknown) => void;
    const leaf = Computable.from<FileSet>((resolve, reject) => {
      resolveLeaf = resolve;
      rejectLeaf = reject;
    });

    const files: Map<string, Computable<FSFile>> = new Map();
    const buildFileSet = (): Computable<FileSet> =>
      Computable.forAll(
        Array.from(files.values()),
        (...done) =>
          new FileSet(done.reduce((result, file) => result.set(prefix + removePrefix(file.name, stripPrefix), file), new Map()))
      );

    /* The manifest (names+hashes) of the last settled FileSet, so a change that
     * doesn't actually alter content (a touch) is skipped — no re-settle, no
     * cascade. */
    let lastManifest: string | undefined;
    const entry: WatchEntry = {
      recompute: (): Computable<PreparedUpdate | null> =>
        buildFileSet().then(fileSet => {
          const manifest = fileSet.toManifest();
          if (manifest === lastManifest) {
            return null;
          }
          lastManifest = manifest;
          return { invalidate: () => leaf.invalidate(), settle: () => resolveLeaf(fileSet) };
        }),
    };

    let ready = false;
    const watch = chokidar.watch(searchString, {
      cwd: this.root,
      persistent: !!controller,
      /* Force stat-polling instead of native OS events. chokidar's default
       * (fsevents on macOS) has been observed to silently drop `change` events
       * under heavy volume-wide fs activity — the watch then misses the edit.
       * Polling is reliable but O(files) per interval, so it doesn't scale;
       * `FABR_WATCH_POLL` is an opt-in for environments where the native backend
       * is unreliable (and the e2e test, which runs amid a saturated gate).
       * The scalable answer is a robust backend (e.g. Watchman) — future work. */
      usePolling: !!process.env.FABR_WATCH_POLL,
      /* Wait for a file's write to settle before hashing it — a low threshold
       * keeps watch snappy; a torn read would anyway be corrected by the next
       * event re-ingesting, since the snapshot is content-addressed. */
      awaitWriteFinish: controller ? { stabilityThreshold: 150, pollInterval: 50 } : false,
    });
    watch.on("add", (path, stat) => {
      files.set(path, this.fileAdded(path, stat));
      if (ready && controller) {
        controller.notifyChanged(entry);
      }
    });
    watch.on("change", (path, stat) => {
      if (ready && controller) {
        files.set(path, this.fileAdded(path, stat));
        controller.notifyChanged(entry);
      }
    });
    watch.on("unlink", path => {
      files.delete(path);
      if (ready && controller) {
        controller.notifyChanged(entry);
      }
    });
    watch.on("error", err => rejectLeaf(err));
    watch.on("ready", () => {
      ready = true;
      buildFileSet().then(fileSet => {
        lastManifest = fileSet.toManifest();
        resolveLeaf(fileSet);
      }, rejectLeaf);
      if (controller) {
        controller.track(() => void watch.close());
      } else {
        /* One-shot: the enumeration is done, so stop watching (the old code
         * leaked the watcher — see the removed FIXME). */
        void watch.close();
      }
    });
    return leaf;
  }

  protected fileAdded(filename: string, stat: FSFileStats | undefined): Computable<FSFile> {
    const filepath = path.resolve(this.root, filename);
    const fileStat = stat ?? fs.statSync(filepath);
    return hashFile(filepath).then(hash => new FSFile(this.root, filename, fileStat, hash));
  }

  public get(name: string): Computable<IFile> {
    /* FIXME: Should support watching as well. */
    return Computable.from((resolve, reject) => {
      const file = path.resolve(this.root, name);
      fs.stat(file, (err, stat) => {
        if (err) {
          reject(err);
        } else {
          /* Route through fileAdded so a subclass (SourceFileSource) applies its
           * ingestion — single-file reads get blob-backed just like glob finds. */
          resolve(this.fileAdded(name, stat));
        }
      });
    });
  }
}

export const FS = {
  /**
   * Obtain a FileSet representing a real directory on the filesystem.
   * @param path
   */
  get(dirname: string): Computable<FileSource> {
    return Computable.from<FileSource>((resolve, reject) => {
      if (fs.existsSync(dirname)) {
        resolve(new FSFileSource(dirname));
      } else {
        reject(new Error("No such path"));
      }
    });
  },
};

function removePrefix(filename: string, pattern: RegExp | undefined): string {
  if (pattern) {
    const match = pattern.exec(filename);
    if (match) {
      return filename.substring(match[0].length);
    }
  }
  return filename;
}
