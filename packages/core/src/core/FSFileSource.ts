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
import { DEFAULT_FILE_MODE, FileSet, IFile, FileSource } from "./FileSet";
import { hashFile, isDirectoryError, isNotFound, readFile, readFileBuffer, stat, walkTree } from "./FSWrapper";
import { toError } from "./Errors";
import { PreparedUpdate, WatchController, WatchEntry } from "./WatchController";

export interface FSFileStats {
  size: number;
  mtime: Date;
  /** POSIX permission bits (low 12). Optional because some producers supply a
   * partial stat; absent ⇒ {@link DEFAULT_FILE_MODE}. `fs.Stats.mode` carries
   * the high type bits too, so it is masked to 0o7777 on read. */
  mode?: number;
}

export class FSFile implements IFile {
  private readonly root: string;
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

  public get mode(): number {
    return this.stat.mode === undefined ? DEFAULT_FILE_MODE : this.stat.mode & 0o7777;
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
export class TreeQuery extends ComputableSource<FileSet> implements WatchEntry {
  private readonly files = new Map<string, Computable<FSFile | undefined>>();
  /* The name's projection: decides membership (a matched path maps to a name,
   * undefined drops it) AND names the result — one derivation for enumeration,
   * live-change filtering and result naming alike. Built once the tree is
   * enumerated (a bare directory expands to its contents there). */
  private project: Projector = () => undefined;
  private lastManifest: string | undefined;
  /* The subscription is live from the moment we register (before enumeration
   * completes), and enumeration is async — so events can arrive while `project`
   * is still unknown. We buffer them here and replay them once enumeration lands,
   * rather than dropping them (which would lose a create in that window, or let
   * the stale enumeration snapshot resurrect a file deleted in it). */
  private enumerating = true;
  private readonly pendingEvents: [string, boolean][] = [];
  /* Bumped each attach; captured by that attach's async enumeration so a result
   * that lands after the query has detached (last dependant left) or reattached
   * (a newer enumeration is now authoritative) is discarded — see attach. */
  private attachGeneration = 0;

  constructor(
    private readonly owner: FSFileSource,
    private readonly root: string,
    private readonly name: Name,
    private readonly prefix: string,
    /* Injectable only so tests can drive the async enumeration window
     * deterministically; production leaves it undefined and uses the real tree
     * enumeration (see attach). */
    private readonly enumerator?: () => Computable<{ names: string[]; project: Projector }>
  ) {
    super();
  }

  protected override attach(): void {
    /* super.attach() moves us Detached -> Unresolved, i.e. pending — so a reattach
     * won't briefly serve the stale value while we re-enumerate the current tree
     * (picking up anything changed while unsubscribed) and settle. */
    super.attach();
    /* Capture this attach's generation. Enumeration is async, so its result can
     * land after we have since detached (last dependant left — a superseded watch
     * evaluation orphaning its subgraph) or reattached (a newer enumeration is now
     * authoritative). A superseded result must not mutate the shared
     * file/projection state under a newer attach — the base settle guard can't
     * cover that (the node is attached again), only the generation can; see
     * isCurrent for the split. */
    const generation = ++this.attachGeneration;
    this.owner.registerQuery(this);
    this.files.clear();
    this.enumerating = true;
    this.pendingEvents.length = 0;
    const enumerator = this.enumerator ?? (() => enumerate(this.root, this.name, this.prefix));
    enumerator().then(({ names, project }) => {
      if (!this.isCurrent(generation)) {
        return;
      }
      names.forEach(name => this.files.set(name, this.owner.ingest(name)));
      this.project = project;
      this.enumerating = false;
      /* Replay events that arrived during the enumeration window against the
       * now-known projection, before the first settle, so the delivered set is
       * current (buffered creates added, buffered deletes removed). */
      for (const [rel, removed] of this.pendingEvents) {
        this.applyDelta(rel, removed);
      }
      this.pendingEvents.length = 0;
      this.deliver(generation);
    }, err => {
      if (this.isCurrent(generation)) {
        this.settle(ComputableState.Error, toError(err));
      }
    });
  }

  protected override detach(): void {
    super.detach();
    this.owner.unregisterQuery(this);
  }

  /** Whether the attach that captured `generation` is still the live one. The
   * generation check is the load-bearing half for a *reattached* query — the node
   * is attached again, so the base settle guard passes; only the generation tells
   * a superseded enumeration from the authoritative one, keeping it from
   * clobbering the newer attach's file/projection state. The Detached check
   * short-circuits the work for an orphan that never reattached: its settle would
   * be dropped at the base anyway (settle is inert while Detached), but there is
   * no point ingesting/hashing files for a dead node. */
  private isCurrent(generation: number): boolean {
    return generation === this.attachGeneration && this.state !== ComputableState.Detached;
  }

  /** Apply a filesystem change: if `rel` is one of ours, update the file map and return
   * true (so the source schedules our re-settle); otherwise ignore it and return false. */
  public applyEvent(rel: string, removed: boolean): boolean {
    /* Before enumeration resolves the projection is unknown — buffer the event to
     * replay once it lands (see attach), rather than dropping it. Return false so
     * the source schedules no re-settle now; the enumeration's own deliver()
     * settles the up-to-date set. */
    if (this.enumerating) {
      this.pendingEvents.push([rel, removed]);
      return false;
    }
    return this.applyDelta(rel, removed);
  }

  /** Apply a change against the (known) projection: true iff it was one of ours. */
  private applyDelta(rel: string, removed: boolean): boolean {
    if (this.project(rel) === undefined) {
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
    return buildFileSet(this.files, this.project);
  }

  private deliver(generation: number): void {
    this.build().then(fileSet => {
      /* build() is a further async hop, so re-check: a detach/reattach between
       * enumeration and here must not settle this (stale) result. */
      if (!this.isCurrent(generation)) {
        return;
      }
      this.lastManifest = fileSet.toManifest();
      this.settle(ComputableState.Valid, fileSet);
    }, err => {
      if (this.isCurrent(generation)) {
        this.settle(ComputableState.Error, toError(err));
      }
    });
  }

  /** WatchController entry: rebuild from the (dispatcher-updated) files and, unless the
   * content is unchanged (a touch), prepare the batched re-settle. */
  public recompute(): Computable<PreparedUpdate | null> {
    return this.build().then(fileSet => {
      const manifest = fileSet.toManifest();
      if (manifest === this.lastManifest) {
        return null;
      }
      /* Advance the memo only when we actually commit the value (in settle), not
       * here in the prepare phase — so a batch that drops this update (a sibling
       * failed) leaves lastManifest matching the still-settled value, and the
       * next recompute sees the change rather than skipping it as unchanged. */
      return {
        invalidate: () => this.invalidate(),
        settle: () => {
          this.lastManifest = manifest;
          this.settle(ComputableState.Valid, fileSet);
        },
      };
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
    /* The name owns the projection (glob + alias-relative / rename naming);
     * this only supplies the tree to walk. The query is first expressed in
     * this source's namespace — results are named root-relative (see walk),
     * so an absolute head (a contributed lib file's reference) must shed the
     * root or the compiled matcher and the walked names would live in
     * different domains. The same normalization `get` applies to its path. */
    return new TreeQuery(this, this.root, name.rebase(this.root), prefix);
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
   * switch). Pinned exact at >=2.5.0: 2.4.1 can deadlock natively when the kqueue
   * fallback races a failing FSEvents start (upstream #187, fixed by #189 in 2.5.0 —
   * see KNOWN-ISSUES.md; the wedged process ignores every signal but SIGKILL).
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
  public ingest(filename: string): Computable<FSFile | undefined> {
    const filepath = path.resolve(this.root, filename);
    return hashFile(filepath)
      .then(hash => stat(filepath).then(stats => new FSFile(this.root, filename, stats, hash)))
      .catch(err => {
        /* Gone since the event fired (the save-rename dance), or the path is a
         * directory (a not-yet-existing reference whose entry itself surfaced as
         * an event — see enumerate's not-found branch): either way it is not a
         * file, so treat it as absent — a later create/change event re-adds real
         * files — never a hard error. */
        if (isNotFound(err) || isDirectoryError(err)) {
          return undefined;
        }
        throw err;
      });
  }

  public get(name: string): ComputableSource<IFile | undefined> {
    /* A single-file get is a query over the literal path (enumerateGlob's non-glob branch
     * stats one file), projected to that file — undefined when absent, per the FileSource
     * contract. When watching, a `.fabr` edit thus cascades (through the loader's memoized
     * parse) into a model reload. The name is normalised to a root-relative path, since
     * callers pass it either relative (the project entry) or absolute (a resolved include). */
    const target = toPosix(path.relative(this.root, path.resolve(this.root, name)));
    return new TreeQuery(this, this.root, Name.fromLiteral(target), "").then(fileSet => fileSet.getSingleFile());
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

/** The name's compiled projection: a tree-relative path to its result name, or
 * undefined for a non-member. See {@link Name.makeProjector}. */
type Projector = (input: string) => string | undefined;

/** Resolve a query's held files into a FileSet, each named by the query's
 * projection. Shared by the one-shot and live `find` paths. */
function buildFileSet(
  files: Map<string, Computable<FSFile | undefined>>,
  project: Projector
): Computable<FileSet> {
  return Computable.forAll(
    Array.from(files.values()),
    (...done: (FSFile | undefined)[]) =>
      new FileSet(
        done.reduce((result, file) => {
          const name = file ? project(file.name) : undefined;
          if (file && name !== undefined) {
            result.set(name, file);
          }
          return result;
        }, new Map<string, IFile>())
      )
  );
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

/** Normalise an OS path to forward slashes so glob matching and FileSet names
 * are platform-independent (matching chokidar's old behaviour). */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * The name's static leading path (its `:` alias separator is a path separator on
 * disk): the whole path for a literal name, the walk base for a glob. The
 * naming/membership rule stays on the {@link Name.makeProjector} projection.
 * Exported as the PATH interpretation of a name — what containment must judge
 * (see SourceFileSource.find): the facets and any glob remainder never reach
 * the walk base, so they play no part in where a query can land.
 *
 * The path is normalized (`.`/`..` resolved, separator runs collapsed): result
 * names live in canonical path space — the walk names files by their
 * normalized disk-relative path — so the single-file echo (`toPosix(staticPath)`)
 * and the containment judgment must be canonical too, or a literal name written
 * with a climb (`lib/../tool/run.sh`) would disagree with its own projection.
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
  /* A non-glob reference names either the path itself (when it's a file) or, when
   * it's a directory, everything beneath it — and which one holds can change over
   * the query's life, or be unknown when the path doesn't exist yet. So the
   * membership test is the SAME union in every case — the path, OR anything under
   * it — making live matching independent of the FS state at enumeration time;
   * `stat` only seeds the *initial* contents. A directory that matches the literal
   * side (its own create/modify event) ingests to `undefined` — a directory is
   * not a file — and drops out (see FSFileSource.ingest), so the set is exactly
   * the path-as-file or the directory's files, whichever materializes. This is
   * also what lets a bare reference to a not-yet-existing directory fill when its
   * children are later created. */
  const file = staticPath(name);
  const abs = path.resolve(root, file);
  /* The two membership cases each honor a `-> tmpl` rename. `literal` covers the
   * path-is-a-file case: `makeProjector` renames the single file it names (a
   * non-glob name's rename is a literal 0-wildcard template — Validate rejects a
   * mismatch). `subtree` covers the path-is-a-directory case: just as a bare `dir`
   * expands to `dir/**`, a bare `dir -> out` expands structure-preservingly to
   * `dir/** -> out/**`, so each file keeps its relative path under the new root
   * (append the globstar to selector AND template to keep the wildcard counts
   * balanced). A rename-free name gets the plain subtree glob. The two never
   * overlap (`dir` vs `dir/…`), so `??` is unambiguous. */
  const renameTo = name.getRenameTo();
  const subtreeName = renameTo
    ? name.appendGlobstar().withRenameTo(renameTo.appendGlobstar())
    : name.appendGlobstar();
  const literal = name.makeProjector(prefix);
  const subtree = subtreeName.makeProjector(prefix);
  const project: Projector = rel => literal(rel) ?? subtree(rel);
  return stat(abs).then(
    fileStat =>
      fileStat.isFile()
        ? { names: [toPosix(file)], project }
        : walk(root, abs, project).then(names => ({ names, project })),
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
  return walkTree(
    dir,
    (entry, abs) => {
      if (entry.isFile()) {
        const rel = toPosix(path.relative(root, abs));
        if (project(rel) !== undefined) {
          names.push(rel);
        }
      }
    },
    /* Source scanning ignores dependency and VCS trees entirely. */
    entry => entry.name === "node_modules" || entry.name === ".git"
  ).then(() => names);
}
