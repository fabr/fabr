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

import { Computable, ComputableSource, ComputableState } from "./Computable";
import { FileSet, IFile, FileSource } from "./FileSet";
import { hashFile, readFile, readFileBuffer, stat, walkTree } from "./FSWrapper";
import { toError } from "./Errors";
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

/**
 * A reactive query over the source tree: a {@link ComputableSource} that IS both the
 * graph node and its FS-side registration. It **attaches** (registers with the source
 * and enumerates the current tree) on its first dependant and **detaches** (unregisters)
 * on its last — so a watch is held exactly while its result is needed, and a reload's
 * orphaned query cleans up with no sweep. When the source has a {@link WatchController}
 * the query is *live*: the source hands each raw change to {@link applyEvent}, and if it
 * was ours we update our files and it asks the controller to re-settle (skipped when the
 * content-manifest is unchanged — a touch). Without a controller register/dispatch are
 * no-ops, so it is a one-shot enumeration that simply never sees an event. Always yields
 * a {@link FileSet}; `get` projects the single file via {@link FileSet.getSingleFile}
 * (a single-file `get` is just a query over a literal, non-glob path).
 */
class TreeQuery extends ComputableSource<FileSet> implements WatchEntry {
  private readonly files = new Map<string, Computable<FSFile>>();
  private matches: Matcher = () => false;
  private lastManifest: string | undefined;

  constructor(
    private readonly owner: FSFileSource,
    private readonly root: string,
    private readonly searchString: string,
    private readonly prefix: string,
    private readonly stripPrefix: RegExp | undefined
  ) {
    super();
  }

  protected override attach(): void {
    /* super.attach() moves us Detached -> Unresolved, i.e. pending — so a reattach
     * won't briefly serve the stale value while we re-enumerate the current tree
     * (picking up anything changed while unsubscribed) and settle. */
    super.attach();
    this.owner.registerQuery(this);
    this.files.clear();
    enumerateGlob(this.root, this.searchString).then(({ names, matches }) => {
      names.forEach(name => this.files.set(name, this.owner.ingest(name)));
      this.matches = matches;
      this.deliver();
    }, err => this.settle(ComputableState.Error, toError(err)));
  }

  protected override detach(): void {
    super.detach();
    this.owner.unregisterQuery(this);
  }

  /** Apply a filesystem change: if `rel` is one of ours, update the file map and return
   * true (so the source schedules our re-settle); otherwise ignore it and return false. */
  public applyEvent(rel: string, removed: boolean): boolean {
    if (!this.matches(rel)) {
      return false;
    }
    if (removed) {
      this.files.delete(rel);
    } else {
      this.files.set(rel, this.owner.ingest(rel));
    }
    return true;
  }

  private build(): Computable<FileSet> {
    return buildFileSet(this.files, this.prefix, this.stripPrefix);
  }

  private deliver(): void {
    this.build().then(fileSet => {
      this.lastManifest = fileSet.toManifest();
      this.settle(ComputableState.Valid, fileSet);
    }, err => this.settle(ComputableState.Error, toError(err)));
  }

  /** WatchController entry: rebuild from the (dispatcher-updated) files and, unless the
   * content is unchanged (a touch), prepare the batched re-settle. */
  public recompute(): Computable<PreparedUpdate | null> {
    return this.build().then(fileSet => {
      const manifest = fileSet.toManifest();
      if (manifest === this.lastManifest) {
        return null;
      }
      this.lastManifest = manifest;
      return { invalidate: () => this.invalidate(), settle: () => this.settle(ComputableState.Valid, fileSet) };
    });
  }
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
  /** The live queries the single subscription dispatches to — one per watched
   * `find`/`get`. Each adds itself here when it attaches and removes itself when
   * it detaches (see {@link TreeQuery}); one subscription, not one per query. */
  private readonly registrations = new Set<TreeQuery>();

  constructor(root: string, watchController?: WatchController) {
    this.root = root;
    this.watchController = watchController;
  }

  public find(name: Name, prefix = ""): ComputableSource<FileSet> {
    const nameString = name.toString();
    const colonIdx = nameString.lastIndexOf(":");
    const stripPrefix =
      colonIdx === -1 ? undefined : new RegExp("^" + picomatch.parse(nameString.substring(0, colonIdx) + "/").output);
    const searchString = nameString.replace(":", "/");
    return new TreeQuery(this, this.root, searchString, prefix, stripPrefix);
  }

  /** Register a live query with the dispatch set and ensure the subscription (a
   * no-op when this source isn't watching). Called from {@link TreeQuery} on attach. */
  public registerQuery(query: TreeQuery): void {
    const controller = this.watchController;
    if (controller) {
      this.registrations.add(query);
      this.ensureSubscription(controller);
    }
  }

  /** Remove a live query from the dispatch set (on its detach). */
  public unregisterQuery(query: TreeQuery): void {
    this.registrations.delete(query);
  }

  /**
   * Ensure the single source-tree subscription exists, then hand each filesystem change
   * to every registered query ({@link TreeQuery.applyEvent}), scheduling a (debounced)
   * re-settle for each that claims it. @parcel/watcher's FSEvents backend delivers
   * reliably under heavy load where chokidar silently dropped events (the reason for the
   * switch, and the exact 2.4.1 pin — 2.5.x fails to start FSEvents on macOS 15).
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
        for (const query of this.registrations) {
          if (query.applyEvent(rel, event.type === "delete")) {
            controller.notifyChanged(query);
          }
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

  /** Turn a tree-relative path into a tracked FSFile. Public because a {@link TreeQuery}
   * (a separate class) calls it to seed and update its file map; overridable so a subclass
   * ({@link SourceFileSource}) can blob-back the content. */
  public ingest(filename: string): Computable<FSFile> {
    const filepath = path.resolve(this.root, filename);
    return hashFile(filepath).then(hash => new FSFile(this.root, filename, fs.statSync(filepath), hash));
  }

  public get(name: string): ComputableSource<IFile | undefined> {
    /* A single-file get is a query over the literal path (enumerateGlob's non-glob branch
     * stats one file), projected to that file — undefined when absent, per the FileSource
     * contract. When watching, a `.fabr` edit thus cascades (through the loader's memoized
     * parse) into a model reload. The name is normalised to a root-relative path, since
     * callers pass it either relative (the project entry) or absolute (a resolved include). */
    const target = toPosix(path.relative(this.root, path.resolve(this.root, name)));
    return new TreeQuery(this, this.root, target, "", undefined).then(fileSet => fileSet.getSingleFile());
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

/** Resolve a query's held files into a FileSet, each name reprefixed (the
 * `alias:path` strip + the caller's `prefix`). Shared by the one-shot and live
 * `find` paths. */
function buildFileSet(
  files: Map<string, Computable<FSFile>>,
  prefix: string,
  stripPrefix: RegExp | undefined
): Computable<FileSet> {
  return Computable.forAll(
    Array.from(files.values()),
    (...done) =>
      new FileSet(done.reduce((result, file) => result.set(prefix + removePrefix(file.name, stripPrefix), file), new Map<string, IFile>()))
  );
}

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
  const names: string[] = [];
  return walkTree(
    dir,
    (entry, abs) => {
      if (entry.isFile()) {
        const rel = toPosix(path.relative(root, abs));
        if (matches(rel)) {
          names.push(rel);
        }
      }
    },
    /* Source scanning ignores dependency and VCS trees entirely. */
    entry => entry.name === "node_modules" || entry.name === ".git"
  ).then(() => names);
}
