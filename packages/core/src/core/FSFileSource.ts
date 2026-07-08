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

import * as parcelWatcher from "@parcel/watcher";
import * as fs from "node:fs";
import * as path from "node:path";
import { Name } from "../model/Name";

import { Computable } from "./Computable";
import { FileSet, IFile, FileSource } from "./FileSet";
import { hashFile, readdir, readFile, readFileBuffer, stat } from "./FSWrapper";
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

type Matcher = (rel: string) => boolean;

/** A watched glob's live registration against the source's single subscription:
 * a change to a matching path updates its file map and marks its leaf stale. */
interface WatchRegistration {
  matches: Matcher;
  files: Map<string, Computable<FSFile>>;
  entry: WatchEntry;
}

/**
 * FileSet implementation that loads the directory tree from the real FS on demand
 */
export class FSFileSource implements FileSource {
  protected root: string;
  /**
   * When present, `find` results are *live*: a single {@link parcelWatcher}
   * subscription over the source tree re-settles them as files change (batched
   * through the controller). Absent → one-shot enumeration, no watching. Fixed
   * at construction, so a source is watching-or-not for its whole life.
   */
  protected readonly watchController?: WatchController;
  /**
   * The one filesystem subscription for the whole tree (created lazily on the
   * first watched `find`) and the per-glob registrations it dispatches to. One
   * subscription — not one per `find` — so watching scales and a single edit is
   * not multiplied across overlapping globs.
   */
  private subscription?: Promise<parcelWatcher.AsyncSubscription>;
  private readonly registrations = new Set<WatchRegistration>();

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

    enumerateGlob(this.root, searchString).then(({ names, matches }) => {
      for (const relName of names) {
        files.set(relName, this.fileAdded(relName, undefined));
      }
      buildFileSet().then(fileSet => {
        lastManifest = fileSet.toManifest();
        resolveLeaf(fileSet);
      }, rejectLeaf);
      if (controller) {
        this.registrations.add({ matches, files, entry });
        this.ensureSubscription(controller);
      }
    }, rejectLeaf);
    return leaf;
  }

  /**
   * Ensure the single source-tree subscription exists, then dispatch each
   * filesystem change to every registration whose glob matches — updating that
   * glob's file map and marking its leaf for a (debounced) re-settle.
   * @parcel/watcher's FSEvents backend delivers reliably under heavy load where
   * chokidar's silently dropped events (the reason for the switch, and the exact
   * 2.4.1 pin — 2.5.x fails to start FSEvents on macOS 15).
   */
  private ensureSubscription(controller: WatchController): void {
    if (this.subscription) {
      return;
    }
    /* @parcel/watcher reports canonical realpaths, but this.root may be a
     * symlinked form (macOS /var -> /private/var), so relativise against the
     * real root or nothing matches. */
    const realRoot = fs.realpathSync(this.root);
    const handler: parcelWatcher.SubscribeCallback = (err, events) => {
      if (err) {
        controller.reportError(err);
        return;
      }
      for (const event of events) {
        const rel = toPosix(path.relative(realRoot, event.path));
        for (const registration of this.registrations) {
          if (!registration.matches(rel)) {
            continue;
          }
          if (event.type === "delete") {
            registration.files.delete(rel);
          } else {
            registration.files.set(rel, this.fileAdded(rel, undefined));
          }
          controller.notifyChanged(registration.entry);
        }
      }
    };
    this.subscription = subscribeWithFallback(realRoot, handler, backend =>
      controller.reportWarning(
        `Filesystem watching fell back to the ${backend} backend (the default backend failed to start); ` +
          `watching very large trees may be slower.`
      )
    );
    this.subscription.catch(err => controller.reportError(err));
    controller.track(() => {
      const pending = this.subscription;
      this.subscription = undefined;
      this.registrations.clear();
      /* Returned (not fire-and-forget) so the controller awaits the native
       * unsubscribe before the process exits — an abrupt exit while the kqueue
       * watcher thread is live crashes with SIGABRT. */
      return pending?.then(
        sub => sub.unsubscribe(),
        () => undefined
      );
    });
  }

  protected fileAdded(filename: string, stat: FSFileStats | undefined): Computable<FSFile> {
    const filepath = path.resolve(this.root, filename);
    const fileStat = stat ?? fs.statSync(filepath);
    return hashFile(filepath).then(hash => new FSFile(this.root, filename, fileStat, hash));
  }

  public get(name: string): Computable<IFile> {
    /* FIXME: Should support watching as well. Route through fileAdded so a
     * subclass (SourceFileSource) applies its ingestion — single-file reads get
     * blob-backed just like glob finds. */
    return stat(path.resolve(this.root, name)).then(fileStat => this.fileAdded(name, fileStat));
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

const WATCH_OPTIONS: parcelWatcher.Options = { ignore: ["**/node_modules/**", "**/.git/**"] };

/**
 * Native watch backend to try when the platform default fails to *start*. macOS
 * FSEvents can refuse to start a stream (resource pressure, sandboxing, a wedged
 * fseventsd) — kqueue is a reliable, if per-fd heavier, fallback. Other platforms'
 * defaults (inotify, ReadDirectoryChangesW) are dependable enough not to need one.
 * (@parcel/watcher's bundled types omit "kqueue" though the native binding supports
 * it, hence the cast.)
 */
const FALLBACK_BACKEND: parcelWatcher.BackendType | undefined =
  process.platform === "darwin" ? ("kqueue" as unknown as parcelWatcher.BackendType) : undefined;

/**
 * Subscribe to the tree, falling back to {@link FALLBACK_BACKEND} if the default
 * backend fails to start. @parcel/watcher does not auto-fall-back — a start failure
 * rejects the returned promise — so we retry once with the alternate backend.
 */
function subscribeWithFallback(
  dir: string,
  callback: parcelWatcher.SubscribeCallback,
  onFallback: (backend: parcelWatcher.BackendType) => void
): Promise<parcelWatcher.AsyncSubscription> {
  return parcelWatcher.subscribe(dir, callback, WATCH_OPTIONS).catch(err => {
    if (!FALLBACK_BACKEND) {
      throw err;
    }
    onFallback(FALLBACK_BACKEND);
    return parcelWatcher.subscribe(dir, callback, { ...WATCH_OPTIONS, backend: FALLBACK_BACKEND });
  });
}

function makeMatcher(glob: string): Matcher {
  return (picomatch as unknown as (g: string) => Matcher)(glob);
}

/** Normalise an OS path to forward slashes so glob matching and FileSet names
 * are platform-independent (matching chokidar's old behaviour). */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Enumerate the files under `root` matching `searchString`, returning both the
 * matching root-relative names and the matcher (reused to filter live change
 * events, so enumeration and watching agree). A plain file matches itself; a
 * bare directory means every file beneath it. Only the glob's static base is
 * walked, and node_modules/.git are skipped.
 */
function enumerateGlob(root: string, searchString: string): Computable<{ names: string[]; matches: Matcher }> {
  const scanned = picomatch.scan(searchString);
  if (!scanned.isGlob) {
    const literal = makeMatcher(searchString);
    return stat(path.resolve(root, searchString)).then(
      fileStat =>
        fileStat.isFile()
          ? { names: [toPosix(searchString)], matches: literal }
          : /* A directory reference means every file beneath it. */
            walkGlob(root, `${searchString.replace(/\/+$/, "")}/**`),
      /* Nothing there yet — an empty set a later create-event can fill. */
      () => ({ names: [], matches: literal })
    );
  }
  return walkGlob(root, searchString);
}

function walkGlob(root: string, pattern: string): Computable<{ names: string[]; matches: Matcher }> {
  const matches = makeMatcher(pattern);
  const base = path.resolve(root, picomatch.scan(pattern).base);
  return walk(root, base, matches).then(names => ({ names, matches }));
}

function walk(root: string, dir: string, matches: Matcher): Computable<string[]> {
  return readdir(dir).then(
    entries =>
      Computable.forAll(
        entries.map(entry => {
          if (entry.name === "node_modules" || entry.name === ".git") {
            return Computable.resolve<string[]>([]);
          }
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            return walk(root, abs, matches);
          }
          if (entry.isFile()) {
            const rel = toPosix(path.relative(root, abs));
            return Computable.resolve<string[]>(matches(rel) ? [rel] : []);
          }
          return Computable.resolve<string[]>([]);
        }),
        (...lists) => lists.flat()
      ),
    /* An unreadable directory contributes nothing. */
    () => []
  );
}
