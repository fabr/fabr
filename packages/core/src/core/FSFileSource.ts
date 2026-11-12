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
import { Name } from "./Name";

import { Computable, ComputableSource, ComputableState } from "./Computable";
import { mapComputable } from "../support/Functional";
import { DEFAULT_FILE_MODE, FileSet, IFile, FileSource } from "./FileSet";
import { hashFile, hashString, isDirectoryError, isNotFound, readFile, readFileBuffer, stat, walkTree } from "./FSWrapper";
import type { BuildCache } from "./BuildCache";
import { sniffMime } from "../support/Mime";
import { FabrError, MultiError, toError } from "./Errors";
import {
  IProvenanceStep,
  namingDigest,
  registerProvenanceNaming,
  registerProvenanceRenderer,
  renamingText,
  restrictedTo,
} from "./Provenance";
import { PreparedUpdate, WatchController, WatchEntry } from "./WatchController";

export interface FSFileStats {
  size: number;
  mtime: Date;
  /** POSIX mode bits as `fs.Stats` reports them; absent where a producer
   * gives a partial stat, read as {@link DEFAULT_FILE_MODE}. */
  mode?: number;
}

/**
 * @return the mode a file with `stat` has, as git records one: 0o755 where its
 * owner may execute it, else {@link DEFAULT_FILE_MODE}. The mode is key
 * material, so the other bits, which vary with the writer's umask, are dropped.
 */
export function fileModeOf(stat: FSFileStats): number {
  return stat.mode !== undefined && (stat.mode & 0o100) !== 0 ? 0o755 : DEFAULT_FILE_MODE;
}

/** A file read from a directory on disk. */
export class FSFile implements IFile {
  private readonly root: string;
  public stat: FSFileStats;
  public name: string;
  public hash: string;
  /**
   * The absolute path the content is read from: the file's own path under
   * `root`, or the copy in the blob pool of a file its source copied there
   * (as {@link SourceFileSource} does), while `name` and `root`, and so
   * {@link getDisplayName}, still name the file read.
   */
  private readonly contentPath: string;

  constructor(
    root: string,
    name: string,
    stat: FSFileStats,
    hash: string,
    public readonly mime: string,
    contentPath?: string
  ) {
    this.root = root;
    this.name = name;
    this.stat = stat;
    this.hash = hash;
    this.contentPath = contentPath ?? path.resolve(root, name);
  }

  public get mode(): number {
    return fileModeOf(this.stat);
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
 * A query for the files a name selects from a directory tree: a raw
 * {@link ComputableSource} holding them as a {@link FileSet}, each named by
 * the name's projection. It attaches on its first dependant, registering with
 * its source and reading the tree, and detaches on its last, unregistering.
 * Where the source has a {@link WatchController} the query stays current: the
 * source passes it each filesystem change ({@link applyEvent}), and a query
 * the change concerns has the controller settle it again ({@link recompute}),
 * unless its files are unchanged (a touch). Without one, it reads the tree
 * once per attach. {@link FSFileSource.get} is a query over a literal path,
 * read as a single file.
 */
export class TreeQuery extends ComputableSource<FileSet> implements WatchEntry {
  /* The query's files as last read, by tree-relative path. */
  private readonly files = new Map<string, FSFile>();
  /* The paths whose last read failed, with the error a build reports for each. */
  private readonly failed = new Map<string, Error>();
  /* The reads a change event started that have not yet landed in `files`/`failed`;
   * a build waits for these. */
  private readonly pending = new Map<string, Computable<FSFile | undefined>>();
  /* The name's projection: a tree path to its result name, or undefined where
   * the path is no member. Set when the enumeration lands (a bare directory
   * expands to its contents there). */
  private project: Projector = () => undefined;
  /* The manifest of the FileSet last settled: a recompute finding the same
   * settles nothing. */
  private lastManifest: string | undefined;
  /* True from attach until the enumeration has read the tree. Events arriving
   * meanwhile are held in `pendingEvents` and applied when it lands. */
  private enumerating = true;
  private readonly pendingEvents: [string, boolean][] = [];
  /* Bumped on each attach. Async work captures it, and drops its result where
   * the query has since detached or attached again (see isCurrent). */
  private attachGeneration = 0;
  /* Bumped as each build of the FileSet starts: an attach's enumeration, or a
   * recompute. Builds can overlap and finish in either order, and only the
   * latest may settle. Keep it apart from attachGeneration: a recompute
   * bumping that would make an enumeration in flight drop its own work. */
  private delivery = 0;
  /* The subtree this query walks, its name's static leading path: a change
   * outside it can add nothing, so only one inside is probed for a new
   * directory (see applyCreate). */
  private readonly base: string;
  /* Paths with a directory rescan in flight, so a burst of events over one new
   * directory walks it once (see startRescan). */
  private readonly rescanning = new Set<string>();
  /* The key its source holds it under while it is in use (see FSFileSource.query). */
  public heldAs?: string;

  /** Get the directory, relative to the source's root, that holds everything this
   *  query can match: its static path where it has a pattern, and the directory
   *  that path is in where it names one path. */
  public get directory(): string {
    return this.name.hasGlob() ? this.base : path.posix.dirname(this.base).replace(/^\.$/, "");
  }

  constructor(
    private readonly owner: FSFileSource,
    private readonly root: string,
    private readonly name: Name,
    private readonly prefix: string,
    /* The enumeration run on each attach: by default the tree walk
     * ({@link enumerate}); `get` passes {@link enumerateFile}, and a test may
     * pass its own. */
    private readonly enumerator?: () => Computable<{ names: string[]; project: Projector }>
  ) {
    super();
    /* staticPath keeps a trailing slash (`src/**` → `src/`); drop it, since
     * withinBase adds its own. */
    this.base = staticPath(name).replace(/\/+$/, "");
  }

  /** Become Unresolved, clear what was held, register with the source and
   * read the tree. The first value settles once the enumeration's files are
   * read, with the events that arrived meanwhile applied; a failed
   * enumeration settles its error. */
  protected override attach(): void {
    super.attach();
    const generation = ++this.attachGeneration;
    this.owner.registerQuery(this);
    this.owner.holdQuery(this);
    this.files.clear();
    this.failed.clear();
    this.pending.clear();
    /* Nothing settled survives a detach, so a recompute must not take the
     * tree as already settled. */
    this.lastManifest = undefined;
    this.enumerating = true;
    this.pendingEvents.length = 0;
    /* A probe still in flight is dropped when it lands (see isCurrent);
     * clearing lets its path be probed again. */
    this.rescanning.clear();
    const enumerator = this.enumerator ?? (() => enumerate(this.root, this.name, this.prefix));
    enumerator().then(
      ({ names, project }) => {
        if (!this.isCurrent(generation)) {
          return Computable.resolve(undefined);
        }
        /* Events stay buffered while the enumerated files are read. */
        return this.ingestAll(names).then(read => {
          if (this.isCurrent(generation)) {
            this.enumerated(generation, read, project);
          }
        });
      },
      err => {
        if (this.isCurrent(generation)) {
          this.settle(ComputableState.Error, toError(err));
        }
      }
    );
  }

  /** Take the enumeration's reads and projection, replay the events buffered meanwhile,
   * and settle the first value. */
  private enumerated(generation: number, read: ReadonlyArray<IRead>, project: Projector): void {
    this.store(read);
    this.project = project;
    this.enumerating = false;
    /* Apply the events held during the enumeration before the first settle,
     * so the first value is current. */
    for (const [rel, removed] of this.pendingEvents) {
      this.applyDelta(rel, removed);
    }
    this.pendingEvents.length = 0;
    this.deliver(generation);
  }

  protected override detach(): ComputableSource<unknown>[] {
    const released = super.detach();
    this.owner.unregisterQuery(this);
    this.owner.releaseQuery(this);
    /* An attach reads the tree afresh, so a detached query holds no files. */
    this.files.clear();
    this.failed.clear();
    this.pending.clear();
    return released;
  }

  /** @return true if the attach that captured `generation` is the current
   * one and the query is attached, otherwise false. Check it before async work
   * changes the query's state: after a detach and attach again, the base's
   * settle guard lets a stale result land. */
  private isCurrent(generation: number): boolean {
    return generation === this.attachGeneration && this.state !== ComputableState.Detached;
  }

  /** @return true if the build that captured these tokens may still settle, otherwise
   * false: its attach must still be live, and no later build may have started since (see
   * {@link delivery}). */
  private isCurrentDelivery(generation: number, delivery: number): boolean {
    return this.isCurrent(generation) && delivery === this.delivery;
  }

  /** Apply a filesystem change at `rel` (a deletion where `removed`). @return
   * true if it changed the query's files, for the source to report to the
   * controller, otherwise false. During the enumeration the event is held,
   * applied when the enumeration lands, and false returned. */
  public applyEvent(rel: string, removed: boolean): boolean {
    if (this.enumerating) {
      this.pendingEvents.push([rel, removed]);
      return false;
    }
    return this.applyDelta(rel, removed);
  }

  /**
   * Apply a change against the known projection. @return true if it changed
   * the query's files now, otherwise false.
   *
   * An event may name a directory: macOS reports `mv a b` of a directory as
   * one delete of `a` and one create of `b`, with no event for the files
   * inside. So a removal drops whatever the query holds at or under the path
   * ({@link dropSubtree}), and a create also probes the path for a directory
   * to walk ({@link startRescan}). Where a removed path is still on disk (a
   * replace whose events arrived merged or out of order), it is then read
   * again as a create.
   */
  private applyDelta(rel: string, removed: boolean): boolean {
    if (removed) {
      const dropped = this.dropSubtree(rel);
      return fs.existsSync(path.resolve(this.root, rel)) ? this.applyCreate(rel) || dropped : dropped;
    }
    return this.applyCreate(rel);
  }

  /** Apply a create or change at `rel`. @return true if it changed the query's files now, otherwise false. */
  private applyCreate(rel: string): boolean {
    /* Do both: a bare-directory name matches its own path, so after `mv
     * elsewhere src` the read of `src` finds no file (a directory reads as
     * undefined), and only the rescan finds what it holds. */
    const matched = this.project(rel) !== undefined;
    if (matched) {
      this.startRead(rel);
    }
    if (this.withinBase(rel)) {
      this.startRescan(rel);
    }
    return matched;
  }

  /** Drop `rel` and everything held under it, from the files, the failed
   * reads and the pending reads, whatever the projection admits. @return true
   * if anything was dropped, otherwise false. */
  private dropSubtree(rel: string): boolean {
    const prefix = rel + "/";
    let dropped = false;
    for (const held of [this.files, this.failed, this.pending]) {
      for (const name of [...held.keys()]) {
        if (name === rel || name.startsWith(prefix)) {
          held.delete(name);
          dropped = true;
        }
      }
    }
    return dropped;
  }

  /** @return true if `rel` lies within the subtree this query walks, and so could hold
   * files it wants, otherwise false. An empty base (a name with no static prefix) spans the whole tree. */
  private withinBase(rel: string): boolean {
    return this.base === "" || rel === this.base || rel.startsWith(this.base + "/");
  }

  /**
   * Probe a created path for a directory, and walk it for the files the
   * projection admits: start each one's read, and report the change through
   * {@link FSFileSource.notifyQueryChanged}, so the controller's next batch
   * applies it. A path is probed once at a time, and a result landing after
   * a detach or a later attach is dropped (see isCurrent).
   */
  private startRescan(rel: string): void {
    if (this.rescanning.has(rel)) {
      return;
    }
    this.rescanning.add(rel);
    const generation = this.attachGeneration;
    const abs = path.resolve(this.root, rel);
    stat(abs)
      .then(entry => (entry.isDirectory() ? walk(this.root, abs, this.project) : []))
      .once(
        names => {
          this.rescanning.delete(rel);
          if (names.length === 0 || !this.isCurrent(generation)) {
            return;
          }
          /* Pending until it lands, so a later event on the path replaces or
           * drops it. */
          names.forEach(name => this.startRead(name));
          this.owner.notifyQueryChanged(this, names);
        },
        () => {
          /* Vanished again, or unreadable: nothing to add, and a later event re-probes. */
          this.rescanning.delete(rel);
        }
      );
  }

  /** Read each of `names`, at most {@link INGEST_CONCURRENCY} at a time, recording a
   * failed read as its error rather than failing the lot. */
  private ingestAll(names: ReadonlyArray<string>): Computable<IRead[]> {
    return mapComputable(
      names,
      (name): Computable<IRead> =>
        this.owner.ingest(name).then(
          (file): IRead => ({ name, file }),
          (err: unknown): IRead => ({ name, error: toError(err) })
        ),
      INGEST_CONCURRENCY
    );
  }

  /** Record `read` as the query's current files. */
  private store(read: ReadonlyArray<IRead>): void {
    for (const each of read) {
      this.failed.delete(each.name);
      this.files.delete(each.name);
      if (each.error !== undefined) {
        this.failed.set(each.name, each.error);
      } else if (each.file !== undefined) {
        this.files.set(each.name, each.file);
      }
    }
  }

  /** Start reading `rel`, holding the read as pending until it lands in the
   * files; a later event on the path replaces it. */
  private startRead(rel: string): void {
    const generation = this.attachGeneration;
    const reading = this.owner.ingest(rel);
    this.pending.set(rel, reading);
    reading.once(
      file => this.landRead(generation, rel, reading, { name: rel, file }),
      err => this.landRead(generation, rel, reading, { name: rel, error: toError(err) })
    );
  }

  /** Move a pending read into the files, unless a later event or attach has since replaced it. */
  private landRead(generation: number, rel: string, reading: Computable<FSFile | undefined>, read: IRead): void {
    if (this.isCurrent(generation) && this.pending.get(rel) === reading) {
      this.pending.delete(rel);
      this.store([read]);
    }
  }

  /** Make the query's FileSet from its files, once the reads pending now have
   * landed. Rejects with the failed reads' errors combined. */
  private build(): Computable<FileSet> {
    const pending = [...this.pending];
    const files = this.files;
    const failed = this.failed;
    return mapComputable(
      pending,
      ([name, reading]): Computable<IRead> =>
        reading.then(
          (file): IRead => ({ name, file }),
          (err: unknown): IRead => ({ name, error: toError(err) })
        ),
      Infinity
    ).then(read => {
      const current = new Map(files);
      const errors = new Map(failed);
      for (const each of read) {
        current.delete(each.name);
        errors.delete(each.name);
        if (each.error !== undefined) {
          errors.set(each.name, each.error);
        } else if (each.file !== undefined) {
          current.set(each.name, each.file);
        }
      }
      if (errors.size > 0) {
        throw MultiError.of([...errors.values()]);
      }
      return buildFileSet(current, this.project, this.owner.sourcePathPrefix);
    });
  }

  /** Build the FileSet and settle it, unless the query has since detached,
   * attached again or started a later build. */
  private deliver(generation: number): void {
    const delivery = ++this.delivery;
    this.build().then(
      fileSet => {
        if (!this.isCurrentDelivery(generation, delivery)) {
          return;
        }
        this.lastManifest = fileSet.toManifest();
        this.settle(ComputableState.Valid, fileSet);
      },
      err => {
        if (this.isCurrentDelivery(generation, delivery)) {
          this.settle(ComputableState.Error, toError(err));
        }
      }
    );
  }

  /** Build the FileSet from the files as events left them, for the
   * controller's batch. @return the update settling it, or null where the
   * files are the ones last settled, the enumeration is still running, or the
   * query has since detached, attached again or started a later build. The
   * update re-checks the last of these when applied. */
  public recompute(): Computable<PreparedUpdate | null> {
    /* The enumeration settles the current files itself. */
    if (this.enumerating) {
      return Computable.resolve(null);
    }
    const generation = this.attachGeneration;
    const delivery = ++this.delivery;
    return this.build().then(fileSet => {
      if (!this.isCurrentDelivery(generation, delivery)) {
        return null;
      }
      const manifest = fileSet.toManifest();
      if (manifest === this.lastManifest) {
        return null;
      }
      /* Advance lastManifest only in settle: a batch that drops this update
       * leaves it matching the value still settled. */
      return {
        invalidate: () => {
          if (this.isCurrentDelivery(generation, delivery)) {
            this.invalidate();
          }
        },
        /* The controller applies this once the whole batch is prepared:
         * re-check, and leave lastManifest alone where this build is stale. */
        settle: () => {
          if (!this.isCurrentDelivery(generation, delivery)) {
            return;
          }
          this.lastManifest = manifest;
          this.settle(ComputableState.Valid, fileSet);
        },
      };
    });
  }
}

/**
 * A FileSource over a directory on disk. `find` and `get` answer with a
 * {@link TreeQuery}, one per question, shared while in use, and kept current
 * under a WatchController.
 */
export class FSFileSource implements FileSource {
  /** The directory this source serves, absolute. Names are relative to it,
   * so a caller aligning a pattern with this source rebases against it
   * (Name.rebase). */
  public readonly root: string;
  /**
   * Where present, queries are kept current through the source's
   * subscriptions ({@link subscriptions}), batched by the controller; absent,
   * each attach reads the tree once. Fixed for the source's life.
   */
  protected readonly watchController?: WatchController;
  /* The query for each name and prefix asked of `find`, and each path asked
   * of `get`: shared by everything that asks while it is attached, and
   * forgotten when it detaches. */
  private readonly queries = new Map<string, TreeQuery>();
  /**
   * The filesystem subscriptions, one per directory {@link watchedDirectoryOf}
   * names (relative to the root, `""` for the root itself), each made for the
   * first watched query that needs it. An ordinary source has one, for the
   * whole tree.
   */
  private readonly subscriptions = new Map<string, Promise<parcelWatcher.AsyncSubscription>>();
  /** The attached queries of a watching source, each given every filesystem
   * change. */
  private readonly registrations = new Set<TreeQuery>();

  /**
   * Where present, every file this source reads is copied into this blob pool
   * as it is hashed, and read from the copy from then on.
   * {@link SourceFileSource} copies in its own way and passes none.
   */
  private readonly pool?: BuildCache;

  constructor(root: string, watchController?: WatchController, pool?: BuildCache) {
    this.root = root;
    this.watchController = watchController;
    this.pool = pool;
  }

  /** What a file's path under this tree is prefixed with to make its source
   *  path: none for a plain tree, which no reference from the project names. */
  public get sourcePathPrefix(): string | undefined {
    return undefined;
  }

  /** Get the query for the files `name` selects, each named by its
   * projection with `prefix` ({@link Name.makeProjector}). */
  public find(name: Name, prefix = ""): ComputableSource<FileSet> {
    /* Rebase onto the root first: results are named relative to it (see
     * walk), so an absolute name must drop the root, as `get` does. */
    const rebased = name.rebase(this.root);
    return this.query(`find ${prefix}\0${rebased.toGlobString()}`, () => new TreeQuery(this, this.root, rebased, prefix));
  }

  /** Get the query held under `key`, made by `make` where none is held yet. */
  private query(key: string, make: () => TreeQuery): TreeQuery {
    let held = this.queries.get(key);
    if (held === undefined) {
      held = make();
      held.heldAs = key;
      this.queries.set(key, held);
    }
    return held;
  }

  /** Hold `query` under its key again as it attaches, where no other query has taken its place. */
  public holdQuery(query: TreeQuery): void {
    if (query.heldAs !== undefined && !this.queries.has(query.heldAs)) {
      this.queries.set(query.heldAs, query);
    }
  }

  /** Forget `query` as it detaches, so a query nothing uses is held by nothing. */
  public releaseQuery(query: TreeQuery): void {
    if (query.heldAs !== undefined && this.queries.get(query.heldAs) === query) {
      this.queries.delete(query.heldAs);
    }
  }

  /** Register a live query with the dispatch set and ensure the subscription (a
   * no-op when this source isn't watching). Called from {@link TreeQuery} on attach. */
  public registerQuery(query: TreeQuery): void {
    const controller = this.watchController;
    if (controller) {
      this.registrations.add(query);
      this.ensureSubscription(controller, this.watchedDirectoryOf(query));
    }
  }

  /**
   * Get the directory, relative to the root, whose subscription reports the
   * changes `query` needs to see: the root itself, so that one subscription
   * serves every query. A source whose root holds far more than it reads (the
   * host's whole filesystem) overrides it to watch only what a query covers.
   */
  protected watchedDirectoryOf(query: TreeQuery): string {
    void query;
    return "";
  }

  /**
   * @return true if a change at `rel` is one fabr itself just made, and so
   * must start no batch of its own, otherwise false. `removed` marks a
   * deletion, which nothing reads again to confirm (see {@link ingest}), so
   * the judgment must settle it. Always false here;
   * {@link SourceFileSource}, which writes back into the project's tree,
   * overrides it.
   */
  protected isExpectedChange(rel: string, removed = false): boolean {
    void rel;
    void removed;
    return false;
  }

  /** Remove a live query from the dispatch set (on its detach). */
  public unregisterQuery(query: TreeQuery): void {
    this.registrations.delete(query);
  }

  /**
   * Report to the controller that `query` changed outside the dispatch of a
   * filesystem event, as a directory rescan does; a no-op when not watching.
   * The change is deferred (see WatchController.notifyChanged) where every
   * name in `found`, the files picked up, is a change fabr made itself
   * ({@link isExpectedChange}).
   */
  public notifyQueryChanged(query: TreeQuery, found?: readonly string[]): void {
    const defer = found !== undefined && found.length > 0 && found.every(name => this.isExpectedChange(name));
    this.watchController?.notifyChanged(query, { defer });
  }

  /**
   * Ensure the subscription to `dir` (relative to the root) exists, handing
   * each filesystem change to every registered query
   * ({@link TreeQuery.applyEvent}) and reporting each query it changed to the
   * controller. Requires @parcel/watcher 2.5.0 or later: earlier versions can
   * deadlock natively when the kqueue fallback races a failing FSEvents start.
   */
  private ensureSubscription(controller: WatchController, dir: string): void {
    if (this.subscriptions.has(dir)) {
      return;
    }
    /* @parcel/watcher reports real paths, but the directory may be named
     * through a symlink (macOS /var -> /private/var): take each event relative
     * to the real path, then onto `dir`. */
    const realDir = fs.realpathSync(path.resolve(this.root, dir));
    const handler: parcelWatcher.SubscribeCallback = (err, events) => {
      if (err) {
        controller.reportError(err);
        return;
      }
      for (const event of events) {
        const inner = path.relative(realDir, event.path);
        const rel = toPosix(dir === "" ? inner : inner === "" ? dir : path.join(dir, inner));
        /* A change fabr made itself is deferred (see notifyChanged's
         * `defer`). It is judged on the path here, the dispatch being
         * synchronous; its content is confirmed when ingest reads the file
         * again (see SourceFileSource), except for a deletion. */
        const defer = this.isExpectedChange(rel, event.type === "delete");
        for (const query of this.registrations) {
          if (query.applyEvent(rel, event.type === "delete")) {
            controller.notifyChanged(query, { defer });
          }
        }
      }
    };
    const subscription = subscribeWithFallback(realDir, handler, backend =>
      controller.reportWarning(
        `Filesystem watching fell back to the ${backend} backend (the default backend failed to start); ` +
          `watching very large trees may be slower.`
      )
    );
    this.subscriptions.set(dir, subscription);
    subscription.catch(err => controller.reportError(err));
    controller.track(() => {
      this.subscriptions.delete(dir);
      this.registrations.clear();
      /* Return the promise: close waits for the native unsubscribe, since an
       * exit while the kqueue watcher thread runs crashes (SIGABRT). */
      return subscription.then(
        sub => sub.unsubscribe(),
        () => undefined
      );
    });
  }

  /** Read the file at tree path `filename` into an FSFile, hashing it, and
   * copying it into the pool where there is one. Resolves to undefined where
   * no file is there: the path is gone or names a directory. Called by
   * {@link TreeQuery}; {@link SourceFileSource} overrides it. */
  public ingest(filename: string): Computable<FSFile | undefined> {
    const filepath = path.resolve(this.root, filename);
    const pool = this.pool;
    const ingested =
      pool === undefined
        ? hashFile(filepath).then(({ hash, mime }) => stat(filepath).then(stats => new FSFile(this.root, filename, stats, hash, mime)))
        : readFileBuffer(filepath).then(bytes =>
            stat(filepath).then(stats => {
              const hash = hashString(bytes);
              return pool
                .ensureBlob(hash, bytes, fileModeOf(stats))
                .then(blobPath => new FSFile(this.root, filename, stats, hash, sniffMime(bytes), blobPath));
            })
          );
    return ingested.catch(err => {
      /* Gone since the event (a save by rename), or a directory: no file. A
       * later event adds a file that appears. */
      if (isNotFound(err) || isDirectoryError(err)) {
        return undefined;
      }
      throw err;
    });
  }

  /** Get the file at `name`, relative to the root or absolute, or undefined
   * where there is none: a query over the literal path ({@link enumerateFile}),
   * never expanding a directory there. Under watch it follows the path, so an
   * edit settles it again and a file created there later fills it. */
  public get(name: string): ComputableSource<IFile | undefined> {
    const target = toPosix(path.relative(this.root, path.resolve(this.root, name)));
    const literal = Name.fromLiteral(target);
    return this.query(
      `get ${target}`,
      () => new TreeQuery(this, this.root, literal, "", () => enumerateFile(this.root, literal))
    ).then(fileSet => fileSet.getSingleFile());
  }
}

export const FS = {
  /**
   * Open a FileSource over the directory `dirname`, or reject where it does
   * not exist.
   */
  get(dirname: string): Computable<FileSource> {
    return Computable.from<FileSource>((resolve, reject) => {
      if (fs.existsSync(dirname)) {
        resolve(new FSFileSource(dirname));
      } else {
        reject(new FabrError("No such path"));
      }
    });
  },
};

/** The name's compiled projection: a tree-relative path to its result name, or
 * undefined for a non-member. See {@link Name.makeProjector}. */
type Projector = (input: string) => string | undefined;

/**
 * The provenance step of content read from a directory tree: for each result
 * name, the path under the tree it was read from, recorded as the projection
 * names it (a projection cannot be inverted: `pkg/src:**\/*.ts` strips a
 * prefix, a rename rewrites). For the project's own tree it gives each file's
 * source path, `./<path>`, which a write-back uses to find where the file
 * belongs.
 */
export const SOURCE_TREE_PROVENANCE = "source-tree";

interface ISourceTreeOrigin extends IProvenanceStep {
  readonly kind: typeof SOURCE_TREE_PROVENANCE;
  /** What a file's path under the tree is prefixed with to make its source
   *  path; undefined for a tree no reference addresses. */
  readonly sourcePathPrefix: string | undefined;
  /** Result name → the path under the tree it was read from. */
  readonly paths: ReadonlyMap<string, string>;
}

registerProvenanceNaming<ISourceTreeOrigin>(SOURCE_TREE_PROVENANCE, {
  sourcePath: ({ sourcePathPrefix, paths }, name) => {
    const rel = paths.get(name);
    return rel === undefined || sourcePathPrefix === undefined ? undefined : `${sourcePathPrefix}${rel}`;
  },
  digest: ({ sourcePathPrefix, paths }, names) => {
    return sourcePathPrefix === undefined
      ? ""
      : namingDigest(SOURCE_TREE_PROVENANCE, `${JSON.stringify(sourcePathPrefix)} ${renamingText(restrictedTo(paths, names))}`, "");
  },
});

/* Renders nothing, a file's display name being its path already; registered
 * so the chain shows no "(source-tree)" placeholder. */
registerProvenanceRenderer(SOURCE_TREE_PROVENANCE, () => []);

/** How many of a query's files are read at once when it reads many together. */
const INGEST_CONCURRENCY = 64;

/** One file's read: the file, `undefined` where the path holds no file, or the error the read failed with. */
interface IRead {
  readonly name: string;
  readonly file?: FSFile;
  readonly error?: Error;
}

/** Make a FileSet of a query's files, each named by the query's projection, carrying
 * the source-tree provenance that maps those names back to where they were read from. */
function buildFileSet(files: ReadonlyMap<string, FSFile>, project: Projector, sourcePathPrefix: string | undefined): FileSet {
  const content = new Map<string, IFile>();
  const paths = new Map<string, string>();
  for (const file of files.values()) {
    const name = project(file.name);
    if (name !== undefined) {
      content.set(name, file);
      paths.set(name, file.name);
    }
  }
  const origin: ISourceTreeOrigin = { kind: SOURCE_TREE_PROVENANCE, sourcePathPrefix, paths };
  return new FileSet(content, origin);
}

const WATCH_OPTIONS: parcelWatcher.Options = { ignore: ["**/node_modules/**", "**/.git/**"] };

/**
 * The native watch backend tried where the platform default fails to start:
 * kqueue on macOS, where FSEvents can refuse to start a stream; none
 * elsewhere. (@parcel/watcher's types omit "kqueue", which its binding
 * supports, hence the cast.)
 */
const FALLBACK_BACKEND: parcelWatcher.BackendType | undefined =
  process.platform === "darwin" ? ("kqueue" as unknown as parcelWatcher.BackendType) : undefined;

/**
 * Subscribe to `dir`, retrying once with {@link FALLBACK_BACKEND} where the
 * default backend fails to start (@parcel/watcher rejects rather than falling
 * back itself), and calling `onFallback` then.
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

/** Normalise an OS path to forward slashes so glob matching and FileSet names
 * are platform-independent. */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * @return the name's static leading path, its `:` read as a path separator:
 * the whole path for a literal name, the directory to walk for a glob.
 * Normalized (`.` and `..` resolved, repeated slashes collapsed), as the walk
 * names files, so a literal name written with a climb (`lib/../tool/run.sh`)
 * agrees with its projection. A containment check judges this path (see
 * SourceFileSource.find): it is all of the name that decides where a query
 * reads. Which files are members, and their names, is the projection's
 * ({@link Name.makeProjector}).
 */
export function staticPath(name: Name): string {
  const literal = name.getLiteralPathPrefix().replaceAll(":", "/");
  if (literal === "") {
    return "";
  }
  const normalized = path.posix.normalize(literal);
  return normalized === "." || normalized === "./" ? "" : normalized;
}

/**
 * Enumerate the files under `root` selected by `name`, returning the matching
 * root-relative paths and the name's projection (which filters and names them —
 * reused so enumeration and watching agree). A plain file matches itself; a bare
 * directory means every file beneath it (the name expands to `dir/**`). Only the
 * name's static base is walked, and node_modules/.git are skipped.
 */
function enumerate(root: string, name: Name, prefix: string): Computable<{ names: string[]; project: Projector }> {
  if (name.hasGlob()) {
    return walkGlob(root, name, prefix);
  }
  /* A non-glob name selects the path as a file or, where it is a directory,
   * every file under it; which holds can change, and the path may not exist
   * yet. So membership is always both, and `stat` only chooses what is read
   * now. A directory matched as the path itself reads as no file and drops
   * out (see FSFileSource.ingest). */
  const file = staticPath(name);
  const abs = path.resolve(root, file);
  /* Each case keeps a `-> tmpl` rename: `literal` renames the one file, and
   * `subtree` expands `dir -> out` to `dir/** -> out/**`, appending the
   * globstar to selector and template alike so the wildcard counts match. The
   * two never overlap (`dir` against `dir/…`). */
  const renameTo = name.getRenameTo();
  const subtreeName = renameTo ? name.appendGlobstar().withRenameTo(renameTo.appendGlobstar()) : name.appendGlobstar();
  const literal = name.makeProjector(prefix);
  const subtree = subtreeName.makeProjector(prefix);
  const project: Projector = rel => literal(rel) ?? subtree(rel);
  return stat(abs).then(
    fileStat =>
      fileStat.isFile() ? { names: [toPosix(file)], project } : walk(root, abs, project).then(names => ({ names, project })),
    /* Nothing there yet — an empty set a later create-event fills. */
    () => ({ names: [], project })
  );
}

/**
 * Enumerate the literal file for {@link FSFileSource.get}: the path where it
 * is a regular file, else nothing. The projection admits only the path itself,
 * so under watch a file created there later fills the query, and a directory
 * there reads as no file.
 */
function enumerateFile(root: string, name: Name): Computable<{ names: string[]; project: Projector }> {
  const file = staticPath(name);
  const abs = path.resolve(root, file);
  const project = name.makeProjector();
  return stat(abs).then(
    fileStat => ({ names: fileStat.isFile() ? [toPosix(file)] : [], project }),
    /* Nothing there yet — an empty set a later create-event fills. */
    () => ({ names: [], project })
  );
}

function walkGlob(root: string, name: Name, prefix: string): Computable<{ names: string[]; project: Projector }> {
  const project = name.makeProjector(prefix);
  const base = path.resolve(root, staticPath(name));
  return walk(root, base, project).then(names => ({ names, project }));
}

function walk(root: string, dir: string, project: Projector): Computable<string[]> {
  const names: string[] = [];
  /* Symlinked entries, kept after the walk where they resolve to a file:
   * `readdir` reports a symlink as neither file nor directory, but `stat` and
   * `ingest` follow it. A symlinked directory is not descended into
   * (walkTree's isDirectory test), which keeps the walk finite. */
  const links: string[] = [];
  return walkTree(
    dir,
    (entry, abs) => {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        return;
      }
      const rel = toPosix(path.relative(root, abs));
      if (project(rel) === undefined) {
        return;
      }
      (entry.isFile() ? names : links).push(rel);
    },
    /* Source scanning ignores dependency and VCS trees entirely. */
    entry => entry.name === "node_modules" || entry.name === ".git"
  ).then(() => (links.length === 0 ? names : resolveLinks(root, names, links)));
}

/** Add to `names` the `links` that resolve to regular files; a dangling link,
 * or one to a directory, drops out, as `ingest` judges it. */
function resolveLinks(root: string, names: string[], links: string[]): Computable<string[]> {
  return mapComputable(links, rel =>
    stat(path.resolve(root, rel)).then(
      fileStat => (fileStat.isFile() ? rel : undefined),
      () => undefined
    )
  ).then(resolved => names.concat(resolved.filter((rel): rel is string => rel !== undefined)));
}
