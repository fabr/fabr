/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable, Transform } from "stream";
import { PROJECT_FILENAME } from "./Constants";
import { Computable, ComputableHandle } from "./Computable";
import { FabrError, HttpStatusError, toError } from "./Errors";
import { FetchRole, headUrl, ICacheControl, openUrlStream, reportingProgress } from "./Fetch";
import { CANONICAL, DEFAULT_FILE_MODE, FileSet, IFile } from "./FileSet";

import {
  deleteFile,
  HASH_ALGORITHM,
  hashString,
  isNotDirectoryError,
  isNotFound,
  mkdir,
  readdir,
  readFile,
  readFileBuffer,
  readOnlyPermissions,
  realpath,
  rename,
  deleteTree,
  stat,
  symlink,
  updateFileTime,
  writeFile,
  writeFileAtomic,
} from "./FSWrapper";
import {
  ActionFileInputs,
  BuildAction,
  BuildResult,
  INarrowedDeps,
  manifestFileInputs,
  preciseActionKey,
  walkPackages,
} from "./BuildAction";
import {
  decodeName,
  DepsPath,
  DiscoveredDeps,
  encodeName,
  IManifestRow,
  ISourceIndexRow,
  joinDepsPath,
  manifestLine,
  ABSENT_PREFIX,
  parseDiscoveredDeps,
  parseManifestLine,
  parseRecordedBase,
  parseSourceIndex,
  sealRecordedBase,
  serializeDiscoveredDeps,
  serializeSourceIndex,
  splitDepsPath,
} from "./Manifest";
import { PackageFileSet } from "./PackageFileSet";
import { mapComputable, mapObject } from "../support/Functional";
import { registerTempTree, removeTempTree, writeFileSet } from "./Staging";
import { refuseSecrets } from "./SecretFile";
import { HostLink, SymlinkFile } from "./SymlinkFile";
import { computableFind } from "./WorkList";
import { admitted, IOutputHandle, ITaskReport, type TaskTracker } from "../support/Execute";
import { Semaphore } from "../support/Semaphore";
import { Diagnostic, Log } from "../support/Log";
import type { Credential } from "./Credential";
import { SNIFF_LENGTH, sniffMime } from "../support/Mime";
import { parseJson, toJsonObject } from "../support/Json";

/** A download request, made only where the cache holds no answer. */
export interface IFetchRequest {
  url: string;
  /** Request headers, such as authentication; not part of the key. */
  headers?: Record<string, string>;
  /** The credential that signs the request, asked again where the server answers 401; not part of the key. */
  credential?: Credential;
  /** Turn the response into the entry's files before it is recorded (see {@link BuildCache.getOrFetch}). */
  process: (content: Readable, ctx: IFetchContext) => Computable<FileSet>;
}

/** The services a fetch `process` callback is given beside the response stream.
 * Write large content through {@link createOutput}, not into the scratch dir. */
export interface IFetchContext {
  /** A cache-owned scratch dir the process may write files into. */
  readonly targetDir: string;
  /** Open a streaming write into the blob pool (see {@link BuildCache.getTemporaryWriteStream}). */
  readonly createOutput: () => IOutputHandle;
}

const DIAG_SERVING_STALE = Diagnostic.Warn<{ url: string; reason: string }>(
  "cannot refresh {url} ({reason}); serving the cached copy"
);

/** The shortest time a mutable entry is served without revalidation, whatever
 * its origin declares: 24 hours. */
export const MINIMUM_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/**
 * Options for {@link BuildCache.getOrFetch}. `immutable` (the default) declares
 * that the content never changes: it is cached forever and cache headers are
 * ignored. With `immutable: false` the entry follows HTTP caching: fresh for the
 * lifetime the origin declares but at least {@link MINIMUM_FRESHNESS_MS}, then
 * revalidated by a conditional GET. Use it for what an origin may replace under
 * one URL, such as a registry's version list or an object in S3.
 */
export interface FetchOptions {
  immutable?: boolean;
  /** What the request is for, which decides the admission queue it waits in
   *  (see core/Fetch.ts); a content transfer where absent. */
  role?: FetchRole;
  /** Revalidate now whatever the remaining freshness, for a caller that knows
   * the copy is stale (it lacks a version known to exist). */
  forceRevalidate?: boolean;
  /** The response header in which the origin states the document's digest
   * (`Docker-Content-Digest`). A held copy whose response stated one is
   * revalidated with a `HEAD` comparing it, instead of a conditional `GET`,
   * and fetched again only where the digest differs. */
  digestHeader?: string;
}

/**
 * A target key's build-state record, read back. Its parts describe one build
 * and are meaningful only together.
 *
 * Every part but `outputs` is absent where the record has none to give (never
 * recorded, or no longer readable). Without a base
 * {@link ActionContext.changedFiles} has no answer, and without
 * `incrementalState` the tool plans a cold build.
 */
export interface IBuildState {
  /** The build's non-discoverable inputs, by their staged names. Present
   * together with {@link IBuildState.discovered} or not at all: the two are one
   * diff base. */
  readonly inputs?: FileSet;
  /** The source path each of {@link IBuildState.inputs} had, where it had one,
   * by the same name. Present with `inputs`. */
  readonly inputSourcePaths?: ReadonlyMap<string, string>;
  /** What the build looked up among its discoverable inputs, found or not. */
  readonly discovered?: IDiscoveredBase;
  /** The files the build's tool asked to keep. */
  readonly incrementalState?: FileSet;
  /** The files the build produced. */
  readonly outputs: FileSet;
}

/**
 * A build's lookups among its discoverable inputs, read back: each file it
 * reached, named by the dependency path it was reached by, and the paths it
 * looked up that found nothing. A path in `absent` that resolves on a later
 * build is reported as added.
 */
export interface IDiscoveredBase {
  readonly files: FileSet;
  readonly absent: ReadonlyArray<string>;
}

/** What moved in a target key's inputs since its last successful build (see
 * {@link ActionContext.changedFiles}). Each list is sorted. */
export interface IChangedFiles {
  readonly added: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
}

/**
 * Write `changed` as the changes document handed to a step's tool: one line per
 * name, `<status>\t<name>`, as `git diff --name-status` writes it (`A` added,
 * `M` modified, `D` deleted), sorted by name in code-unit order. Names are the
 * staged names, unescaped: a staged name holds no control characters.
 *
 * Keep in step with the drivers' reader (js-tools' `parseChangesDocument`),
 * which cannot depend on core at runtime.
 */
export function toChangesDocument(changed: IChangedFiles): string {
  const lines = [
    ...changed.added.map((name): [string, string] => [name, "A"]),
    ...changed.changed.map((name): [string, string] => [name, "M"]),
    ...changed.deleted.map((name): [string, string] => [name, "D"]),
  ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return lines.map(([name, status]) => `${status}\t${name}\n`).join("");
}

/** A cache entry as read back from disk: its files, plus freshness metadata for
 * a mutable entry. */
interface ICacheEntry {
  files: FileSet;
  meta?: ICacheControl;
}

/** The result of demanding an action's entry (see {@link BuildCache.getOrCreateAction}). */
interface IActionOutcome {
  files: FileSet;
  /** True where this demand built the entry, false where it was served or joined. */
  created: boolean;
}

/** Options for demanding an entry (see {@link BuildCache.getOrCreate}). */
export interface ICreateOptions {
  /** Rebuild without looking up what is stored, then commit as usual. The step
   * is given no base to work from. An attempt already in flight for the key is
   * still joined. */
  force?: boolean;
  /** Rebuild without looking up what is stored, as {@link force} does, but give
   * the step the target key's base as an ordinary miss does. */
  retry?: boolean;
  /** The action's target key, under which its build-state record is kept.
   * Present for an action of a declared target. */
  targetKey?: string;
  /** The machine-wide execution funnel the entry's work is admitted through,
   * given to the step on its {@link ActionContext}. A caller with no step to run
   * (a resolution memo, a test) may omit it and gets a funnel that admits
   * everything. */
  processLimit?: Semaphore;
  /**
   * The action's discoverable inputs, present when the demanded key is an
   * anchor (a key without them): the step reports which of them it read, and
   * the entry is stored under the key that selection makes
   * ({@link preciseActionKey}), never under the anchor itself.
   */
  discoverable?: ActionFileInputs;
}

/* The files of a build-state generation (see {@link BuildCache.readBuildState}).
 * `outputs` is a symlink to the entry manifest and `state` a manifest; `inputs`
 * holds the rows of the build's non-discoverable inputs, and `discovered` the
 * rows of the files it looked up among its discoverable inputs plus the paths
 * that found nothing. `discovered` is written, possibly empty, whenever
 * `inputs` is. */
const STATE_INPUTS_FILE = "inputs";
const STATE_DISCOVERED_FILE = "discovered";
/** The symlink naming a build-state record's current generation directory. A
 * reader resolves it once; a writer replaces it atomically. */
const STATE_CURRENT_LINK = "current";
const STATE_OUTPUTS_FILE = "outputs";
const STATE_STATE_FILE = "state";

/** The mark in a kept work dir's name, `<host>@<key>.<slot>` (see
 * {@link BuildCache.holdKeptWorkDir}). A host tag never contains it. */
const KEPT_MARK = "@";
/** Beside a kept work dir: the pid holding it, and the record of its contents. */
const KEPT_HOLD_SUFFIX = ".hold";
const KEPT_RECORD_SUFFIX = ".record";

/** The work trees this process has already taken ownership of, by path (see
 * {@link BuildCache.reclaimWorkTree}). */
const reclaimedRoots = new Set<string>();

const META_PREFIX = "!meta ";

/* A symlink manifest line: `@link <encodeURI(target)> <encodeURI(name)>`. A
 * regular file line starts with a hex content hash, so the two never collide. */
const LINK_PREFIX = "@link ";

/*
 * ── Trim policy ───────────────────────────────────────────────
 * Fixed constants, machine policy: none is read from a project.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Delete what has not been used in this long: 30 days, for every class of entry. */
const GC_MAX_AGE_MS = 30 * DAY_MS;
/** How long a project's source index keeps its source snapshots' blobs after
 * its last write. */
const GC_PROJECT_TTL_MS = 90 * DAY_MS;
/** Nothing whose mtime is within this window is ever deleted, whatever the policy. */
const GC_GRACE_MS = DAY_MS;
/** Collect at most once per interval, as the `gc/last` stamp records (written
 * only by a pass that proceeds). */
const GC_INTERVAL_MS = DAY_MS;
/** Refresh a recency mtime only when it is over this stale. */
const TOUCH_THROTTLE_MS = HOUR_MS;
/** How long a starting process waits for a live collection to finish before
 * proceeding anyway. */
const GC_HANDSHAKE_WAIT_MS = 10 * 60_000;
const GC_LAST_FILE = "last";
/** The prefix of a live collection's marker: an empty file named
 * `running-<host>-<pid>` for its owner. Each collector removes only its own. */
const GC_RUNNING_PREFIX = "running-";
const PROJECT_SOURCES_FILE = "sources";
/** An entry manifest's filename: a hashed key plus the suffix. */
const CLAIMED_MANIFEST = /^[0-9a-f]{64}\.manifest$/;

/** The tree pool, as a path from a step's working directory: through one
 * symlink beside it ({@link BuildCache.makeStepDir}), so a location reached
 * through it is relative and nothing under the working directory leads into
 * the pool. */
export const TREE_MOUNT = "../.fabr-tree";
/** The tree pool's link in a step's directory, beside its working directory. */
const TREE_LINK = ".fabr-tree";
/** A step's working directory, within the step's directory. */
const STEP_WORK_DIR = "work";

/**
 * The build cache: entries keyed by a hash of their key text, over a
 * content-addressed blob pool that also holds source snapshots and step
 * outputs. Beside them it keeps a tree pool, per-process work trees, kept work
 * dirs, discovered-deps records, per-target-key build state, per-project
 * source indexes and a secrets store, and trims them all daily.
 *
 * Invariant: a manifest present implies its blobs present. Only the trim
 * ({@link maybeCollectGarbage}) ever deletes a blob, so a reader may trust an
 * entry's manifest without checking its blobs. A new record that names blobs
 * must be marked by the trim or check presence before use ({@link presentBlob}),
 * and a new store needs an expiry rule in the trim.
 */
export class BuildCache {
  private readonly root: string;

  /* The stores, one resolved root each; each store's methods are grouped below
   * under a heading. */

  /** The entries: one `<hash>.manifest` per key (see {@link manifestPath}).
   * Keep them out of the root: it is an ancestor of every work dir, and a tool
   * resolving a file lists the directories above it. */
  private readonly entryRoot: string;

  /** The blob pool: one file per distinct content, named by its hash (see
   * {@link ensureBlob}). */
  private readonly blobRoot: string;
  /** The tree pool: one directory per tree written to disk, named by the manifest
   * hash of its contents (see {@link ensureTree}). */
  private readonly treeRoot: string;
  /** The parent of every process's work tree and every kept work dir. */
  private readonly workRoot: string;
  /** This process's work tree, which holds every transient the cache writes:
   * build-step work dirs, the temp files behind atomic writes, and the sandbox
   * `fabr shell` stages (see {@link reclaimWorkTree}). */
  private readonly ownWorkRoot: string;
  /** The discovered-deps records: one directory per anchor, one immutable file
   * per record. */
  private readonly depsRoot: string;
  /** The projects registry: one directory per (host, source root) holding that
   * project's source index (see {@link readSourceIndex}). */
  private readonly projectsRoot: string;
  /** The build-state records: one directory per target key (see
   * {@link writeBuildState}). */
  private readonly incrementalRoot: string;
  /** The secrets store: one file per record fetched with {@link getOrFetchSecret},
   * readable by this user alone. */
  private readonly secretsRoot: string;
  /** The clock for freshness and age decisions (injectable for tests); never a build input. */
  private readonly now: () => number;
  /** The driver's diagnostic log, for warnings such as serving a stale copy. */
  private readonly log: Log;

  /** The counter that makes temp names unique within this process's work tree. */
  private tempCounter = 0;
  /** Secret records currently being fetched, by hashed key: a second demand joins the first. */
  private readonly inflightSecrets = new Map<string, Computable<ISecretRecord>>();
  /** Entries currently being created, by lock key: a second demand joins the
   * first. This process only: two runs sharing a cache each build the entry. */
  private readonly inflight = new Map<string, Computable<FileSet>>();
  /** The entries read so far, by hashed key, so every demand in the run holds
   *  one FileSet. {@link cachePut} drops the key's entry. */
  private readonly held = new Map<string, ICacheEntry>();

  /** Trees currently being written, by name: a second demand joins the first. */
  private readonly inflightTrees = new Map<string, Computable<string>>();

  /** The latest generation begun for each target key, and the latest whose
   * build state has been written (see {@link beginBuildStateAttempt}). */
  private readonly stateGenerations = new Map<string, number>();
  private readonly statesWritten = new Map<string, number>();
  /** Per target key, the last build-state write queued: each write chains
   * behind it, so they land in generation order ({@link writeBuildState}). */
  private readonly pendingStateWrites = new Map<string, Computable<unknown>>();
  /** The number of build-state writes currently running (see {@link storeQuiescent}). */
  private activeStateWrites = 0;

  /* The session-served sets: the entry manifests, target keys, discovered-deps
   * record files and trees this process has served or written, each touched at
   * most once per session. Before a pass the trim refreshes the mtime of every
   * member but the trees ({@link replayServedTouches}): a value a long-lived
   * process holds is never demanded again, so it is touched no other way. A
   * tree needs no replay; it is used only on a miss, which calls
   * {@link ensureTree} again. */
  private readonly servedManifests = new Set<string>();
  private readonly servedTargetKeys = new Set<string>();
  private readonly servedDepsRecords = new Set<string>();
  private readonly servedTrees = new Set<string>();
  /** The working directories of the kept work dirs this process holds — see
   * {@link holdKeptWorkDir}. */
  private readonly heldKeptDirs = new Set<string>();
  /** The trim's own store: the `last` daily stamp and any live collection's
   * `running-<host>-<pid>` marker. */
  private readonly gcRoot: string;
  /** Revalidate every mutable entry once this run, whatever its freshness. */
  private readonly refresh: boolean;
  /** The keys of the mutable entries revalidated this run under {@link refresh}. */
  private readonly refreshed = new Set<string>();

  /**
   * Open the store at `cachePath`, taking ownership of this process's work tree
   * and waiting for any collection another live process is running.
   *
   * @param refresh revalidate every mutable fetched entry (`immutable: false`)
   * and every secret record once in this cache's life, whatever its freshness
   * (`--refresh`).
   */
  constructor(cachePath: string, log: Log, now: () => number = Date.now, refresh = false) {
    this.root = cachePath;
    this.entryRoot = path.resolve(cachePath, "entries");
    this.blobRoot = path.resolve(cachePath, "blob");
    this.treeRoot = path.resolve(cachePath, "tree");
    this.workRoot = path.resolve(cachePath, "work");
    this.ownWorkRoot = path.resolve(this.workRoot, ownerName());
    this.depsRoot = path.resolve(cachePath, "deps");
    this.projectsRoot = path.resolve(cachePath, "projects");
    this.incrementalRoot = path.resolve(cachePath, "incremental");
    this.gcRoot = path.resolve(cachePath, "gc");
    this.secretsRoot = path.resolve(cachePath, "secrets");
    this.log = log;
    this.now = now;
    this.refresh = refresh;
    /* Register this process's work tree before checking for a live collection:
     * a collector checks for work trees after placing its marker, so one of the
     * two always sees the other. */
    this.reclaimWorkTree();
    this.awaitRunningCollection();
  }

  /*
   * ── Work tree ───────────────────────────────────────────────
   * Everything transient, under one subtree per process: build-step scratch,
   * the temps behind every atomic write, and `fabr shell`'s sandbox. Reclaimed
   * at construction, removed on exit or by a later run once its process is gone.
   */

  /**
   * Take ownership of this process's work tree (`work/<host>-<pid>/`), emptying
   * it, and remove the work trees of this host's processes that are gone
   * (judged by `kill(pid, 0)`). Another host's work trees are never touched.
   * Registers the tree for removal on exit.
   */
  private reclaimWorkTree(): void {
    /* Once per root per process: a second BuildCache over the same store shares
     * this process's tree, and emptying it again would delete the first one's
     * work. */
    if (reclaimedRoots.has(this.ownWorkRoot)) {
      return;
    }
    reclaimedRoots.add(this.ownWorkRoot);
    try {
      fs.mkdirSync(this.workRoot, { recursive: true });
    } catch {
      /* Not fatal here: the mkdir below reports it. */
    }
    this.reapWorkTrees();
    /* A tree already at this path is a dead process's that had this pid. */
    try {
      fs.rmSync(this.ownWorkRoot, { recursive: true, force: true });
    } catch {
      /* Best-effort. */
    }
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    registerTempTree(this.ownWorkRoot);
  }

  /**
   * Make a fresh scratch directory in this process's work tree. Release it with
   * {@link releaseWorkDir}; this process's exit and a later run's reap remove
   * it otherwise.
   *
   * It is on the store's filesystem, so files staged into it can be hardlinks
   * to blobs.
   */
  public createWorkDir(prefix = "w-"): string {
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    return fs.mkdtempSync(path.join(this.ownWorkRoot, prefix));
  }

  /** Drop a directory from {@link createWorkDir}. Idempotent, best-effort. */
  public releaseWorkDir(dir: string): void {
    removeTempTree(dir);
  }

  /**
   * Lay out `dir` as a step's directory and return its working directory:
   * `work/`, with the tree pool's link beside it, reached from the working
   * directory as {@link TREE_MOUNT}. Nothing a tool finds by walking its
   * working directory leads into the pool. Idempotent; a link to another
   * cache's pool is replaced.
   */
  public makeStepDir(dir: string): string {
    const work = path.join(dir, STEP_WORK_DIR);
    fs.mkdirSync(work, { recursive: true });
    const link = path.join(dir, TREE_LINK);
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() && fs.readlinkSync(link) === this.treeRoot) {
      return work;
    }
    /* A directory a cache at another path laid out links to that cache's pool. */
    if (stat !== undefined) {
      fs.rmSync(link, { recursive: true, force: true });
    }
    fs.symlinkSync(this.treeRoot, link);
    return work;
  }

  /**
   * Hold a work dir that outlives this process, for work a later run continues,
   * and return its working directory.
   *
   * The slot taken is `work/<host>@<key>.<n>/`, the lowest `n` that no live
   * process (this one included) holds, made where it does not exist and laid
   * out as a step's directory ({@link makeStepDir}). Its working directory
   * holds whatever its last holder left there, as described by
   * {@link keptWorkDirRecord}; a slot with no working directory is emptied
   * first.
   *
   * The hold is the file `<slot>.hold`, naming this pid. It is dropped by
   * {@link releaseKeptWorkDir} or this process's exit; a holder that died
   * without either leaves the slot free. The trim removes a slot nobody holds
   * that has not been used for {@link GC_MAX_AGE_MS}.
   */
  public holdKeptWorkDir(key: string): string {
    fs.mkdirSync(this.workRoot, { recursive: true });
    for (let n = 0; ; n++) {
      const slot = path.resolve(this.workRoot, `${hostTag()}${KEPT_MARK}${key}.${n}`);
      const work = path.join(slot, STEP_WORK_DIR);
      if (this.heldKeptDirs.has(work) || !takeHold(`${slot}${KEPT_HOLD_SUFFIX}`, () => this.tempPath("hold"))) {
        continue;
      }
      if (this.heldKeptDirs.size === 0) {
        process.on("exit", () => this.releaseKeptWorkDirs());
      }
      this.heldKeptDirs.add(work);
      /* A slot with no working directory has its contents at its root, where a
       * step's layout cannot use them: drop them and their record. */
      if (fs.existsSync(slot) && !fs.existsSync(work)) {
        fs.rmSync(slot, { recursive: true, force: true });
        fs.rmSync(`${slot}${KEPT_RECORD_SUFFIX}`, { force: true });
      }
      this.makeStepDir(slot);
      this.touchForRecency(slot);
      return work;
    }
  }

  /** Drop this process's hold on a kept work dir, given as the working directory
   * {@link holdKeptWorkDir} returned, leaving its contents. */
  public releaseKeptWorkDir(dir: string): void {
    if (this.heldKeptDirs.delete(dir)) {
      fs.rmSync(`${path.dirname(dir)}${KEPT_HOLD_SUFFIX}`, { force: true });
    }
  }

  private releaseKeptWorkDirs(): void {
    for (const dir of [...this.heldKeptDirs]) {
      this.releaseKeptWorkDir(dir);
    }
  }

  /** Read the last recorded contents of a kept work dir, given as the working
   * directory {@link holdKeptWorkDir} returned (see {@link recordKeptWorkDir});
   * undefined where its contents are unknown. */
  public keptWorkDirRecord(dir: string): Computable<FileSet | undefined> {
    return this.readManifest(`${path.dirname(dir)}${KEPT_RECORD_SUFFIX}`).then(entry => entry?.files);
  }

  /** Record a kept work dir's contents, given as the working directory
   * {@link holdKeptWorkDir} returned, as `files`, or as unknown where `files`
   * is undefined. Record unknown before changing the dir and the new contents
   * after, so a change that never finished reads as unknown. */
  public recordKeptWorkDir(dir: string, files: FileSet | undefined): Computable<void> {
    const record = `${path.dirname(dir)}${KEPT_RECORD_SUFFIX}`;
    if (files === undefined) {
      return deleteFile(record).catch(() => undefined);
    }
    return this.storeManifest(record, files).then(() => undefined);
  }

  /** Make a unique temp path in this process's work tree, for a file written
   * there and then renamed into the store (the same filesystem). */
  private tempPath(what: string): string {
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    return path.join(this.ownWorkRoot, `${what}-${this.tempCounter++}`);
  }

  /** Write `content` to `target` atomically, through a temp in this process's work tree. */
  private writeFileAtomic(target: string, content: string): Computable<void> {
    let tmp: string;
    try {
      tmp = this.tempPath(path.basename(target));
    } catch (err) {
      return Computable.reject(toError(err));
    }
    return writeFileAtomic(target, content, tmp);
  }

  /**
   * Get the entry stored under the key text `cacheKey`, building it with
   * `create` where none is stored or the stored one is stale, and return its
   * files as stored (the same FileSet a later hit returns).
   *
   * `create` is called with an {@link ActionContext} around a fresh step
   * directory, and its result is committed under the key; where it rejects,
   * nothing is stored and the demand rejects. A concurrent demand for the same
   * key joins the attempt in flight. With {@link ICreateOptions.force} or
   * {@link ICreateOptions.retry} the lookup is skipped. With
   * {@link ICreateOptions.discoverable} the key is an anchor: the lookup tries
   * each key the anchor's discovered-deps records make, and the result is
   * stored under the key the step's reported reads make.
   */
  public getOrCreate(
    cacheKey: string,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet> {
    return this.demand(cacheKey, undefined, create, options);
  }

  /**
   * Get the entry for `action`, as {@link getOrCreate} does, with the key text,
   * discoverable inputs, change tracking and source-path inputs all read off the
   * action (`options.discoverable` is ignored). The outcome says whether this
   * demand built the entry.
   */
  public getOrCreateAction(
    action: BuildAction,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<IActionOutcome> {
    let created = false;
    const creating = (ctx: ActionContext): Computable<BuildResult> => {
      created = true;
      return create(ctx);
    };
    return this.demand(action.actionKey(), action, creating, options).then(files => ({ files, created }));
  }

  private demand(
    cacheKey: string,
    action: BuildAction | undefined,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet> {
    const anchorKey = hashString(cacheKey);
    const discoverable = action === undefined ? options?.discoverable : action.discoverable;
    /* Called by createEntry with the scratch dir it made. */
    const inContext = (targetDir: string): Computable<BuildResult> =>
      create(
        new ActionContext(
          this,
          options?.processLimit ?? UNBOUNDED_FUNNEL,
          this.makeStepDir(targetDir),
          options?.targetKey,
          options?.force ?? false,
          action?.inputs,
          discoverable,
          action?.sourcePathInputs
        )
      );
    /* The entry's class, the key text's namespace, stamped into the manifest
     * header; nothing reads it. */
    const cls = keyClass(cacheKey);
    /* Lock on the anchor and the discoverable deps together: two demands can
     * share an anchor and differ in their discoverable deps (a superseded watch
     * cycle). The lock key need not match an entry key's format. */
    return this.withLock(discoverable === undefined ? anchorKey : hashString(anchorKey + manifestFileInputs(discoverable)), () => {
      if (options?.force || options?.retry) {
        return this.createEntry(anchorKey, inContext, options, undefined, action, discoverable, cls);
      }
      if (discoverable !== undefined) {
        return this.cacheGetDiscovered(anchorKey, discoverable, action?.sourcePathInputs ?? [], options?.targetKey).then(
          hit => hit ?? this.createEntry(anchorKey, inContext, options, undefined, action, discoverable, cls)
        );
      }
      return this.cacheGet(anchorKey).then(entry => {
        if (entry && isFresh(entry, this.now())) {
          this.noteEntryServed(anchorKey, options?.targetKey);
          return entry.files;
        }
        return this.createEntry(anchorKey, inContext, options, undefined, action, discoverable, cls);
      });
    });
  }

  /**
   * Look up the entry for an anchor, as {@link cacheGet} does a key: each of the
   * anchor's discovered-deps records is applied to the current discoverable
   * deps and the key it makes is looked up, in turn until one is held. Last,
   * the key with every discoverable dep read is looked up (where a run whose
   * tool reported nothing stored its entry).
   */
  private cacheGetDiscovered(
    anchorKey: string,
    discoverable: ActionFileInputs,
    sourcePathInputs: ReadonlyArray<string>,
    targetKey?: string
  ): Computable<FileSet | undefined> {
    const probe = (record: DiscoveredDeps, recordFile?: string): Computable<FileSet | undefined> => {
      const preciseKey = hashString(preciseActionKey(anchorKey, narrowDeps(discoverable, record, sourcePathInputs)));
      return this.cacheGet(preciseKey).then(entry => {
        if (entry !== undefined) {
          this.noteEntryServed(preciseKey, targetKey);
          if (recordFile !== undefined && !this.servedDepsRecords.has(recordFile)) {
            /* Touch the record that made the hit, so it ages with its entry. */
            this.servedDepsRecords.add(recordFile);
            this.touchForRecency(recordFile);
          }
        }
        return entry?.files;
      });
    };
    return this.discoveredDepsFiles(anchorKey)
      .then(files => computableFind(files, file => this.readDiscoveredDepsDoc(file).then(record => record && probe(record, file))))
      .then(hit => hit ?? probe(new Map()));
  }

  /**
   * Run `operation` as the one attempt at `key` in this process: a demand while
   * it runs joins it, and one after it settles starts a new attempt, so a
   * failure is retried rather than replayed. The attempt's outcome is held apart
   * from its chain ({@link settledFrom}).
   *
   * `key` must tell apart everything the answer depends on: for a
   * discovered-deps demand, the anchor and the discoverable deps together.
   */
  private withLock(key: string, operation: () => Computable<FileSet>): Computable<FileSet> {
    const running = this.inflight.get(key);
    if (running) {
      return running;
    }
    const result = settledFrom(operation());
    this.inflight.set(key, result);
    result.finally(() => this.inflight.delete(key));
    return result;
  }

  /**
   * Get the download `cacheKey` identifies, fetching it where the cache holds
   * no fresh copy, and return its files as stored.
   *
   * The entry is keyed by `cacheKey` (the URL, or whatever identifies content
   * found only by reading metadata) and `tag`, a stable `name:version` for what
   * `process` does to the response; bump `tag` when that changes. `request` is
   * called only on a miss, so a hit reads nothing it would need. The request's
   * `process` turns the response stream into the entry's files (unpacking an
   * archive, validating a document) before anything is recorded: throw there on
   * invalid content to keep an error response out of the cache.
   *
   * By default a stored download is never refreshed. With `immutable: false`
   * the entry follows HTTP caching (see {@link FetchOptions}), and under the
   * cache's `refresh` is revalidated the first time it is asked for. A fetch
   * with no copy to fall back on is retried twice where it fails transiently;
   * one with a held copy serves that copy with a warning instead. Any other
   * failure rejects.
   */
  public getOrFetch(
    cacheKey: string,
    tag: string,
    request: () => Computable<IFetchRequest>,
    /** Track the transfer of the URL as the caller's task, on a miss only; byte
     * progress is reported on the task's report. */
    track: (url: string) => TaskTracker<FileSet>,
    options?: FetchOptions
  ): Computable<FileSet> {
    const key = hashString(`fetch:${tag} ${cacheKey}`);
    return this.withLock(key, () =>
      this.cacheGet(key).then(entry => {
        if (entry && isFresh(entry, this.now()) && !options?.forceRevalidate && !this.mustRefresh(key, entry)) {
          this.noteEntryServed(key);
          return entry.files;
        }
        if (this.refresh) {
          this.refreshed.add(key);
        }
        return request().then(made => this.fetch(key, made, track(made.url), entry, options));
      })
    );
  }

  /** @return true if `entry`, a fetched entry under `key`, is mutable and not
   * yet revalidated this run under {@link refresh}, otherwise false. */
  private mustRefresh(key: string, entry: ICacheEntry): boolean {
    return this.refresh && entry.meta !== undefined && !this.refreshed.has(key);
  }

  /*
   * ── Secrets store ───────────────────────────────────────────
   * Records whose content must not enter the shared pools, each a file of its
   * own named by its key, readable by this user alone. Fresh for
   * MINIMUM_FRESHNESS_MS, and trimmed once past it.
   */

  /**
   * Get the record `cacheKey` and `tag` name (see {@link getOrFetch}) from the
   * secrets store, or fetch it with `fetch` where the store holds none, the one
   * it holds is over {@link MINIMUM_FRESHNESS_MS} old, or `--refresh` has not
   * yet refetched it this run. A concurrent demand joins the fetch in flight.
   * With no held record, a transient failure is retried twice; with one, a
   * transient failure serves it, with a warning naming `resource`. Any other
   * failure rejects.
   */
  public getOrFetchSecret(
    cacheKey: string,
    tag: string,
    resource: string,
    fetch: () => Computable<ISecretRecord>
  ): Computable<ISecretRecord> {
    const key = hashString(`secret:${tag} ${cacheKey}`);
    const running = this.inflightSecrets.get(key);
    if (running) {
      return running;
    }
    const file = path.resolve(this.secretsRoot, key);
    const held = readSecretRecord(file);
    if (held !== undefined && this.now() - held.mtimeMs < MINIMUM_FRESHNESS_MS && !(this.refresh && !this.refreshed.has(key))) {
      return Computable.resolve(held.record);
    }
    if (this.refresh) {
      this.refreshed.add(key);
    }
    const result = settledFrom(
      (held === undefined ? retryingTransient(fetch) : fetch()).then(
        record => this.writeSecretRecord(file, record).then(() => record),
        err => {
          if (held !== undefined && isTransientFetchError(err)) {
            this.log.log(DIAG_SERVING_STALE, { url: resource, reason: err instanceof Error ? err.message : String(err) });
            return held.record;
          }
          throw err;
        }
      )
    );
    this.inflightSecrets.set(key, result);
    result.finally(() => this.inflightSecrets.delete(key));
    return result;
  }

  /** Write `record` to `file` in the secrets store, atomically, readable by this user alone. */
  private writeSecretRecord(file: string, record: ISecretRecord): Computable<void> {
    let tmp: string;
    try {
      fs.mkdirSync(this.secretsRoot, { recursive: true, mode: SECRETS_DIR_MODE });
      fs.chmodSync(this.secretsRoot, SECRETS_DIR_MODE);
      tmp = this.tempPath("secret");
    } catch (err) {
      return Computable.reject(toError(err));
    }
    const text = JSON.stringify({ identity: record.identity, secret: record.secret, value: record.value.toString("base64") });
    /* Stamp it with the cache's clock, which freshness and the trim read it against. */
    return writeFile(tmp, text, { mode: SECRET_RECORD_MODE })
      .then(() => updateFileTime(tmp, new Date(this.now())))
      .then(() => rename(tmp, file));
  }

  /**
   * Fetch a missing or stale entry and store it under `key`. Where the held
   * copy carries validators the request is conditional: a 304 renews the held
   * copy's lifetime without running `process`, and new content replaces it. A
   * held copy with a digest, under `options.digestHeader`, is revalidated with
   * a `HEAD` instead, and fetched again only where the digest has changed.
   * Transient failures are handled as {@link getOrFetch} says.
   */
  private fetch(
    key: string,
    { url, headers, credential, process }: IFetchRequest,
    track: TaskTracker<FileSet>,
    entry: ICacheEntry | undefined,
    options: FetchOptions | undefined
  ): Computable<FileSet> {
    const validators: Record<string, string> = {};
    if (entry?.meta?.etag) {
      validators["if-none-match"] = entry.meta.etag;
    }
    if (entry?.meta?.lastModified) {
      validators["if-modified-since"] = entry.meta.lastModified;
    }
    const digestHeader = options?.digestHeader;
    const get = (): Computable<FileSet> =>
      openUrlStream(url, { ...headers, ...validators }, this.now, options?.role, digestHeader, credential).then(response => {
        const meta = options?.immutable !== false ? undefined : withMinimumFreshness(response.cacheControl, this.now());
        const stream = response.stream;
        if (stream) {
          /* Track the transfer as the caller's task, counting the body's bytes
           * against the declared size. */
          return this.createEntry(
            key,
            targetDir =>
              track(report =>
                process(
                  reportingProgress(stream, bytes =>
                    report.progress({ measure: "bytes", done: bytes, total: response.contentLength })
                  ),
                  { targetDir, createOutput: () => this.getTemporaryWriteStream() }
                )
              ).then(result => ({ result })),
            undefined,
            meta,
            undefined,
            undefined,
            "fetch"
          );
        }
        /* A 304, so the request was conditional and `entry` is held: store it
         * again to renew its lifetime. */
        return this.cachePut(key, entry!.files, meta, "fetch");
      });
    /* A copy held with its digest is revalidated by comparing it on a HEAD. */
    const held = entry?.meta?.digest;
    const attempt = (): Computable<FileSet> =>
      held !== undefined && digestHeader !== undefined
        ? headUrl(url, headers, digestHeader, this.now, options?.role, credential).then(control =>
            control.digest === held ? this.cachePut(key, entry!.files, withMinimumFreshness(control, this.now()), "fetch") : get()
          )
        : get();
    /* Retry the whole attempt, request and body, so a transfer that failed part
     * way starts again. With a held copy, serve it at once instead. */
    return (entry ? attempt() : retryingTransient(attempt)).catch(err => {
      if (entry && isTransientFetchError(err)) {
        /* Stale-if-error (RFC 9111), with a warning. Touch the copy as served,
         * so it does not age out while the origin cannot replace it. */
        this.log.log(DIAG_SERVING_STALE, { url, reason: err instanceof Error ? err.message : String(err) });
        this.noteEntryServed(key);
        return entry.files;
      }
      throw err;
    });
  }

  /*
   * ── Blob pool ───────────────────────────────────────────────
   * One read-only file per distinct content, named by its hash, holding the
   * bytes of every stored file. Placed by rename; removed only by the trim's
   * sweep.
   */

  /**
   * Store `bytes` as the blob `hash`, atomically, and return its path. An
   * existing blob is reused. The blob is read-only, and executable where `mode`
   * is (default non-executable).
   */
  public ensureBlob(hash: string, bytes: Buffer, mode: number = DEFAULT_FILE_MODE): Computable<string> {
    return this.materializeBlob(hash, mode, blobPath => {
      const tmp = this.tempPath("blob");
      return writeFile(tmp, bytes).then(() => this.renameIntoPool(tmp, blobPath));
    });
  }

  /**
   * Open a streaming write into the blob pool (see {@link IOutputHandle}): bytes
   * written to `stream` are hashed as they pass and spooled to a temp file.
   * `finalize(name, mode)` places it in the pool under its hash and resolves to
   * the stored file, its mime sniffed from the leading bytes; `discard` drops
   * it. A failure of either stream rejects `finalize`, and every rejection
   * comes after the temp file is removed.
   */
  public getTemporaryWriteStream(): IOutputHandle {
    const tmpPath = this.tempPath("stream");
    const hash = createHash(HASH_ALGORITHM);
    const fileStream = fs.createWriteStream(tmpPath);
    /* Capture the first error on either stream and reject finalize with it:
     * `pipe` unpipes on a destination error and `finish` never fires, so
     * waiting on `finish` alone would hang. */
    let firstError: Error | undefined;
    let pendingReject: ((err: Error) => void) | undefined;
    const recordError = (err: Error): void => {
      if (firstError) return;
      firstError = err;
      pendingReject?.(err);
    };
    /* A spool failure (ENOSPC) fails the returned stream too, so a writer fails
     * rather than waiting for a drain that never comes. */
    fileStream.on("error", err => {
      recordError(err);
      sink.destroy(err);
    });
    /* The leading bytes, kept as they pass, for finalize to sniff the mime from. */
    let head = Buffer.alloc(0);
    const sink = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        if (head.length < SNIFF_LENGTH) {
          head = Buffer.concat([head, chunk]).subarray(0, SNIFF_LENGTH);
        }
        cb(null, chunk);
      },
    });
    sink.on("error", recordError);
    sink.pipe(fileStream);
    /* Destroy both streams, then remove the temp file once the spool has
     * closed: `createWriteStream` opens asynchronously, and an open still in
     * flight would recreate a file removed before it. Removal is best-effort. */
    const teardown = (done: () => void): void => {
      const remove = (): void => {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          /* Best-effort. */
        }
        done();
      };
      /* Already closed, so no `close` is coming: remove now, or a second
       * teardown (a discard after a failed finalize) would hang. */
      if (fileStream.closed) {
        remove();
        return;
      }
      fileStream.once("close", remove);
      sink.destroy();
      fileStream.destroy();
    };
    return {
      stream: sink,
      finalize: (name: string, mode: number = DEFAULT_FILE_MODE): Computable<IFile> =>
        Computable.from<IFile>((resolve, reject) => {
          /* Reject only once the spool is torn down, so nothing of this output
           * (temp file or open fd) is left when the caller sees the failure. */
          const fail = (err: Error): void => teardown(() => reject(err));
          if (firstError) {
            fail(firstError);
            return;
          }
          pendingReject = fail;
          fileStream.once("finish", () => {
            pendingReject = undefined;
            const digest = hash.digest("hex");
            /* `mode` defaults to non-executable (a captured stdout); an unpacked
             * archive member passes its own mode. */
            this.materializeBlob(digest, mode, blobPath => this.renameIntoPool(tmpPath, blobPath)).then(
              () => resolve(new BuildFile(this.blobRoot, digest, name, mode, sniffMime(head))),
              /* A failed placement may leave the spool in place: tear it down. */
              fail
            );
          });
          sink.end();
        }),
      discard: (): Computable<void> => Computable.from<void>(resolve => teardown(() => resolve(undefined))),
    };
  }

  /**
   * Move the file at `sourcePath` into the pool as the blob `hash`, by rename,
   * and return the blob's path. `mode` decides only whether the blob is
   * executable; a file's own mode is kept in the manifest that names it.
   */
  private ingestFile(hash: string, sourcePath: string, mode: number): Computable<string> {
    return this.materializeBlob(hash, mode, blobPath => this.renameIntoPool(sourcePath, blobPath));
  }

  /**
   * Put the blob `hash` into the pool and return its path: an existing blob is
   * reused, otherwise `materialise` must place it atomically at the path it is
   * given. Concurrent writers of one hash write identical content, so no lock
   * is taken.
   *
   * The blob is made read-only, so a tool cannot write through a staged
   * hardlink into it, and executable where `mode` is or where it already was.
   */
  private materializeBlob(hash: string, mode: number, materialise: (blobPath: string) => Computable<void>): Computable<string> {
    const blobPath = path.resolve(this.blobRoot, hash);
    const held = fs.statSync(blobPath, { throwIfNoEntry: false });
    if (held !== undefined) {
      /* Only ever add the exec bit: byte-identical files with different modes
       * share this blob. */
      if (readOnlyPermissions(mode) & 0o111 && (held.mode & 0o111) === 0) {
        fs.chmodSync(blobPath, 0o555);
      }
      return Computable.resolve(blobPath);
    }
    return mkdir(this.blobRoot)
      .then(() => materialise(blobPath))
      .then(() => {
        /* Read the placed blob's mode: a concurrent writer of the same hash may
         * have won the rename and set exec, which must not be cleared. */
        const exec = (fs.statSync(blobPath).mode & 0o111) !== 0 || (readOnlyPermissions(mode) & 0o111) !== 0;
        fs.chmodSync(blobPath, exec ? 0o555 : 0o444);
        return blobPath;
      });
  }

  /** Move `from` to `blobPath` by rename. Where the rename fails but the blob
   * exists (another writer placed it), that is success; either way `from` is
   * removed. */
  private renameIntoPool(from: string, blobPath: string): Computable<void> {
    return rename(from, blobPath).catch(renameErr => {
      const won = fs.existsSync(blobPath);
      return deleteFile(from).finally(() => {
        if (!won) {
          throw renameErr;
        }
      });
    });
  }

  /*
   * ── Tree pool ───────────────────────────────────────────────
   * One directory per tree written to disk, named by the manifest hash of its
   * contents, its files hardlinked from the blob pool. Immutable, placed by
   * rename, aged out by the trim; a caller asks for a tree with
   * {@link ensureTree} each run, which rebuilds it if it was removed.
   */

  /** The tree pool's directory, as an absolute path. */
  public get treePath(): string {
    return this.treeRoot;
  }

  /**
   * Write `files` out as a tree and return its path, `tree/<H>`, where `H` is
   * the manifest hash of `files`. An existing tree is returned as it stands; a
   * missing one is written in this process's work tree and moved into place by
   * one rename, and where another writer placed it first, theirs is used. A
   * concurrent demand for the same tree joins the write in flight.
   *
   * The tree's files are hardlinks to blobs, so they carry the blobs' read-only
   * modes, not the modes the manifest records. Throws an internal error where a
   * file lives outside the cache or is a host program's link.
   *
   * Where a tree's symlinks point into other trees, write those trees first.
   */
  public ensureTree(files: FileSet): Computable<string> {
    /* Memoized on the FileSet. */
    const key = files.toManifestHash();
    const entry = path.resolve(this.treeRoot, key);
    if (fs.existsSync(entry)) {
      /* Touch the tree once per session: its mtime is its age for the trim. */
      if (!this.servedTrees.has(key)) {
        this.servedTrees.add(key);
        this.touchForRecency(entry);
      }
      return Computable.resolve(entry);
    }
    const running = this.inflightTrees.get(key);
    if (running) {
      return running;
    }
    const result = settledFrom(this.materializeTree(entry, files));
    this.inflightTrees.set(key, result);
    result.finally(() => this.inflightTrees.delete(key));
    return result;
  }

  /** Write the tree `files` in a work dir and move it to `entry` by rename;
   * where the rename fails because `entry` now exists, that is success. The
   * work dir is removed on every path. */
  private materializeTree(entry: string, files: FileSet): Computable<string> {
    /* Before anything exists to clean up. */
    this.assertNothingOwnedElsewhere(entry, files);
    const temp = this.createWorkDir("tree-");
    /* After the check above no file lives outside the cache, so storeContent
     * moves none. Give the stored view the origin of `files`: writeFileSet
     * names it in a case-collision error. */
    return (
      mkdir(this.treeRoot)
        .then(() => this.storeContent(files))
        .then(backed => writeFileSet(temp, files.origin === undefined ? backed : backed.withOrigin(files.origin)))
        .then(() =>
          rename(temp, entry).catch(err => {
            if (!fs.existsSync(entry)) {
              throw err;
            }
          })
        )
        /* On success the rename has already moved it. */
        .finally(() => this.releaseWorkDir(temp))
        .then(() => entry)
    );
  }

  /**
   * Build the entry: run `create` in a fresh scratch dir, then store its result
   * under `key` with the cache-control `meta`, and return the stored files.
   * Where `create` rejects, nothing is stored or recorded and any earlier
   * manifest stands. The scratch dir is removed on every path.
   *
   * With `discoverable`, `key` is the anchor: the entry is stored under the key
   * the run's reported reads make, and the reads are recorded under the anchor.
   * With a target key, the build-state record is written after the entry.
   */
  private createEntry(
    key: string,
    create: (targetDir: string) => Computable<BuildResult>,
    options?: ICreateOptions,
    meta?: ICacheControl,
    /** The demanded action, where there is one: the source of the recorded
     * inputs and the source-path inputs. */
    action?: BuildAction,
    discoverable?: ActionFileInputs,
    /** The entry's class (see {@link storeManifest}). */
    cls?: string
  ): Computable<FileSet> {
    const { targetKey } = options ?? {};
    const targetDir = this.createWorkDir();
    /* The miss writes the target key's record, so it needs no touch now, but
     * the trim's replay must still refresh it. */
    if (targetKey !== undefined) {
      this.servedTargetKeys.add(targetKey);
    }
    /* Take the generation at the miss, not the commit, so an attempt superseded
     * while it ran cannot replace a newer attempt's record. */
    const attempt = targetKey === undefined ? undefined : this.beginBuildStateAttempt(targetKey);
    return create(targetDir)
      .then(produced =>
        this.mergedSelection(
          discoverable === undefined ? undefined : produced.discoveredDeps,
          discoverable,
          targetKey,
          options?.force === true
        ).then(selection => {
          /* A step that reports no reads is taken to have read every
           * discoverable input whole (the empty selection), the key the lookup
           * tries last. */
          const narrowed =
            discoverable === undefined ? undefined : narrowDeps(discoverable, selection ?? new Map(), action?.sourcePathInputs);
          const entryKey = narrowed === undefined ? key : hashString(preciseActionKey(key, narrowed));
          /* The recorded base, made from the same inputs the key was: the rows
           * of the non-discoverable inputs, and the rows and absences the
           * discoverable inputs narrowed to. */
          const inputs =
            action?.trackChangedFiles !== true
              ? undefined
              : recordedInputs(action.inputs, Object.keys(discoverable ?? {}), action.sourcePathInputs);
          const discovered = inputs === undefined ? undefined : recordedDiscovered(narrowed);
          /* Store the entry first and the records after it, so no record names
           * an entry that was never stored. */
          return this.cachePut(entryKey, produced.result, meta, cls)
            .then(stored => (selection === undefined ? stored : this.recordDiscoveredDeps(key, selection).then(() => stored)))
            .then(stored =>
              targetKey === undefined
                ? stored
                : this.writeBuildState(targetKey, attempt!, entryKey, {
                    inputs,
                    discovered,
                    incrementalState: produced.incrementalState,
                  }).then(() => stored)
            );
        })
      )
      .finally(() => this.releaseWorkDir(targetDir));
  }

  /**
   * Extend a run's reported selection with every path the target key's last
   * successful build looked up, found or not. Use it because an incremental
   * run reads fewer files than a full one: its reads alone would narrow the
   * entry key and the recorded base from build to build.
   *
   * Returns `reported` unchanged where there is no target key or recorded
   * base, the build is forced, or the action has other than one discoverable
   * input (the record does not say which input a path belongs to).
   */
  private mergedSelection(
    reported: DiscoveredDeps | undefined,
    discoverable: ActionFileInputs | undefined,
    targetKey: string | undefined,
    force: boolean
  ): Computable<DiscoveredDeps | undefined> {
    const keys = discoverable === undefined ? [] : Object.keys(discoverable);
    if (reported === undefined || targetKey === undefined || force || keys.length !== 1) {
      return Computable.resolve(reported);
    }
    const input = keys[0];
    return this.readBuildState(targetKey).then(state => {
      if (state?.discovered === undefined) {
        return reported;
      }
      const held = new Map<string, DepsPath>();
      for (const [name] of state.discovered.files) {
        held.set(name, splitDepsPath(name));
      }
      for (const path of state.discovered.absent) {
        held.set(path, splitDepsPath(path));
      }
      for (const path of reported.get(input) ?? []) {
        held.set(joinDepsPath(path), path);
      }
      return new Map(reported).set(input, [...held.values()]);
    });
  }

  private manifestPath(key: string): string {
    return path.resolve(this.entryRoot, key + ".manifest");
  }

  /*
   * ── Discovered-deps records ───────────────────────────────────
   * What a successful run read of its discoverable deps, one directory per
   * anchor holding one immutable file per record, named by the hash of its
   * contents. Advisory: a damaged, stale or missing record costs a lookup,
   * never a wrong answer. A record no hit uses stops being touched, and ages
   * out.
   */

  /** Locate an anchor's discovered-deps records directory. */
  private discoveredDepsDir(anchor: string): string {
    return path.resolve(this.depsRoot, anchor);
  }

  /** List the record files under an anchor, in readdir order; empty for an anchor
   * with no directory. */
  private discoveredDepsFiles(anchor: string): Computable<string[]> {
    const dir = this.discoveredDepsDir(anchor);
    return readdir(dir).then(
      entries => entries.filter(entry => entry.isFile()).map(entry => path.join(dir, entry.name)),
      () => []
    );
  }

  /** Read one record file; undefined where it cannot be read or parsed. */
  private readDiscoveredDepsDoc(file: string): Computable<DiscoveredDeps | undefined> {
    return readFile(file)
      .then(data => parseDiscoveredDeps(data))
      .catch(() => undefined);
  }

  /**
   * Record under `anchor` what a successful run read of its discoverable deps:
   * the paths it read, not their content. An identical record already there is
   * kept. Never rejects.
   */
  private recordDiscoveredDeps(anchor: string, selection: DiscoveredDeps): Computable<void> {
    const body = serializeDiscoveredDeps(selection);
    const file = path.join(this.discoveredDepsDir(anchor), hashString(body));
    if (fs.existsSync(file)) {
      return Computable.resolve(undefined);
    }
    /* A failed write costs a rerun next time, and never fails the build. */
    return this.writeFileAtomic(file, body).catch(() => undefined);
  }

  /*
   * ── Projects registry ───────────────────────────────────────
   * Records per (host, source root): the source index, a project's stat cache.
   * Advisory: deleting them costs re-hashing, never a different build.
   */

  /** Locate a source root's records directory, `<host>-<hash of the real
   * root>`, and the real root path. A record's header names its root, which a
   * reader checks: two roots may share a directory name. */
  private projectDir(rootPath: string): { dir: string; root: string } {
    let root: string;
    try {
      root = fs.realpathSync(rootPath);
    } catch {
      root = path.resolve(rootPath);
    }
    return { dir: path.resolve(this.projectsRoot, `${hostTag()}-${hashString(root)}`), root };
  }

  /** Locate the source-index record within {@link projectDir}. */
  private projectRecord(rootPath: string): { file: string; root: string } {
    const { dir, root } = this.projectDir(rootPath);
    return { file: path.resolve(dir, PROJECT_SOURCES_FILE), root };
  }

  /**
   * Read the source index recorded for `rootPath`; undefined where it is
   * missing, damaged, made with another hash algorithm, or another root's.
   * Never rejects.
   */
  public readSourceIndex(rootPath: string): Computable<Map<string, ISourceIndexRow> | undefined> {
    const { file, root } = this.projectRecord(rootPath);
    return readFile(file).then(
      text => {
        const parsed = parseSourceIndex(text);
        return parsed !== undefined && parsed.meta.algorithm === HASH_ALGORITHM && parsed.meta.root === root ? parsed.rows : undefined;
      },
      () => undefined
    );
  }

  /**
   * Replace `rootPath`'s source index with `rows`, atomically, resolving to
   * true where it was written and false where it failed. `rows` is serialized
   * before this returns, so the caller may go on changing it. Never rejects.
   */
  public writeSourceIndex(rootPath: string, rows: ReadonlyMap<string, ISourceIndexRow>): Computable<boolean> {
    const { file, root } = this.projectRecord(rootPath);
    const body = serializeSourceIndex({ root, algorithm: HASH_ALGORITHM, writtenAt: this.now() }, rows);
    return this.writeFileAtomic(file, body).then(
      () => true,
      () => false
    );
  }

  /** Look up the path of the blob `hash`; undefined where the pool does not hold
   * it. Use it before trusting a blob a record names that the trim does not
   * keep alive, such as a source index row. */
  public presentBlob(hash: string): string | undefined {
    const blobPath = path.resolve(this.blobRoot, hash);
    return fs.existsSync(blobPath) ? blobPath : undefined;
  }

  /*
   * ── Incremental state ───────────────────────────────────────
   * One build-state record per target key, describing its last successful
   * build: the inputs it was made of, the entry it produced, and the files its
   * tool kept. The one mutable store. Each write makes a new generation
   * directory and replaces the `current` symlink to name it, atomically; a
   * reader resolves `current` once and reads every part from that generation,
   * so it never mixes two builds' parts. A generation is not changed once
   * named; the next write removes the old ones
   * ({@link sweepSupersededGenerations}).
   */

  /** Locate a target key's build-state record: a directory of generation
   * directories and the `current` symlink. */
  private buildStatePath(targetKey: string): string {
    return path.resolve(this.incrementalRoot, targetKey);
  }

  /**
   * Read the build state recorded for `targetKey`, from the one generation
   * `current` names.
   *
   * Resolves to undefined where there is no usable record: no `current`, or no
   * readable `outputs` (an entry removed since leaves its link dangling, and
   * the rest of the record then describes output that is gone). Otherwise
   * every other part is absent where its file is missing or damaged, and the
   * base (`inputs` with `discovered`) is given only where both parts read.
   * Rejects only on an IO failure other than a missing path (see
   * {@link readManifest}).
   */
  public readBuildState(targetKey: string): Computable<IBuildState | undefined> {
    return realpath(path.join(this.buildStatePath(targetKey), STATE_CURRENT_LINK)).then(
      dir => this.readBuildStateParts(dir),
      () => undefined
    );
  }

  private readBuildStateParts(dir: string): Computable<IBuildState | undefined> {
    return Computable.forAll(
      [
        this.readRecordFile(dir, STATE_OUTPUTS_FILE),
        this.readRecordText(dir, STATE_INPUTS_FILE),
        this.readRecordText(dir, STATE_DISCOVERED_FILE),
        this.readRecordFile(dir, STATE_STATE_FILE),
      ],
      (
        outputs: FileSet | undefined,
        inputsText: string | undefined,
        discoveredText: string | undefined,
        incrementalState: FileSet | undefined
      ): IBuildState | undefined => {
        if (outputs === undefined) {
          return undefined;
        }
        /* Give the base as both parts or neither: a diff over one part alone
         * would miss what moved in the other. */
        const inputs = inputsText === undefined ? undefined : parseRecordedBase(inputsText);
        const discovered = discoveredText === undefined ? undefined : parseRecordedBase(discoveredText);
        return {
          ...(inputs === undefined || discovered === undefined
            ? {}
            : {
                inputs: this.rowsAsFiles(inputs.rows),
                inputSourcePaths: new Map(
                  inputs.rows.flatMap(row => (row.extra === undefined ? [] : [[row.name, decodeName(row.extra)]]))
                ),
                discovered: { files: this.rowsAsFiles(discovered.rows), absent: discovered.absent },
              }),
          incrementalState,
          outputs,
        };
      }
    );
  }

  /** Make the rows of a recorded base into files, for comparing by hash only:
   * their blobs may not exist, so never read one. */
  private rowsAsFiles(rows: ReadonlyArray<IManifestRow>): FileSet {
    return new FileSet(
      new Map(rows.map(row => [row.name, new BuildFile(this.blobRoot, row.hash, row.name, row.mode, "")])),
      undefined,
      CANONICAL
    );
  }

  /** Read a record file as text; undefined where there is no file (ENOENT,
   * ENOTDIR). Any other IO failure rejects, as in {@link readManifest}. */
  private readRecordText(dir: string, name: string): Computable<string | undefined> {
    return readFile(path.join(dir, name)).then(
      text => text,
      err => {
        if (isNotFound(err) || isNotDirectoryError(err)) {
          return undefined;
        }
        throw err;
      }
    );
  }

  /**
   * Begin an attempt at `targetKey` and return its generation, to pass to
   * {@link writeBuildState}. Attempts at one target key may run concurrently
   * (a watch cycle's rebuild has a different anchor, so it is not joined);
   * a later generation's record is never replaced by an earlier one's.
   */
  public beginBuildStateAttempt(targetKey: string): number {
    const next = (this.stateGenerations.get(targetKey) ?? 0) + 1;
    this.stateGenerations.set(targetKey, next);
    return next;
  }

  /**
   * Record the build-state of attempt `generation` at `targetKey`: its base
   * (`inputs` and `discovered`, the rows {@link recordedInputs} and
   * {@link recordedDiscovered} make), the entry `entryKey` it produced, and its
   * tool's `incrementalState`. Store the entry first: the record links to it.
   *
   * Does nothing where `generation` is not newer than the last one recorded,
   * or where there is neither a base nor any kept state (an existing record is
   * then left as it is). Writes for one target key run one after another, in
   * the order they were made. A new generation directory is written in full
   * before `current` names it, so a failure leaves the previous record. Never
   * rejects: a failed write leaves the target key's next build cold.
   */
  public writeBuildState(
    targetKey: string,
    generation: number,
    entryKey: string,
    state: { inputs?: string; discovered?: string; incrementalState?: FileSet }
  ): Computable<void> {
    const { inputs, incrementalState } = state;
    if (generation <= (this.statesWritten.get(targetKey) ?? 0)) {
      return Computable.resolve(undefined);
    }
    this.statesWritten.set(targetKey, generation);
    /* The record exists only if there is something to keep: a lone
     * `outputs` link would say only what the action's own key already says. */
    if (inputs === undefined && withContent(incrementalState) === undefined) {
      return Computable.resolve(undefined);
    }
    const previous = this.pendingStateWrites.get(targetKey) ?? Computable.resolve(undefined);
    const write = previous.then(() => this.performStateWrite(targetKey, entryKey, state));
    this.pendingStateWrites.set(
      targetKey,
      write.then(
        () => undefined,
        () => undefined
      )
    );
    return write;
  }

  private performStateWrite(
    targetKey: string,
    entryKey: string,
    state: { inputs?: string; discovered?: string; incrementalState?: FileSet }
  ): Computable<void> {
    const { inputs, discovered, incrementalState } = state;
    const dir = this.buildStatePath(targetKey);
    let gen: string;
    try {
      fs.mkdirSync(dir, { recursive: true });
      gen = fs.mkdtempSync(path.join(dir, "g-"));
    } catch {
      return Computable.resolve(undefined);
    }
    this.activeStateWrites += 1;
    return this.finishStateWrite(dir, gen, entryKey, { inputs, discovered, incrementalState }).finally(() => {
      this.activeStateWrites -= 1;
    });
  }

  private finishStateWrite(
    dir: string,
    gen: string,
    entryKey: string,
    state: { inputs?: string; discovered?: string; incrementalState?: FileSet }
  ): Computable<void> {
    const { inputs, discovered } = state;
    const incrementalState = withContent(state.incrementalState);
    return (
      Computable.forAll(
        [
          /* Each base part is sealed with a trailing count, so a truncated copy
           * reads as no base rather than a shorter one. Its rows' blobs are not
           * stored. `discovered` is written, possibly empty, whenever `inputs`
           * is: a reader takes no base without both. */
          inputs === undefined
            ? Computable.resolve(undefined)
            : writeFile(path.join(gen, STATE_INPUTS_FILE), sealRecordedBase(inputs)),
          inputs === undefined
            ? Computable.resolve(undefined)
            : writeFile(path.join(gen, STATE_DISCOVERED_FILE), sealRecordedBase(discovered ?? "")),
          incrementalState === undefined
            ? Computable.resolve(undefined)
            : this.storeContent(incrementalState).then(stored => this.storeManifest(path.join(gen, STATE_STATE_FILE), stored)),
          /* Relative to the generation directory the link lives in. */
          symlink(path.relative(gen, this.manifestPath(entryKey)), path.join(gen, STATE_OUTPUTS_FILE)),
        ],
        () => undefined
      )
        /* mkdtemp makes it 0700; open it before `current` names it. */
        .then(() => fs.chmodSync(gen, 0o755))
        .then(() => {
          /* Rename a new symlink over `current`, so a reader resolves either the
           * old generation or the new one. */
          const tmp = path.join(dir, `.${path.basename(gen)}`);
          return symlink(path.basename(gen), tmp).then(() => rename(tmp, path.join(dir, STATE_CURRENT_LINK)));
        })
        .then(() => this.sweepSupersededGenerations(dir, path.basename(gen)))
        .catch(() => {
          /* A failed write costs the next build a cold start, and never fails
           * this one. */
          void deleteTree(gen).catch(() => undefined);
          return undefined;
        })
    );
  }

  /**
   * Remove everything in the record `dir` but `current` and the generation
   * `keep`. A symlink (a leftover rename temp) is removed at once; a file or
   * directory only once past {@link GC_GRACE_MS}, since another process may
   * still be writing that generation. Best-effort.
   */
  private sweepSupersededGenerations(dir: string, keep: string): Computable<void> {
    return readdir(dir).then(
      entries =>
        mapComputable(
          entries.filter(entry => entry.name !== STATE_CURRENT_LINK && entry.name !== keep),
          entry => {
            const target = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
              return deleteFile(target).catch(() => undefined);
            }
            return stat(target).then(
              st => (this.pastWindow(st.mtimeMs, 0) ? deleteTree(target).catch(() => undefined) : undefined),
              () => undefined
            );
          }
        ).then(() => undefined),
      () => undefined
    );
  }

  /**
   * Read the manifest `name` of a build-state generation; undefined where it is
   * missing (the `outputs` link dangling included), its path is broken
   * (ENOTDIR), or it is damaged. Any other IO failure rejects
   * ({@link readManifest}).
   */
  private readRecordFile(dir: string, name: string): Computable<FileSet | undefined> {
    return this.readManifest(path.join(dir, name)).then(entry => entry?.files);
  }

  /*
   * ── Entries ─────────────────────────────────────────────────
   * One `<hash>.manifest` per key in the entry store (see {@link manifestPath}),
   * naming the blobs that hold the bytes. A manifest is replaced only by
   * storing its key again (a revalidated fetch, a forced rebuild), atomically.
   */

  /** Read the entry stored under the hashed key, if any: its files, plus the
   * cache-control metadata of a mutable entry. The first read is held for the
   * run ({@link held}). A missing entry is found by the read failing, not
   * tested for first. */
  private cacheGet(key: string): Computable<ICacheEntry | undefined> {
    const held = this.held.get(key);
    if (held !== undefined) {
      return Computable.resolve(held);
    }
    return this.readManifest(this.manifestPath(key)).then(entry => {
      if (entry !== undefined) {
        this.held.set(key, entry);
      }
      return entry;
    });
  }

  /**
   * Read the manifest at `file`, the reader for every manifest the cache
   * stores. Resolves to undefined where there is none (ENOENT, or ENOTDIR for a
   * path through a file) or it is damaged; a damaged manifest is deleted, by
   * the path given, so through a symlink only the link goes. Any other IO
   * failure (permissions, a failing disk) rejects. Decide ENOENT and ENOTDIR
   * here: a rethrown fs error does not reliably keep its `code`.
   */
  private readManifest(file: string): Computable<ICacheEntry | undefined> {
    return readFile(file).then<ICacheEntry | undefined>(
      data => {
        try {
          return this.parseManifest(data);
        } catch {
          fs.rmSync(file, { force: true });
          return undefined;
        }
      },
      err => {
        if (isNotFound(err) || isNotDirectoryError(err)) {
          return undefined;
        }
        throw err;
      }
    );
  }

  /**
   * Store `files` as the entry under the hashed key: put the files into the
   * blob pool (files already there are left) and write the manifest, with the
   * cache-control `meta` of a mutable entry and the class `cls`. Returns the
   * stored files.
   */
  private cachePut(key: string, files: FileSet, meta?: ICacheControl, cls?: string): Computable<FileSet> {
    /* Served this session (its fresh manifest needs no touch); the next read is
     * of what is written now. */
    this.servedManifests.add(key);
    this.held.delete(key);
    return this.storeContent(files).then(stored => this.storeManifest(this.manifestPath(key), stored, meta, cls));
  }

  /**
   * Write the manifest of `files`, whose regular files are already in the blob
   * pool, to `manifestPath` atomically, and return the files as a later read
   * of it parses them (the same IFile kind either way).
   *
   * The first line is the `!meta` header: a JSON object holding the file count
   * `entries` ({@link parseManifest} requires it), a mutable entry's `meta`,
   * and the `class` (the key's namespace, `rule`/`memo`/`fetch`; unread, and
   * absent on a build-state record's manifests). Then one line per file: a
   * regular file as a {@link manifestLine} row (hash, the file's own mode,
   * name) with its mime as the trailing field, a symlink as an `@link` line
   * holding its target.
   */
  private storeManifest(manifestPath: string, files: FileSet, meta?: ICacheControl, cls?: string): Computable<FileSet> {
    let manifest = `${META_PREFIX}${JSON.stringify({ entries: files.size, ...(cls === undefined ? {} : { class: cls }), ...meta })}\n`;
    const backed = new Map<string, IFile>();
    for (const [name, file] of files) {
      if (file instanceof SymlinkFile) {
        manifest += `${LINK_PREFIX}${encodeName(file.target)} ${encodeName(name)}\n`;
        backed.set(name, file);
        continue;
      }
      /* The mime follows the name, which is encoded and so holds no space. */
      manifest += manifestLine(name, file.hash, file.mode, file.mime) + "\n";
      backed.set(name, new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime));
    }
    return this.writeFileAtomic(manifestPath, manifest).then(() => new FileSet(backed, undefined, CANONICAL));
  }

  /**
   * Throw an internal error where a file of the tree `entry` is a host
   * program's link, or lives at a path outside the blob pool that another
   * owner may still write to. Files in memory, blobs and symlinks pass.
   */
  private assertNothingOwnedElsewhere(entry: string, files: FileSet): void {
    for (const [name, file] of files) {
      if (file instanceof HostLink) {
        /* A tree is named by its content, and a link to where a host program
         * lies would go stale when the program moved. */
        throw new FabrError(`Internal error: cannot materialize the tree '${entry}' with '${name}', a program of the host`);
      }
      const abspath = file.getAbsPath();
      if (abspath !== undefined && !(file instanceof SymlinkFile) && abspath !== path.resolve(this.blobRoot, file.hash)) {
        throw new FabrError(
          `Internal error: cannot materialize the tree '${entry}' from '${name}', which lives outside the cache at '${abspath}'`
        );
      }
    }
  }

  /**
   * Put every file of `files` into the blob pool (a file in memory by its
   * bytes, a file on disk by moving it) and return them as blob-backed files.
   * Symlinks and files already in the pool pass through. Rejects where `files`
   * holds a secret. A step's work dir may be removed afterwards.
   */
  private storeContent(files: FileSet): Computable<FileSet> {
    try {
      refuseSecrets(files, "stored in the build cache");
    } catch (err) {
      return Computable.reject(toError(err));
    }
    return mapComputable(files, ([name, file]): [string, IFile] | Computable<[string, IFile]> => {
      if (file instanceof SymlinkFile) {
        /* A symlink has no blob: the manifest holds its target. */
        return [name, file];
      }
      if (file instanceof BuildFile && file.getAbsPath() === path.resolve(this.blobRoot, file.hash)) {
        /* Already a blob of this pool: nothing to store, not even a probe. */
        return [name, file.name === name ? file : new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime)];
      }
      const abspath = file.getAbsPath();
      const stored =
        abspath === undefined
          ? file.getBuffer().then(buffer => this.ensureBlob(file.hash, buffer, file.mode))
          : this.ingestFile(file.hash, abspath, file.mode);
      /* Keep the incoming file's mime: the store never reads content to sniff it. */
      return stored.then((): [string, IFile] => [name, new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime)]);
    }).then(entries => new FileSet(new Map(entries), undefined, CANONICAL));
  }

  /**
   * Parse a manifest as {@link storeManifest} writes it: the `!meta` header
   * line, then one line per file, `hash octalmode name mime` for a regular file
   * or `@link target name` for a symlink. Only the first line is read as the
   * header.
   *
   * Throws where the header is missing, a line is malformed (a regular file's
   * mime is required), or the header's `entries` count differs from the lines
   * read (a manifest cut short at a line boundary). The returned `meta` is the
   * header's freshness fields, absent for an immutable entry.
   */
  private parseManifest(data: string): ICacheEntry {
    const result = new Map();
    const end = data.length;
    if (!data.startsWith(META_PREFIX)) {
      throw new FabrError("Malformed cache manifest: no header line");
    }
    const eol = data.indexOf("\n");
    const header = JSON.parse(data.substring(META_PREFIX.length, eol < 0 ? end : eol)) as {
      entries?: unknown;
    } & Partial<ICacheControl>;
    let pos = eol < 0 ? end : eol + 1;
    /* Scan the text in place rather than splitting it: a large build reads
     * hundreds of thousands of these lines, and each intermediate string costs
     * one per file. */
    while (pos < end) {
      let eol = data.indexOf("\n", pos);
      if (eol < 0) {
        eol = end;
      }
      if (eol === pos) {
        pos = eol + 1;
        continue;
      }
      const line = data.substring(pos, eol);
      pos = eol + 1;
      if (line.startsWith(LINK_PREFIX)) {
        const rest = line.substring(LINK_PREFIX.length);
        const gap = rest.indexOf(" ");
        if (gap < 0) {
          throw new FabrError(`Malformed cache manifest link line: '${line}'`);
        }
        result.set(decodeName(rest.substring(gap + 1)), new SymlinkFile(decodeName(rest.substring(0, gap))));
        continue;
      }
      /* A {@link manifestLine} row, its trailing field the mime (required). */
      const entry = parseManifestLine(line);
      if (entry === undefined || entry.extra === undefined) {
        throw new FabrError(`Malformed cache manifest line: '${line}'`);
      }
      result.set(entry.name, new BuildFile(this.blobRoot, entry.hash, entry.name, entry.mode, entry.extra));
    }
    if (header.entries !== result.size) {
      throw new FabrError(`Malformed cache manifest: header claims ${String(header.entries)} entries, read ${result.size}`);
    }
    const { expires, etag, lastModified, digest } = header;
    /* Written from a canonical FileSet, so its names are taken as canonical. */
    return {
      files: new FileSet(result, undefined, CANONICAL),
      meta: expires === undefined ? undefined : { expires, etag, lastModified, ...(digest === undefined ? {} : { digest }) },
    };
  }

  /*
   * ── Garbage collection ──────────────────────────────────────
   * The trim: expire, then mark, then sweep, over every store. It runs at most
   * once per {@link GC_INTERVAL_MS}, only where this is the one live fabr on
   * the host and no store-changing work is in flight ({@link storeQuiescent}),
   * and stops at the next step where work starts or the caller aborts.
   *
   * It keeps the invariant that a manifest present implies its blobs present:
   * manifests and records expire first, and a blob is swept only where no
   * surviving one names it, so stopping or crashing at any point leaves the
   * store consistent. Every removal is best-effort.
   */

  /**
   * Run the trim if it is due (one stat when it is not), and resolve when it
   * ends or is skipped. The trim also skips itself while another fabr is live
   * or work is in flight. Never rejects.
   */
  public maybeCollectGarbage(options?: ICollectOptions): Computable<void> {
    return Computable.from(resolve => {
      this.collectGarbage(options?.shouldAbort ?? ((): boolean => false)).then(
        () => resolve(undefined),
        () => resolve(undefined)
      );
    });
  }

  private async collectGarbage(shouldAbort: () => boolean): Promise<void> {
    if (!this.gcDue()) {
      return;
    }
    /* Stop where the caller asks or work has started. */
    const abort = (): boolean => shouldAbort() || !this.storeQuiescent();
    fs.mkdirSync(this.gcRoot, { recursive: true });
    /* Place the marker before checking for other processes: a starting process
     * registers its work tree before checking for markers, so one of the two
     * always sees the other (see {@link awaitRunningCollection}). */
    const marker = path.join(this.gcRoot, `${GC_RUNNING_PREFIX}${hostTag()}-${process.pid}`);
    fs.writeFileSync(marker, "");
    try {
      /* Skip without writing `gc/last`, so a later call tries again. */
      if (!this.soleLiveFabr() || !this.storeQuiescent()) {
        return;
      }
      fs.writeFileSync(path.join(this.gcRoot, GC_LAST_FILE), String(this.now()));
      await this.replayServedTouches();
      const rootedBlobs = await this.readProjectRecords(abort);
      if (abort()) {
        return;
      }
      await this.expireStores(abort);
      if (abort()) {
        return;
      }
      const reach = await this.markReachable(rootedBlobs, abort);
      /* Check again before the sweep, for a process that started since. */
      if (reach === undefined || abort() || !this.soleLiveFabr()) {
        return;
      }
      await this.sweepBlobs(reach.marked, reach.present, abort);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  }

  /**
   * @return true if no entry attempt (a superseded one included), tree write or
   * build-state write is in flight, otherwise false. Source index writes do not
   * count: a reader checks a row's blob with {@link presentBlob}.
   */
  private storeQuiescent(): boolean {
    return this.inflight.size === 0 && this.inflightTrees.size === 0 && this.activeStateWrites === 0;
  }

  /** @return true if the `gc/last` stamp is older than {@link GC_INTERVAL_MS}
   * or missing, otherwise false. */
  private gcDue(): boolean {
    try {
      return this.now() - fs.statSync(path.join(this.gcRoot, GC_LAST_FILE)).mtimeMs > GC_INTERVAL_MS;
    } catch {
      return true;
    }
  }

  /**
   * @return true if this process is the only live fabr using the store,
   * otherwise false. Judged from the work trees under `work/`: another of this
   * host's work trees whose process is alive, or another host's work tree
   * changed within {@link GC_GRACE_MS}, means another fabr is live. Kept work
   * dirs are not counted.
   */
  private soleLiveFabr(): boolean {
    let owners: string[];
    try {
      owners = fs.readdirSync(this.workRoot);
    } catch {
      return true;
    }
    for (const owner of owners) {
      const dir = path.resolve(this.workRoot, owner);
      /* A kept work dir's holder has a work tree of its own. */
      if (dir === this.ownWorkRoot || keptDirOf(owner) !== undefined) {
        continue;
      }
      const pid = thisHostPid(owner);
      if (pid !== undefined) {
        if (isProcessAlive(pid)) {
          return false;
        }
      } else {
        try {
          if (this.now() - fs.statSync(dir).mtimeMs <= GC_GRACE_MS) {
            return false;
          }
        } catch {
          /* Gone since the listing: not live. */
        }
      }
    }
    return true;
  }

  /**
   * Block until no other live process of this host is running a collection,
   * or {@link GC_HANDSHAKE_WAIT_MS} has passed: this process then trusts that
   * a blob it sees stays present. A marker whose process is gone is removed.
   * Another host's markers, and this process's own (a second BuildCache over
   * one store, whose pass runs on this event loop), are ignored.
   */
  private awaitRunningCollection(): void {
    /* Real time, not the injectable clock: this bounds an actual wait. */
    const deadline = Date.now() + GC_HANDSHAKE_WAIT_MS;
    for (;;) {
      let live = false;
      let markers: string[];
      try {
        markers = fs.readdirSync(this.gcRoot).filter(name => name.startsWith(GC_RUNNING_PREFIX));
      } catch {
        return;
      }
      for (const name of markers) {
        const pid = thisHostPid(name.slice(GC_RUNNING_PREFIX.length));
        if (pid === undefined || pid === process.pid) {
          continue;
        }
        if (isProcessAlive(pid)) {
          live = true;
        } else {
          fs.rmSync(path.join(this.gcRoot, name), { force: true });
        }
      }
      if (!live || Date.now() > deadline) {
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  /**
   * Set `filepath`'s mtime, which the trim reads as when it was last used, to
   * now where it is over {@link TOUCH_THROTTLE_MS} old. Not waited for; a
   * failure (the path is gone) is ignored.
   */
  private touchForRecency(filepath: string): void {
    stat(filepath)
      .then(st => (this.now() - st.mtimeMs > TOUCH_THROTTLE_MS ? updateFileTime(filepath, new Date(this.now())) : undefined))
      .catch(() => undefined);
  }

  /**
   * Record that the entry `key` was served from the store: add it, and
   * `targetKey` where given, to the session-served sets, touching the
   * manifest and the target key's build-state record the first time each is
   * added. A stored entry is recorded by {@link cachePut} instead.
   */
  private noteEntryServed(key: string, targetKey?: string): void {
    if (!this.servedManifests.has(key)) {
      this.servedManifests.add(key);
      this.touchForRecency(this.manifestPath(key));
    }
    if (targetKey !== undefined && !this.servedTargetKeys.has(targetKey)) {
      this.servedTargetKeys.add(targetKey);
      this.touchForRecency(this.buildStatePath(targetKey));
    }
  }

  /** Set the mtime of every session-served manifest, build-state record and
   * discovered-deps record to now, unthrottled, before a pass: a value a
   * long-lived process holds is not demanded again, so is touched no other
   * way. */
  private async replayServedTouches(): Promise<void> {
    const when = new Date(this.now());
    const paths = [
      ...[...this.servedManifests].map(key => this.manifestPath(key)),
      ...[...this.servedTargetKeys].map(key => this.buildStatePath(key)),
      ...this.servedDepsRecords,
    ];
    for (const filepath of paths) {
      await updateFileTime(filepath, when).catch(() => undefined);
    }
  }

  /**
   * Expire the projects registry and return the blob hashes its surviving
   * source indexes keep. A `sources` record past {@link GC_PROJECT_TTL_MS} is
   * deleted, as is any other file past {@link GC_GRACE_MS}. A surviving
   * index's rows are kept where its project is live: for this host, its
   * recorded root still holds a PROJECT.fabr; another host's are always kept.
   * Emptied project directories are removed.
   */
  private async readProjectRecords(shouldAbort: () => boolean): Promise<Set<string>> {
    const rootedBlobs = new Set<string>();
    const owners = await readdir(this.projectsRoot).catch(() => [] as fs.Dirent[]);
    for (const owner of owners) {
      if (shouldAbort()) {
        break;
      }
      const dir = path.resolve(this.projectsRoot, owner.name);
      if (!owner.isDirectory()) {
        await this.removeIfPast(dir, 0);
        continue;
      }
      const split = owner.name.lastIndexOf("-");
      const validated = split >= 0 && owner.name.slice(0, split) === hostTag();
      const live = (root: string): boolean => !validated || fs.existsSync(path.join(root, PROJECT_FILENAME));
      for (const record of await readdir(dir).catch(() => [] as fs.Dirent[])) {
        const file = path.join(dir, record.name);
        const st = await stat(file).catch(() => undefined);
        if (st === undefined) {
          continue;
        }
        if (record.name === PROJECT_SOURCES_FILE) {
          if (this.pastWindow(st.mtimeMs, GC_PROJECT_TTL_MS)) {
            await deleteFile(file).catch(() => undefined);
            continue;
          }
          const text = await readFile(file).catch(() => undefined);
          const parsed = text === undefined ? undefined : parseSourceIndex(text);
          if (parsed !== undefined && live(parsed.meta.root)) {
            for (const row of parsed.rows.values()) {
              rootedBlobs.add(row.hash);
            }
          }
        } else {
          await this.removeIfPast(file, 0);
        }
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        /* Not empty. */
      }
    }
    return rootedBlobs;
  }

  /**
   * Run the expire step: delete entry manifests, build-state records,
   * discovered-deps records (and emptied anchor directories), trees and unheld
   * kept work dirs not used for {@link GC_MAX_AGE_MS}; secret records over
   * {@link MINIMUM_FRESHNESS_MS} old; every entry manifest at the store's root;
   * and the work trees of this host's dead processes. Nothing else at the
   * root is touched.
   */
  private async expireStores(shouldAbort: () => boolean): Promise<void> {
    for (const entry of await readdir(this.entryRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      if (CLAIMED_MANIFEST.test(entry.name) && entry.isFile()) {
        await this.removeIfPast(path.resolve(this.entryRoot, entry.name), GC_MAX_AGE_MS);
      }
    }
    /* A manifest at the root is never read, and the mark step keeps nothing it
     * names. */
    for (const entry of await readdir(this.root).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      if (CLAIMED_MANIFEST.test(entry.name) && entry.isFile()) {
        await deleteFile(path.resolve(this.root, entry.name)).catch(() => undefined);
      }
    }
    for (const record of await readdir(this.incrementalRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      await this.removeIfPast(path.resolve(this.incrementalRoot, record.name), GC_MAX_AGE_MS);
    }
    for (const anchor of await readdir(this.depsRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      const anchorDir = path.resolve(this.depsRoot, anchor.name);
      for (const record of await readdir(anchorDir).catch(() => [] as fs.Dirent[])) {
        await this.removeIfPast(path.join(anchorDir, record.name), GC_MAX_AGE_MS);
      }
      try {
        fs.rmdirSync(anchorDir);
      } catch {
        /* Not empty. */
      }
    }
    for (const tree of await readdir(this.treeRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      await this.removeIfPast(path.resolve(this.treeRoot, tree.name), GC_MAX_AGE_MS);
    }
    for (const record of await readdir(this.secretsRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      await this.removeIfPast(path.resolve(this.secretsRoot, record.name), MINIMUM_FRESHNESS_MS);
    }
    await this.expireKeptWorkDirs(shouldAbort);
    this.reapWorkTrees();
  }

  /** Remove this host's kept work dirs that nobody holds and nobody has used
   * for {@link GC_MAX_AGE_MS}, with their records and hold files. */
  private async expireKeptWorkDirs(shouldAbort: () => boolean): Promise<void> {
    for (const entry of await readdir(this.workRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return;
      }
      if (!entry.isDirectory() || keptDirOf(entry.name) !== entry.name) {
        continue;
      }
      const dir = path.resolve(this.workRoot, entry.name);
      if (holderOf(`${dir}${KEPT_HOLD_SUFFIX}`) !== undefined) {
        continue;
      }
      const st = await stat(dir).catch(() => undefined);
      if (st !== undefined && this.pastWindow(st.mtimeMs, GC_MAX_AGE_MS)) {
        await deleteFile(`${dir}${KEPT_RECORD_SUFFIX}`).catch(() => undefined);
        await deleteTree(dir).catch(() => undefined);
        await deleteFile(`${dir}${KEPT_HOLD_SUFFIX}`).catch(() => undefined);
      }
    }
  }

  /**
   * Run the mark step: collect the blob hashes named by every surviving entry
   * manifest and by the `state` manifest of every build-state record's current
   * generation, starting from `rootedBlobs`. An entry manifest that does not
   * parse or names a missing blob is deleted, as is a build-state record whose
   * `state` manifest does. A record's `inputs` and `discovered` rows keep no
   * blobs.
   *
   * @return the marked hashes and the hashes present in the pool, or undefined
   * where the pass is stopped. Rejects on an IO failure reading a manifest.
   */
  private async markReachable(
    rootedBlobs: ReadonlySet<string>,
    shouldAbort: () => boolean
  ): Promise<{ marked: Set<string>; present: Set<string> } | undefined> {
    const present = new Set<string>();
    for (const blob of await readdir(this.blobRoot).catch(() => [] as fs.Dirent[])) {
      if (blob.isFile()) {
        present.add(blob.name);
      }
    }
    const marked = new Set(rootedBlobs);
    for (const entry of await readdir(this.entryRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return undefined;
      }
      if (!entry.isFile() || !CLAIMED_MANIFEST.test(entry.name)) {
        continue;
      }
      const file = path.resolve(this.entryRoot, entry.name);
      const hashes = await this.manifestBlobHashes(file);
      if (hashes === undefined || hashes.some(hash => !present.has(hash))) {
        await deleteFile(file).catch(() => undefined);
        continue;
      }
      for (const hash of hashes) {
        marked.add(hash);
      }
    }
    for (const record of await readdir(this.incrementalRoot).catch(() => [] as fs.Dirent[])) {
      if (shouldAbort()) {
        return undefined;
      }
      const recordDir = path.resolve(this.incrementalRoot, record.name);
      /* Resolve `current` once, as a reader does. A record without one keeps
       * nothing and is left to expire. */
      const gen = await realpath(path.join(recordDir, STATE_CURRENT_LINK)).then(
        resolved => resolved,
        () => undefined
      );
      if (gen === undefined) {
        continue;
      }
      const stateFile = path.join(gen, STATE_STATE_FILE);
      if (!fs.existsSync(stateFile)) {
        continue;
      }
      const hashes = await this.manifestBlobHashes(stateFile);
      if (hashes === undefined || hashes.some(hash => !present.has(hash))) {
        await deleteTree(recordDir).catch(() => undefined);
        continue;
      }
      for (const hash of hashes) {
        marked.add(hash);
      }
    }
    return { marked, present };
  }

  /** List the blob hashes the manifest `file` names: empty where it is missing,
   * undefined where it does not parse. Any other IO failure rejects, which
   * stops the pass: sweeping without a manifest's hashes could remove its
   * blobs. */
  private async manifestBlobHashes(file: string): Promise<string[] | undefined> {
    const text = await readFile(file).catch((err: unknown) => {
      if (isNotFound(err) || isNotDirectoryError(err)) {
        return undefined;
      }
      throw err;
    });
    if (text === undefined) {
      return [];
    }
    try {
      const entry = this.parseManifest(text);
      return [...entry.files].flatMap(([, held]) => (held instanceof SymlinkFile ? [] : [held.hash]));
    } catch {
      return undefined;
    }
  }

  /** Run the sweep step: move each blob in `present` that is not in `marked`
   * and is older than {@link GC_MAX_AGE_MS} out of the pool, into this
   * process's work tree (removed with it). A blob not named by any manifest
   * but rewritten by every build, such as a source snapshot with no source
   * index, is thus removed at most once per {@link GC_MAX_AGE_MS}.
   */
  private async sweepBlobs(marked: ReadonlySet<string>, present: ReadonlySet<string>, shouldAbort: () => boolean): Promise<void> {
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    for (const hash of present) {
      if (shouldAbort()) {
        return;
      }
      if (marked.has(hash)) {
        continue;
      }
      const blobPath = path.resolve(this.blobRoot, hash);
      const held = await stat(blobPath).catch(() => undefined);
      if (held === undefined || !this.pastWindow(held.mtimeMs, GC_MAX_AGE_MS)) {
        continue;
      }
      if (!shouldAbort()) {
        try {
          fs.renameSync(blobPath, path.join(this.ownWorkRoot, `trash-${hash}`));
        } catch {
          /* Already gone. */
        }
      }
    }
  }

  /** Delete `filepath` (a file or a whole tree) where its own mtime is older
   * than both `windowMs` and {@link GC_GRACE_MS}. Best-effort. */
  private async removeIfPast(filepath: string, windowMs: number): Promise<void> {
    const st = await stat(filepath).catch(() => undefined);
    if (st !== undefined && this.pastWindow(st.mtimeMs, windowMs)) {
      await deleteTree(filepath).catch(() => undefined);
    }
  }

  /** @return true if `mtimeMs` is older than both `windowMs` and
   * {@link GC_GRACE_MS}, otherwise false. */
  private pastWindow(mtimeMs: number, windowMs: number): boolean {
    const age = this.now() - mtimeMs;
    return age > windowMs && age > GC_GRACE_MS;
  }

  /** Remove the work trees of this host's processes that are gone (see
   * {@link isReapable}), never this process's own or another host's. */
  private reapWorkTrees(): void {
    let owners: string[] = [];
    try {
      owners = fs.readdirSync(this.workRoot);
    } catch {
      return;
    }
    for (const owner of owners) {
      const dir = path.resolve(this.workRoot, owner);
      if (dir !== this.ownWorkRoot && isReapable(owner)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* Best-effort. */
        }
      }
    }
  }
}

/** Options for {@link BuildCache.maybeCollectGarbage}. */
export interface ICollectOptions {
  /** Checked between steps of the pass: true stops it there (under watch, when
   * a new cycle starts). Stopping leaves the store consistent. */
  shouldAbort?: () => boolean;
}

/** Read the namespace of a key text (`rule`, `memo`, `fetch`), the class its
 * entry's manifest header is stamped with. */
function keyClass(cacheKey: string): string | undefined {
  return /^([a-z]+):/.exec(cacheKey)?.[1];
}

/**
 * What a build step's `run` is given for one action: its working directory,
 * the cache services it may use, the funnel its work is admitted through, and
 * the target key's last successful build. Where the work is reported is the
 * step's separate `report` argument.
 *
 * Made by the cache for the entry it is about to build, and by a test driving
 * a step directly.
 */
export class ActionContext {
  private state?: Computable<IBuildState | undefined>;

  /**
   * @param cache the run's build cache.
   * @param processLimit the machine-wide execution funnel.
   * @param workDir this action's working directory, in a step's directory
   *   ({@link BuildCache.makeStepDir}).
   * @param targetKey the target key whose build-state record the accessors
   *   read; absent for an action of no declared target, which has none.
   * @param force the build was asked to redo its work, so it is given no
   *   recorded build.
   * @param inputs the action's per-file inputs, compared by
   *   {@link changedFiles}; absent for a demand that tracks nothing.
   * @param discoverable the action's discoverable inputs.
   * @param sourcePathInputs the inputs whose source paths the comparison
   *   counts (see {@link BuildAction.sourcePathInputs}).
   */
  constructor(
    private readonly cache: BuildCache,
    public readonly processLimit: Semaphore,
    public readonly workDir: string,
    private readonly targetKey?: string,
    private readonly force = false,
    private readonly inputs?: ActionFileInputs,
    private readonly discoverable?: ActionFileInputs,
    private readonly sourcePathInputs: ReadonlyArray<string> = []
  ) {}

  /** Open a streaming write into the blob pool (see
   * {@link BuildCache.getTemporaryWriteStream}). */
  public createOutput(): IOutputHandle {
    return this.cache.getTemporaryWriteStream();
  }

  /** Write a tree into the cache's tree pool and return its path (see
   * {@link BuildCache.ensureTree}). */
  public ensureTree(files: FileSet): Computable<string> {
    return this.cache.ensureTree(files);
  }

  /**
   * Run the step's own machine work (staging inputs, collecting outputs)
   * through the execution funnel, reporting its funnel phases on `report`.
   *
   * Never call `execute` inside `work`: holding a slot while waiting for
   * another deadlocks at capacity. Stage, run and collect as separate
   * admissions.
   */
  public admit<T>(report: ITaskReport, work: () => Computable<T>): Computable<T> {
    return admitted(this.processLimit, report, work);
  }

  /**
   * Compare the action's inputs with those of the target key's last
   * successful build: `added` names present now and not then (a new source,
   * or a dependency path that found nothing then and finds a file now),
   * `changed` names whose content or source path differs, and `deleted` names
   * gone since. The action's own inputs are named by their staged names, its
   * discoverable inputs by the dependency path each was read by, as the step's
   * tool reports its reads.
   *
   * Undefined where there is nothing to compare with (a first build, a
   * damaged record, a forced build, an action that tracks no inputs): the
   * tool then builds from scratch.
   */
  public changedFiles(): Computable<IChangedFiles | undefined> {
    return this.record().then(state =>
      state?.inputs === undefined || state.discovered === undefined || this.inputs === undefined
        ? undefined
        : diffBuildState(
            this.inputs,
            this.discoverable,
            this.sourcePathInputs,
            state.inputs,
            state.inputSourcePaths ?? new Map(),
            state.discovered
          )
    );
  }

  /**
   * Read the files the last successful build's tool asked to keep (see
   * {@link BuildResult.incrementalState}); undefined where it kept none or they
   * cannot be read, and the tool then plans from scratch.
   */
  public incrementalState(): Computable<FileSet | undefined> {
    return this.record().then(state => state?.incrementalState);
  }

  /**
   * Read the files the last successful build produced, for a step that writes
   * its changes over them; undefined where there is no such build.
   */
  public previousOutputs(): Computable<FileSet | undefined> {
    return this.record().then(state => state?.outputs);
  }

  /**
   * Read the build-state record the accessors above answer from, once: every
   * accessor describes the same build, and a step that calls none reads
   * nothing. Undefined for a first build, an unreadable record, a removed
   * entry, or a forced build. The record is read as it stands when first
   * asked for, not when the action began.
   */
  private record(): Computable<IBuildState | undefined> {
    if (this.state === undefined) {
      this.state =
        this.targetKey === undefined || this.force ? Computable.resolve(undefined) : this.cache.readBuildState(this.targetKey);
    }
    return this.state;
  }
}

/*
 * Module-private implementation below this point.
 */

/** @return `files`, or undefined where it is undefined or empty. */
function withContent(files: FileSet | undefined): FileSet | undefined {
  return files === undefined || files.size === 0 ? undefined : files;
}

/** The funnel for a demand that names none: it admits everything at once
 * (see {@link ICreateOptions.processLimit}). */
const UNBOUNDED_FUNNEL = new Semaphore(Number.MAX_SAFE_INTEGER);

/** The delay before each retry of a fetch that failed transiently: two
 *  retries, the second after a longer pause. */
const FETCH_RETRY_DELAYS_MS = [1000, 4000];

/** The error codes, as undici and node report them, of a transient network
 *  failure: the origin unreachable, or the connection or stream dropping or
 *  stalling. */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  /* A body ending short of its content-length: undici's HTTP/2 client reports
   * a stream reset mid-body as this rather than as the stream error. */
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_SESSION_ERROR",
]);

/** Settle after `ms`. */
function delay(ms: number): Computable<void> {
  return Computable.from<void>(resolve => {
    setTimeout(() => resolve(), ms);
  });
}

/** Make `attempt`, and again after each of {@link FETCH_RETRY_DELAYS_MS} while it fails transiently. */
function retryingTransient<T>(attempt: () => Computable<T>, retry = 0): Computable<T> {
  return attempt().catch(err => {
    if (retry < FETCH_RETRY_DELAYS_MS.length && isTransientFetchError(err)) {
      return delay(FETCH_RETRY_DELAYS_MS[retry]).then(() => retryingTransient(attempt, retry + 1));
    }
    throw err;
  });
}

/** The secrets store's directory mode: this user alone may list or enter it. */
const SECRETS_DIR_MODE = 0o700;
/** A secret record's mode: this user alone may read or write it. */
const SECRET_RECORD_MODE = 0o600;

/**
 * A record kept in the secrets store ({@link BuildCache.getOrFetchSecret}):
 * its content (`value`), what identifies that content at its source without
 * being derived from it (`identity`: a parameter's ARN and version), and
 * whether its source says the content is secret.
 */
export interface ISecretRecord {
  readonly identity: string;
  readonly secret: boolean;
  readonly value: Buffer;
}

/** Read the secret record at `file`, with when it was written, or undefined where there is none or it is damaged. */
function readSecretRecord(file: string): { record: ISecretRecord; mtimeMs: number } | undefined {
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    const record = parseJson(fs.readFileSync(file, "utf8"), file, json => {
      const { identity, secret, value } = toJsonObject(json);
      if (typeof identity !== "string" || typeof secret !== "boolean" || typeof value !== "string") {
        throw new Error("not a secret record");
      }
      return { identity, secret, value: Buffer.from(value, "base64") };
    });
    return { record, mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * @return true if a fetch failed transiently, otherwise false: a response the
 * origin marks as temporary (408, 429, 5xx), or the connection or stream
 * failing (any error in the `cause` chain). Another 4xx, or a failure of the
 * content itself (integrity, a corrupt archive), is not transient. A
 * transient failure is retried, or a held copy served instead.
 */
function isTransientFetchError(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.statusCode >= 500 || err.statusCode === 408 || err.statusCode === 429;
  }
  /* Walk the chain by shape, not `instanceof Error`, so an error from another
   * realm (a test's VM context) counts. */
  for (let cause: unknown = err; typeof cause === "object" && cause !== null; cause = (cause as { cause?: unknown }).cause) {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (
      (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) ||
      (typeof message === "string" && /Stream closed with error code|stream timeout/.test(message))
    ) {
      return true;
    }
  }
  return false;
}

/** A file whose content is a blob in the pool. */
class BuildFile implements IFile {
  private readonly root: string;
  public name: string;
  public hash: string;

  /** `mode` is the file's own mode as the manifest records it, not the blob's
   * read-only one, and is applied when the file is written out. `mime` is
   * likewise the manifest's, so reading it reads no content. */
  constructor(
    root: string,
    hash: string,
    name: string,
    public mode: number,
    public readonly mime: string
  ) {
    this.root = root;
    this.hash = hash;
    this.name = name;
  }

  public readString(encoding?: BufferEncoding): Computable<string> {
    return readFile(path.resolve(this.root, this.hash), encoding);
  }

  public getBuffer(): Computable<Buffer> {
    return readFileBuffer(path.resolve(this.root, this.hash));
  }

  public getDisplayName(): string {
    /* The file's name (e.g. "build/index.js"), not its blob's path. */
    return this.name;
  }

  public isSameFile(file: IFile): boolean {
    return file.getAbsPath() === this.getAbsPath();
  }

  public getAbsPath(): string {
    return path.resolve(this.root, this.hash);
  }
}

/** Extend `control`'s expiry to at least {@link MINIMUM_FRESHNESS_MS} from `now`. */
function withMinimumFreshness(control: ICacheControl, now: number): ICacheControl {
  return { ...control, expires: Math.max(control.expires, now + MINIMUM_FRESHNESS_MS) };
}

/** @return true if the entry may be served as it stands, otherwise false: an
 * entry without cache-control metadata is always fresh, one with it until it
 * expires. */
function isFresh(entry: ICacheEntry, now: number): boolean {
  return entry.meta === undefined || entry.meta.expires > now;
}

/** @return this process's owner name, `<host>-<pid>`, which names its work
 * tree and anything else it leaves that a later run may remove (see
 * {@link isReapable}). */
export function ownerName(): string {
  return `${hostTag()}-${process.pid}`;
}

/** @return this machine's host name as one path segment with no `-` or `@`,
 * so a pid or kept work dir key splits off it unambiguously. */
function hostTag(): string {
  return os.hostname().replace(/[^\w.]/g, "_") || "host";
}

/** Read the pid in a `<host>-<pid>` owner name (a work tree's, or a collection
 * marker's after its prefix) where the host is this host; undefined for
 * another host's name or one that does not parse. */
function thisHostPid(owner: string): number | undefined {
  const split = owner.lastIndexOf("-");
  if (split < 0 || owner.slice(0, split) !== hostTag()) {
    return undefined;
  }
  const pid = Number(owner.slice(split + 1));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** @return true if the owner name `owner` ({@link ownerName}) is of a process
 * of this host that is gone, otherwise false (another host's name, or one that
 * does not parse). */
export function isReapable(owner: string): boolean {
  const pid = thisHostPid(owner);
  return pid !== undefined && !isProcessAlive(pid);
}

/** Take the hold file `file` for this process where no live process holds it,
 * returning true where taken. `claim` makes a path in this process's work
 * tree, where a dead holder's hold file is moved to free it. */
function takeHold(file: string, claim: () => string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    if (holderOf(file) !== undefined) {
      return false;
    }
    /* Its holder is gone. Move the stale hold away rather than delete it: of
     * two takers that both read it stale, only one rename succeeds, so neither
     * removes a hold the other has since written. */
    try {
      fs.renameSync(file, claim());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return false;
}

/** Look up the live process holding the hold file `file`, if any. */
function holderOf(file: string): number | undefined {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) ? pid : undefined;
}

/** @return the name of this host's kept work dir that the `work/` entry `name`
 * belongs to (the dir itself, its hold or its record), or undefined for any
 * other entry. */
function keptDirOf(name: string): string | undefined {
  if (!name.startsWith(`${hostTag()}${KEPT_MARK}`)) {
    return undefined;
  }
  for (const suffix of [KEPT_HOLD_SUFFIX, KEPT_RECORD_SUFFIX]) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/** @return true if `pid` names a live process, otherwise false. Probes with
 * signal 0, which sends nothing: EPERM means the pid exists but belongs to
 * another user (alive), ESRCH that it is gone. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Write the `inputs` part of a build's recorded base: one {@link manifestLine}
 * row per file of the inputs not named in `discoverable`, sorted by input and
 * then by file name, each carrying the file's encoded source path where its
 * input is among `sourcePathInputs`. The discoverable inputs are left out:
 * {@link recordedDiscovered} records them.
 */
function recordedInputs(
  inputs: ActionFileInputs,
  discoverable: ReadonlyArray<string>,
  sourcePathInputs: ReadonlyArray<string>
): string {
  const excluded = new Set(discoverable);
  return Object.keys(inputs)
    .sort()
    .filter(name => !excluded.has(name))
    .flatMap(name => {
      const value = inputs[name];
      const withSourcePaths = sourcePathInputs.includes(name);
      /* Sort each member by name, so an edit changes a row's hash, never its place. */
      return (Array.isArray(value) ? value : [value]).flatMap(member =>
        [...member]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([file, held]) => {
            const sourcePath = withSourcePaths ? member.sourcePaths.get(file) : undefined;
            return manifestLine(file, held.hash, held.mode, sourcePath === undefined ? undefined : encodeName(sourcePath));
          })
      );
    })
    .join("\n");
}

/**
 * Write the `discovered` part of a build's recorded base from the narrowed
 * discoverable inputs `used` (see {@link narrowDeps}): one row per file, named
 * by the dependency path it was reached by, and one {@link ABSENT_PREFIX} row
 * per path that found nothing. Empty where `used` is undefined.
 */
function recordedDiscovered(used: INarrowedDeps | undefined): string {
  return used === undefined ? "" : baseRows(used).join("\n");
}

/** Make the rows of {@link recordedDiscovered}, sorted within each input. */

function baseRows(used: INarrowedDeps): string[] {
  return Object.keys(used)
    .sort()
    .flatMap(name => {
      const { resolved, absent } = used[name];
      return [
        ...[...resolved].map(([path, file]) => manifestLine(path, file.hash, file.mode)),
        ...absent.map(path => `${ABSENT_PREFIX}${encodeName(path)}`),
      ].sort();
    });
}

/**
 * Compare a recorded base with the action's current inputs, for
 * {@link ActionContext.changedFiles}. The non-discoverable inputs are compared
 * by staged name: added, changed (by hash or source path) or deleted. Each
 * recorded discovered file is looked up again by its dependency path among the
 * current discoverable inputs: changed where its hash differs, deleted where it
 * is not found. A recorded absent path that now finds a file is added.
 */
function diffBuildState(
  current: ActionFileInputs,
  discoverable: ActionFileInputs | undefined,
  sourcePathInputs: ReadonlyArray<string>,
  baseInputs: FileSet,
  baseSourcePaths: ReadonlyMap<string, string>,
  baseDiscovered: IDiscoveredBase
): IChangedFiles {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  /* The current non-discoverable inputs, by the names the recorded rows use. */
  const now = new Map<string, { file: IFile; sourcePath: string | undefined }>();
  for (const name of Object.keys(current)) {
    if (discoverable?.[name] !== undefined) {
      continue;
    }
    const value = current[name];
    const withSourcePaths = sourcePathInputs.includes(name);
    for (const member of Array.isArray(value) ? value : [value]) {
      for (const [file, held] of member) {
        now.set(file, { file: held, sourcePath: withSourcePaths ? member.sourcePaths.get(file) : undefined });
      }
    }
  }
  for (const [name, { file, sourcePath }] of now) {
    const was = baseInputs.getFile(name);
    if (was === undefined) {
      added.push(name);
    } else if (was.hash !== file.hash || baseSourcePaths.get(name) !== sourcePath) {
      changed.push(name);
    }
  }
  for (const [name] of baseInputs) {
    if (!now.has(name)) {
      deleted.push(name);
    }
  }
  /* The discovered files and absences, against the current discoverable inputs. */
  const members =
    discoverable === undefined ? [] : Object.values(discoverable).flatMap(value => (Array.isArray(value) ? value : [value]));
  for (const [name, was] of baseDiscovered.files) {
    const resolved = resolvePackagePath(members, splitDepsPath(name));
    if (resolved === undefined) {
      deleted.push(name);
    } else if (resolved.file.hash !== was.hash) {
      changed.push(name);
    }
  }
  for (const path of baseDiscovered.absent) {
    if (resolvePackagePath(members, splitDepsPath(path)) !== undefined) {
      added.push(path);
    }
  }
  return { added: added.sort(), changed: changed.sort(), deleted: deleted.sort() };
}

/**
 * Narrow each discoverable input to the dependency paths `selection` lists for
 * it: the files they find, keyed by their joined path, and the paths that find
 * nothing. An input `selection` does not mention is narrowed to every path
 * (see {@link everythingPaths}). For an input named in `sourcePathInputs`, the
 * source-path digest of each route read is recorded too.
 */
export function narrowDeps(
  discoverable: ActionFileInputs,
  selection: DiscoveredDeps,
  sourcePathInputs: ReadonlyArray<string> = []
): INarrowedDeps {
  return mapObject(discoverable, (input, value) => {
    const members = Array.isArray(value) ? value : [value];
    const withSourcePaths = sourcePathInputs.includes(input);
    /* The run reported nothing for this input (a tool that does not report,
     * or a report that left it out): take it as having read everything. Do
     * this here alone, so nothing above can tell the two apart. */
    const selectedPaths = selection.get(input) ?? everythingPaths(members);
    const mapped = new Map<string, IFile>();
    const sourcePathsDigests = new Map<string, string>();
    const absent: string[] = [];
    for (const path of selectedPaths) {
      const name = joinDepsPath(path);
      const resolved = resolvePackagePath(members, path);
      if (resolved) {
        mapped.set(name, resolved.file);
        const digest = withSourcePaths ? resolved.holder.sourcePathsDigest : "";
        if (digest !== "") {
          /* Key the digest by the route: the joined path less its last part.
           * A loose file has no route, and the loose members share that, so
           * key its digest by the file itself. */
          const route = name.lastIndexOf(" ");
          sourcePathsDigests.set(route < 0 ? name : name.slice(0, route), digest);
        }
      } else {
        absent.push(name);
      }
    }
    return { resolved: new FileSet(mapped, undefined, CANONICAL), sourcePathsDigests, absent };
  });
}

/**
 * Make the dependency paths a run that read all of an input's `members` would
 * report: each file of a loose member, each file of each package at the route
 * {@link walkPackages} first reaches it by, and `[route, "package.json"]` for
 * every route the walk visits (each direct package and each dependency of a
 * package), as a tool reports each package lookup. A package with no
 * `package.json` gives a path that finds nothing.
 */
function everythingPaths(members: ReadonlyArray<FileSet>): DepsPath[] {
  const paths: DepsPath[] = [];
  for (const member of members) {
    if (!(member instanceof PackageFileSet)) {
      for (const [name] of member) {
        paths.push([name]);
      }
    }
  }
  const seen = new Set<PackageFileSet>();
  walkPackages(members, (pkg, route) => {
    paths.push([...route, "package.json"]);
    if (!seen.has(pkg)) {
      seen.add(pkg);
      for (const [name] of pkg) {
        paths.push([...route, name]);
      }
    }
  });
  return paths;
}

/**
 * Look up the file a dependency path names among an input's `members`, with
 * the set that holds it; undefined where it finds nothing. A one-part path is
 * a file of a loose member. Otherwise the first part names a member by its
 * name, each middle part a dependency of the package before it (by
 * dependency name), and the last part a file of the package reached. Look up
 * nothing more: a tool reports its reads already in this form.
 */
function resolvePackagePath(members: ReadonlyArray<FileSet>, path: DepsPath): { file: IFile; holder: FileSet } | undefined {
  const leaf = path.at(-1)!;
  const holder =
    path.length === 1
      ? members.find(member => member.name === "" && member.getFile(leaf) !== undefined)
      : path.slice(1, -1).reduce<FileSet | undefined>(
          (prev, file) => (prev instanceof PackageFileSet ? prev.getDependency(file)?.package : undefined),
          members.find(child => child.name === path[0])
        );
  const file = holder instanceof FileSet ? holder.getFile(leaf) : undefined;
  return file === undefined ? undefined : { file, holder: holder as FileSet };
}

/**
 * Make a node holding the outcome of `attempt`, settled once from it. Where
 * the attempt succeeds the node holds its value alone and lets go of the
 * attempt's chain, so nothing the attempt read (a credential from the source
 * tree) is an input of the result. Where it fails the node is bound to the
 * chain, so a change to what the attempt read runs it again.
 */
function settledFrom<T>(attempt: Computable<T>): Computable<T> {
  return Computable.from<T>(resolve => {
    const hold = new ComputableHandle<void>();
    /* Resolve before releasing the hold: released first, the chain would
     * detach and run again as it is bound. */
    const consume = (outcome: T | Computable<T>): void => {
      resolve(outcome);
      hold.release();
    };
    const tail = attempt.then(
      value => consume(value),
      () => consume(attempt)
    );
    hold.seat(tail);
    if (tail.isSettled()) {
      hold.release();
    }
  });
}
