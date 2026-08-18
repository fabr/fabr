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
import { Readable, Transform, Writable } from "stream";
import { Computable } from "./Computable";
import { HttpStatusError } from "./Errors";
import { ICacheControl, openUrlStream, reportingProgress } from "./Fetch";
import { CANONICAL, DEFAULT_FILE_MODE, FileSet, IFile } from "./FileSet";
import {
  deleteFile,
  HASH_ALGORITHM,
  hashString,
  isNotFound,
  readFile,
  readFileBuffer,
  readOnlyPermissions,
  rename,
  writeFile,
} from "./FSWrapper";
import { registerTempTree, removeTempTree, writeFileSet } from "./Staging";
import { CacheLink, SymlinkFile } from "./SymlinkFile";
import type { ITaskReport, TaskTracker } from "../support/Execute";
import type { Semaphore } from "../support/Semaphore";
import { Diagnostic, Log } from "../support/Log";
import { SNIFF_LENGTH, sniffMime } from "../support/Mime";

/**
 * A streaming output sink a build step writes to instead of buffering: the bytes
 * are hashed as they are written and, on {@link finalize}, placed directly in the
 * content store as a cache-backed file — no intermediate memory buffer and no
 * work-dir round-trip. Used for output a step produces as a *stream* (a captured
 * pipeline stream), the streaming counterpart of {@link BuildCache.ensureBlob}.
 */
export interface IOutputHandle {
  /** The sink to pipe process output into (pipe with `{ end: false }`; the handle
   * is ended by {@link finalize}/{@link discard}, not by the source). */
  readonly stream: Writable;
  /** End the stream, flush it, place the streamed bytes in the store under their
   * (now-complete) hash, and return a cache-backed file named `name`. `mode` is
   * the file's real permission bits (default non-executable) — carried on the
   * IFile so an unpacked executable (e.g. an esbuild binary) survives to export. */
  finalize(name: string, mode?: number): Computable<IFile>;
  /** Abandon the stream and delete its temp file — nothing enters the store. */
  discard(): void;
}

/** What a fetch `process` callback is handed alongside the response stream. A
 * consumer that assembles an in-memory document (metadata) writes nothing; one
 * that reifies large content (an archive unpack) streams each file straight into
 * the content store via {@link createOutput}, never through the scratch dir. */
export interface IFetchContext {
  /** A cache-owned scratch dir the process may write files into. */
  readonly targetDir: string;
  /** A streaming CAS-output factory (see {@link getTemporaryWriteStream}). */
  readonly createOutput: () => IOutputHandle;
}

/**
 * What a build step's `run` receives (see IBuildActionDefinition): the scratch
 * work directory, a factory for streaming outputs, and the run's execution
 * funnel. Built by {@link runAction} around the cache, so a step can produce
 * work-dir files (collected afterward) or stream output straight into the
 * store ({@link createOutput}).
 */
/** The tree pool's directory within a cache — the path a {@link CacheLink} to
 * the pool names, so it is one constant and not two spellings. */
const TREE_DIR = "tree";

export interface IActionContext {
  readonly workDir: string;
  createOutput(): IOutputHandle;
  /**
   * How this action's executions report themselves — where their output goes,
   * and their funnel phases — already resolved against the run's verbosity
   * (`-q` leaves no output sink, so the step captures). A step passes it to
   * {@link execute}/{@link executePipeline} and makes no display decisions of
   * its own; the one it may make is to withhold the output sink where its own
   * contract says the output belongs elsewhere (the test runner's report).
   */
  readonly report: ITaskReport;
  /**
   * Materialize a tree in the cache's pool and answer its path — the step-side
   * half of {@link BuildCache.ensureTree}, for a step whose work IS
   * materializing something durable (a package a tool will resolve through a
   * manifest rather than a staged copy).
   *
   * Deliberately the only cache capability a step gets besides
   * {@link createOutput}: both are "put content where the cache keeps content",
   * which a step legitimately does, and neither lets it reach keys, entries or
   * anything else the cache owns.
   */
  ensureTree(files: FileSet): Computable<string>;
  /**
   * The cache's tree pool as a mountable link, for a step that stages the pool
   * WHOLE and addresses the trees in it by name (a generated resolution table
   * naming them) rather than mounting one tree at a position.
   *
   * A link and not a path on purpose: it is the same narrow shape as
   * {@link ensureTree} — something to put in a FileSet — and it hands a step no
   * way to reach the cache's own layout. Where the pool sits within a cache
   * stays the cache's business.
   */
  readonly treePool: CacheLink;
  /**
   * The machine-wide execution funnel, which `execute`/`executePipeline`
   * require: a slot is held for exactly the process lifetime, and the step's
   * own code never holds one *across* one of those — so a step may issue any
   * number of executions, sequentially or in parallel (the per-file test run),
   * and hold-and-wait is impossible by construction.
   */
  readonly processLimit: Semaphore;
  /**
   * Run the step's own machine-heavy work — staging a tree of inputs — through
   * that same funnel, reported like an execution. Staging is I/O rather than
   * CPU, but it is machine work all the same, and without admission every
   * action that passes its cache-miss check stages at once: on a wide graph
   * that is a hundred trees of hardlinks in flight, and a display of what the
   * build is doing that is mostly a list of them.
   *
   * The slot is taken and given back around `work` alone. It must therefore
   * NOT enclose an `execute` — a slot held while asking for another is
   * hold-and-wait, and at capacity that is a deadlock (see Semaphore). Stage,
   * then run: they are separate admissions, never nested.
   */
  admit<T>(work: () => Computable<T>): Computable<T>;
}

const DIAG_SERVING_STALE = Diagnostic.Warn<{ url: string; reason: string }>(
  "cannot refresh {url} ({reason}); serving the cached copy"
);

/**
 * Whether a refresh failure is transient enough to justify serving a stale copy
 * (stale-if-error). A transport failure (timeout, DNS, connection reset — never
 * an {@link HttpStatusError}) means the origin was unreachable, and a 5xx is a
 * server-side blip: both leave the held copy the best available answer. Two 4xx
 * are likewise retry-later signals — 408 (the origin timed out waiting) and 429
 * (rate-limited). Every *other* 4xx is a *definite* origin answer — 401/403
 * (expired credentials), 404 (unpublished or yanked) — and must surface as itself
 * rather than hide behind stale content.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof HttpStatusError)) {
    return true;
  }
  return err.statusCode >= 500 || err.statusCode === 408 || err.statusCode === 429;
}

class BuildFile implements IFile {
  private readonly root: string;
  public name: string;
  public hash: string;

  /** The file's original permission bits, read back from the manifest — NOT the
   * mode of the backing blob (which is read-only 0o444/0o555). Reapplied when the
   * file is exported to user space (`fabr cp`) or packed. The mime likewise rides
   * the manifest (sniffed when the content was first read on the way in), so a
   * cache-served file answers classification with no read. */
  constructor(root: string, hash: string, name: string, public mode: number, public readonly mime: string) {
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
    /* The logical name (e.g. "build/index.js"), not the opaque blob path — a
     * content hash is meaningless in a diagnostic. */
    return this.name;
  }

  public isSameFile(file: IFile): boolean {
    return file.getAbsPath() === this.getAbsPath();
  }

  public getAbsPath(): string {
    return path.resolve(this.root, this.hash);
  }
}

/**
 * Options for {@link BuildCache.getOrFetch}: the caller's statement of the
 * URL's content contract. **`immutable` (the default)** asserts the content
 * can never change — the entry is cached forever, cache headers ignored (the
 * assertion is a *content* contract, stronger than transport headers; e.g. an
 * npm tarball, which npmjs itself serves `cache-control: immutable`). With
 * **`immutable: false`** the entry instead honors plain HTTP caching: cached
 * with the origin-declared freshness (`max-age`/`Expires` minus `Age`; none
 * declared → stale immediately) and revalidated by conditional GET once stale.
 * Only for *pointer* documents over immutable content (a registry's package
 * version list); content that is itself replaced under one URL stays banned.
 */
export interface FetchOptions {
  immutable?: boolean;
  /** Revalidate now regardless of remaining freshness — for a caller holding
   * evidence the copy is stale (e.g. it lacks a version known to exist). */
  forceRevalidate?: boolean;
}


/** A cache entry as read back from disk: its files, plus freshness metadata for
 * a mutable entry. */
interface ICacheEntry {
  files: FileSet;
  meta?: ICacheControl;
}

/** Whether the entry may be served as it stands: the manifest itself says — an
 * entry without cache-control metadata is immutable (fresh forever), one with
 * it is fresh until its expiry. */
function isFresh(entry: ICacheEntry, now: number): boolean {
  return entry.meta === undefined || entry.meta.expires > now;
}

/** How an entry is demanded (see {@link BuildCache.getOrCreate}). */
export interface ICreateOptions {
  /**
   * Rebuild the entry without consulting what is stored, then commit the result
   * as usual — so a forced build leaves an ordinary entry behind and the next
   * demand is an ordinary hit. It defeats the *lookup* only: an attempt already
   * in flight for the key is still joined, since that work is being done by
   * this run anyway.
   */
  force?: boolean;
}

/** Work trees this process has already taken ownership of, by path — see
 * {@link BuildCache.reclaimWorkTree}. */
const reclaimedRoots = new Set<string>();

/** This machine's identity within a work-tree owner name (`<host>-<pid>`),
 * reduced to one path segment with no `-` so the pid splits off unambiguously.
 * Only ever compared against names this same function produced. */
function hostTag(): string {
  return os.hostname().replace(/[^\w.]/g, "_") || "host";
}

/** Whether a `work/` subdirectory belongs to a process of THIS host that is
 * gone — the only foreign trees safe to remove. A name we can't read as one of
 * our own is left alone, as is any tree owned by another host (whose pids mean
 * nothing here). */
function isReapable(owner: string): boolean {
  const split = owner.lastIndexOf("-");
  if (split < 0 || owner.slice(0, split) !== hostTag()) {
    return false;
  }
  const pid = Number(owner.slice(split + 1));
  return Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
}

/** Signal 0 probes for existence without delivering anything: EPERM means the
 * pid exists but belongs to another user (alive), ESRCH that it is gone. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const META_PREFIX = "!meta ";

/* A symlink manifest line: `@link <encodeURI(target)> <encodeURI(name)>`. The
 * target rides inline (it is the symlink's whole content — no blob), and both
 * fields are URI-encoded so the single space stays an unambiguous separator. A
 * regular file line leads with a hex content hash, so it can never be mistaken
 * for one of these (or for the `!meta` header). */
const LINK_PREFIX = "@link ";

const ZERO = "0".charCodeAt(0);

/** Decode a manifest name/target field. `encodeURI` only ever introduces `%`
 * escapes, so a field without one decodes to itself — and almost none have one,
 * which makes the check worth making before the call. */
function decodeName(field: string): string {
  return field.indexOf("%") < 0 ? field : decodeURI(field);
}

/**
 * Implemements an MVP build cache.
 *
 * The Source Manifest is hashed and used to look up the target manifest. If not found,
 * we create a directory for the job to write to, and
 *
 * It is also the content-addressed blob store (see {@link ensureBlob}) that both
 * the source-file snapshots a {@link SourceFileSource} takes and a build step's
 * outputs (see `storeContent`) materialise into — one pool (`blob/<hash>`), one
 * atomic write, one dedup.
 */
export class BuildCache {
  private readonly root: string;
  private readonly blobRoot: string;
  /** The tree pool: one directory per materialized tree, named by the manifest
   * hash of its contents — see {@link ensureTree}. */
  private readonly treeRoot: string;
  /** Every process's work tree lives under here, one subtree each. */
  private readonly workRoot: string;
  /** This process's own subtree — where every transient the cache writes goes:
   * build-step work dirs, the temp files behind atomic blob/manifest writes, and
   * the installs the interactive verbs stage. See {@link reclaimWorkTree}. */
  private readonly ownWorkRoot: string;
  /** Clock for freshness decisions (injectable for tests); cache policy only,
   * never a build input. */
  private readonly now: () => number;
  /** The driver's diagnostic log, for cache behavior a user should see
   * (serving a stale copy on a fetch failure). */
  private readonly log: Log;

  /** Counter for unique temp names within this process's work tree (which is
   * what keeps them distinct from another process's; the +rename is what makes
   * each appear in the store atomically). */
  private tempCounter = 0;
  /**
   * Entries currently being created, by hashed key: a second demand for the
   * same key joins the first's Computable rather than starting its own build
   * (removed once settled — later demands find the entry on disk). This is
   * both a redundant-work dedup (concurrent consumers sharing a package don't
   * re-download it — repository fetches are demanded per consuming collection
   * point, not gated by the per-target cache) AND a write lock on the entry
   * within this process: without it two concurrent misses would both build the
   * same key and one's manifest could reference the other's discarded work.
   * Across processes there is no lock — two fabr runs sharing a cache duplicate
   * the effort. They no longer collide over it, though: each builds in its own
   * work tree (see {@link reclaimWorkTree}) and commits atomically, so the
   * loser's manifest is byte-identical to the winner's for a deterministic
   * build. (Locking to stop the duplication, rather than the corruption, would
   * be a separate exercise.)
   */
  private readonly inflight = new Map<string, Computable<FileSet>>();

  /**
   * Trees currently being materialized, by name: a second demand joins the
   * first rather than building its own temp (the same dedup {@link inflight}
   * gives entries — across processes the atomic publish is what keeps them
   * safe, not a lock).
   */
  private readonly inflightTrees = new Map<string, Computable<string>>();

  constructor(cachePath: string, log: Log, now: () => number = Date.now) {
    this.root = cachePath;
    this.blobRoot = path.resolve(cachePath, "blob");
    this.treeRoot = path.resolve(cachePath, TREE_DIR);
    this.workRoot = path.resolve(cachePath, "work");
    this.ownWorkRoot = path.resolve(this.workRoot, `${hostTag()}-${process.pid}`);
    this.log = log;
    this.now = now;
    this.reclaimWorkTree();
  }

  /**
   * Take ownership of this process's work subtree, and reap the subtrees of
   * processes that are gone.
   *
   * Work dirs are named by *owner*, not by what they hold: a random child of
   * `work/<host>-<pid>/` rather than the cache key it is building. That is what
   * makes them reclaimable — a key-named work dir is only ever cleaned by a
   * later build of that same key, so debris from a key nothing rebuilds stays
   * forever — and it is also what makes two fabr processes sharing a cache
   * safe rather than racy: each writes in its own tree and they can only
   * duplicate effort, never scribble over each other (the commit paths are
   * already atomic — see {@link renameIntoPool} and {@link storeManifest}).
   *
   * Liveness is `kill(pid, 0)`: EPERM means someone else's process holds the pid
   * (alive), ESRCH means it is gone. A recycled pid can only make a dead tree
   * look live — the reverse is impossible — and the recycler *is* fabr only if
   * it is us, in which case the tree is ours to clean and we do so here. Other
   * hosts' subtrees are never touched, since their pids mean nothing here; they
   * are their own owners' to reap (a cache on shared storage).
   *
   * In line rather than deferred: a dead run's tree is bounded by what that run
   * staged, and paying for it up front keeps the store's state at any moment a
   * function of what is running, not of when a background sweep last got to it.
   */
  private reclaimWorkTree(): void {
    /* Once per root per process: a second BuildCache over the same store shares
     * this process's tree (same owner), so re-running the reclaim would delete
     * the work of the instance already using it. */
    if (reclaimedRoots.has(this.ownWorkRoot)) {
      return;
    }
    reclaimedRoots.add(this.ownWorkRoot);
    let owners: string[] = [];
    try {
      fs.mkdirSync(this.workRoot, { recursive: true });
      owners = fs.readdirSync(this.workRoot);
    } catch {
      /* An unreadable work root is not fatal here — the mkdir below reports it
       * against the build that actually needed a work dir. */
    }
    for (const owner of owners) {
      if (path.resolve(this.workRoot, owner) !== this.ownWorkRoot && !isReapable(owner)) {
        continue;
      }
      try {
        fs.rmSync(path.resolve(this.workRoot, owner), { recursive: true, force: true });
      } catch {
        /* Someone else's debris resisting removal is no reason to fail a build. */
      }
    }
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    /* One registration covers every transient below it: an orderly exit takes
     * the whole subtree, so a later run's sweep only ever sees the trees of runs
     * that died without one. */
    registerTempTree(this.ownWorkRoot);
  }

  /**
   * A fresh scratch directory in this process's work tree, for anything that is
   * written to the filesystem but not (yet) content: a build step's work dir, a
   * temp file staged for an atomic rename into the store, an interactive verb's
   * staged install. Release it with {@link releaseWorkDir} when done — the exit
   * hook and the sweep are the backstops for the ways that never happens.
   *
   * Being inside the store's own tree is load-bearing, not incidental: staged
   * files are hardlinks to blobs, so a work dir on another filesystem cannot be
   * populated at all (EXDEV). Everything fabr stages therefore inherits the one
   * filesystem assumption the cache already makes.
   */
  public createWorkDir(prefix = "w-"): string {
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    return fs.mkdtempSync(path.join(this.ownWorkRoot, prefix));
  }

  /** Drop a directory from {@link createWorkDir}. Idempotent, best-effort. */
  public releaseWorkDir(dir: string): void {
    removeTempTree(dir);
  }

  /** A temp path in this process's work tree for an atomic write: create it
   * there, then rename it into the store (same filesystem by construction). */
  private tempPath(what: string): string {
    fs.mkdirSync(this.ownWorkRoot, { recursive: true });
    return path.join(this.ownWorkRoot, `${what}-${this.tempCounter++}`);
  }

  public getOrCreate(cacheKey: string, create: (targetDir: string) => Computable<FileSet>, options?: ICreateOptions): Computable<FileSet> {
    const key = hashString(cacheKey);
    return this.withLock(key, () =>
      options?.force
        ? this.createEntry(key, create)
        : this.cacheGet(key).then(entry => (entry && isFresh(entry, this.now()) ? entry.files : this.createEntry(key, create)))
    );
  }

  /**
   * Run one attempt at an entry under the in-process locking: a concurrent
   * demand for the same key joins the running attempt instead of starting its
   * own (dedup + the write lock on the entry — without it two concurrent
   * misses would both scribble over one entry dir); a settled attempt is never
   * joined (success ≡ the manifest on disk; a failure must retry, not replay).
   */
  private withLock(key: string, operation: () => Computable<FileSet>): Computable<FileSet> {
    const running = this.inflight.get(key);
    if (running) {
      return running;
    }
    const result = operation();
    this.inflight.set(key, result);
    result.finally(() => this.inflight.delete(key));
    return result;
  }

  /**
   * Download a URL through the cache: the cache key is the url plus the
   * caller's process tag (a stable `name:version` identifying — and
   * versioning — what is done to the response, e.g. `npm:tarball:1`), so two
   * different treatments of one URL cannot collide, and a behavior change is
   * an explicit tag bump rather than a manual cache flush. The entry is
   * created by passing the response stream through the given process callback
   * (e.g. unpacking an archive, or validating and storing a metadata
   * document).
   *
   * The process callback runs before anything is recorded in the cache, so
   * throwing on invalid content guarantees error responses are never cached.
   *
   * By default (`options.immutable` absent or true), a cached download is
   * never refreshed: the caller asserts the URL's content is immutable by
   * contract, which outranks any transport cache headers. With
   * `immutable: false` the entry instead honors HTTP caching (see
   * {@link FetchOptions}): served while origin-declared-fresh, then
   * revalidated by conditional GET — 304 refreshes the lifetime in place, new
   * content replaces the entry, and a *fetch* failure serves the held copy
   * (stale-if-error; a `process` validation failure still propagates and
   * leaves the previous entry standing). (Integrity verification of downloaded
   * content also belongs here, eventually.)
   */
  public getOrFetch(
    url: string,
    tag: string,
    process: (content: Readable, ctx: IFetchContext) => Computable<FileSet>,
    /** Brackets the actual transfer as the caller's task: applied around the
     * miss path alone (a hit transfers nothing), with the transfer's byte
     * progress landing on the report it provides. The tracker is the caller's
     * because the task's description — whose behalf the fetch is on — is the
     * caller's to state. */
    track: TaskTracker<FileSet>,
    headers?: Record<string, string>,
    options?: FetchOptions
  ): Computable<FileSet> {
    /* `headers` (e.g. a registry auth token) authenticate the request only — they
     * are deliberately NOT part of the cache key (the content is a function of the
     * URL, not who fetched it), so an authenticated fetch of a private package
     * caches by URL like any other. */
    const key = hashString(`fetch:${tag} ${url}`);
    return this.withLock(key, () =>
      this.cacheGet(key).then(entry => {
        if (entry && isFresh(entry, this.now()) && !options?.forceRevalidate) {
          return entry.files;
        }
        return this.fetch(key, url, process, track, headers, entry, options);
      })
    );
  }

  /**
   * Fetch a missing-or-stale entry, conditionally when the held copy carries
   * validators: a 304 refreshes the entry's lifetime in place (content
   * unchanged, `process` not re-run); fresh content replaces the entry —
   * written with its cache-control metadata for a non-immutable caller, and
   * without any for an immutable one (fresh forever); a fetch failure serves
   * the held copy (stale-if-error — a caller with expiring entries tolerates
   * boundedly-stale answers).
   */
  private fetch(
    key: string,
    url: string,
    process: (content: Readable, ctx: IFetchContext) => Computable<FileSet>,
    track: TaskTracker<FileSet>,
    headers: Record<string, string> | undefined,
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
    return openUrlStream(url, { ...headers, ...validators }, this.now).then(
      response => {
        const meta = options?.immutable !== false ? undefined : response.cacheControl;
        const stream = response.stream;
        if (stream) {
          /* The transfer bracketed as the caller's task, the body counted past
           * for byte progress against the declared size. */
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
              ),
            meta
          );
        }
        /* 304: only possible for a conditional request (the fetch layer rejects
         * it otherwise), so we hold the entry the validators came from —
         * re-putting it refreshes its lifetime in place (its files are already
         * blob-backed, so the content ingest is a no-op). */
        return this.cachePut(key, entry!.files, meta);
      },
      err => {
        if (entry && isTransientFetchError(err)) {
          /* Stale-if-error (per RFC 9111's cannot-reach-the-origin allowance):
           * a held copy beats failing the build on a registry blip — but never
           * silently, and only for a genuinely transient failure. A 4xx
           * (401/403 expired token, 404 unpublished) is a definite answer, not a
           * blip: degrading it to a stale copy would mask an auth/existence error
           * behind boundlessly-old content, so it propagates. */
          this.log.log(DIAG_SERVING_STALE, { url, reason: err instanceof Error ? err.message : String(err) });
          return entry.files;
        }
        throw err;
      }
    );
  }

  /**
   * Store `bytes` as an immutable content-addressed blob under `hash` (for the
   * source-file snapshots a {@link SourceFileSource} takes, and any in-memory
   * build output). Keying it by the same hash the manifest uses guarantees the
   * bytes compiled are exactly the bytes that hash names. Written atomically
   * (temp + rename) so a crash or concurrent writer can never leave a *partial*
   * blob a later `existsSync` would trust. `mode` (default non-executable) sets
   * the blob's read-only permissions (see {@link materializeBlob}).
   */
  public ensureBlob(hash: string, bytes: Buffer, mode: number = DEFAULT_FILE_MODE): Computable<string> {
    return this.materializeBlob(hash, mode, blobPath => {
      const tmp = this.tempPath("blob");
      return writeFile(tmp, bytes).then(() => this.renameIntoPool(tmp, blobPath));
    });
  }

  /**
   * A streaming write into the content store (see {@link IOutputHandle}): the
   * streaming counterpart of {@link ensureBlob}. Bytes written to the handle's
   * stream are hashed on the fly and spooled to a temp file; `finalize` places
   * that file in the pool under the completed hash (reusing the same atomic
   * placement + global dedup), so a large streamed output never buffers in memory
   * and is hashed in a single pass. `discard` drops the temp file unplaced.
   */
  public getTemporaryWriteStream(): IOutputHandle {
    const tmpPath = this.tempPath("stream");
    const hash = createHash(HASH_ALGORITHM);
    const fileStream = fs.createWriteStream(tmpPath);
    /* Record (don't swallow) the first stream error, on either the sink or the
     * spool: `pipe` auto-unpipes on a destination error and no `finish` will ever
     * fire, so finalize can't wait on `finish` alone or it hangs. We capture the
     * first error and, if finalize is already awaiting, reject it — covering an
     * error that preceded finalize (ENOSPC before the await), one that arrives
     * after it, and a stray error (e.g. discard's destroy) that must not escalate
     * to an uncaught crash. */
    let firstError: Error | undefined;
    let pendingReject: ((err: Error) => void) | undefined;
    const recordError = (err: Error): void => {
      if (firstError) return;
      firstError = err;
      pendingReject?.(err);
    };
    fileStream.on("error", recordError);
    /* The leading bytes, captured as they stream past, so finalize can classify
     * the content (IFile.mime) from the same pass that hashes it. */
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
    /* Abandon the spool: destroy both streams, then drop the temp file — but only once
     * the spool stream has actually closed. Waiting is the point: `createWriteStream`
     * opens asynchronously, so unlinking while an open is still in flight lets that open
     * recreate the file *after* the removal, leaving debris in a work tree whose owner
     * believes it is done with it (and racing whoever reclaims that tree). A `pipe`
     * source error does not destroy the destination either, so without this the spool
     * keeps its fd — and its file — for the life of the process. Removal is best-effort;
     * a cleanup failure must never outrank the outcome being reported. */
    const teardown = (done: () => void): void => {
      const remove = (): void => {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          /* Best-effort: the caller's own outcome is what matters. */
        }
        done();
      };
      /* Already closed ⇒ no `close` is coming; removing inline is what keeps a
       * second teardown (or a discard after a failed finalize) from hanging. */
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
        Computable.fromOnce<IFile>((resolve, reject) => {
          /* Report a failure only once the spool is torn down, so a rejection carries the
           * guarantee that nothing of this output is left behind — no temp file, no fd
           * still closing — rather than leaving the caller to race it. */
          const fail = (err: Error): void => teardown(() => reject(err));
          if (firstError) {
            fail(firstError);
            return;
          }
          pendingReject = fail;
          fileStream.once("finish", () => {
            pendingReject = undefined;
            const digest = hash.digest("hex");
            /* `mode` defaults non-executable (a captured genrule stdout); an
             * unpacked entry passes its real tar mode so an executable survives. */
            this.materializeBlob(digest, mode, blobPath => this.renameIntoPool(tmpPath, blobPath)).then(
              () => resolve(new BuildFile(this.blobRoot, digest, name, mode, sniffMime(head))),
              /* A placement failure leaves the spool where it is (the rename either
               * happened or did not), so tear it down here too. */
              fail
            );
          });
          sink.end();
        }),
      discard: (): void => {
        /* Fire-and-forget: every caller is a synchronous error path that rejects at once
         * (see IOutputHandle.discard), so the removal lands in the background once the
         * fd is closed rather than being skipped for want of somewhere to await it. */
        teardown(() => undefined);
      },
    };
  }

  /**
   * Move an already-written file (a build step's output, sitting in its work
   * dir) into the pool under `hash` — a rename, not a copy, since we already
   * hashed it. `mode` is the file's real permission bits, used to set the blob
   * read-only (0o444/0o555 — see {@link readOnlyPermissions}); the *original* mode
   * lives in the manifest, so two byte-identical files with different modes share
   * one blob yet still export at their own mode.
   */
  private ingestFile(hash: string, sourcePath: string, mode: number): Computable<string> {
    return this.materializeBlob(hash, mode, blobPath => this.renameIntoPool(sourcePath, blobPath));
  }

  /**
   * Put content into the pool at `<blobRoot>/<hash>`: reuse an existing blob,
   * else `materialise` it (which must place it *atomically* at the given path).
   * No in-flight lock is needed — the atomic rename makes concurrent writers of
   * the same hash safe (identical content, atomic replace); the worst case is a
   * redundant temp-write that never corrupts the result. The blob is chmod'd
   * read-only (executable iff `mode` is), so a launched tool cannot write through
   * a staged hardlink into the shared blob; a later executable demand of an
   * existing non-exec blob upgrades it to 0o555 (adding exec is safe on read-only
   * content, and a hardlink can't be chmod'd apart from its blob).
   */
  private materializeBlob(hash: string, mode: number, materialise: (blobPath: string) => Computable<void>): Computable<string> {
    const blobPath = path.resolve(this.blobRoot, hash);
    if (fs.existsSync(blobPath)) {
      /* Only ever ADD the exec bit, never remove it: two byte-identical files
       * with different modes share this one blob, and a hardlink can't be
       * chmod'd apart from it, so a non-executable demand must not strip the
       * exec bit an executable one needs (a non-exec hit is otherwise a no-op —
       * the blob is already read-only). */
      if (readOnlyPermissions(mode) & 0o111) {
        fs.chmodSync(blobPath, 0o555);
      }
      return Computable.resolve(blobPath);
    }
    fs.mkdirSync(this.blobRoot, { recursive: true });
    return materialise(blobPath).then(() => {
      /* Read the freshly-placed mode rather than assuming: a concurrent writer
       * of the same hash may have won the rename and already set exec, which we
       * must not clobber (exec stays sticky). */
      const exec = (fs.statSync(blobPath).mode & 0o111) !== 0 || (readOnlyPermissions(mode) & 0o111) !== 0;
      fs.chmodSync(blobPath, exec ? 0o555 : 0o444);
      return blobPath;
    });
  }

  /** Atomically move `from` into place at `blobPath`. If another writer got
   * there first (the blob now exists — same content by hash), that is success;
   * either way `from` is consumed. */
  private renameIntoPool(from: string, blobPath: string): Computable<void> {
    return rename(from, blobPath).catch(renameErr => {
      /* rename failed: if another writer already materialised the blob first
       * (same content by hash) that is success, else a real error. Either way
       * drop the leftover `from`, then settle on which it was. */
      const won = fs.existsSync(blobPath);
      return deleteFile(from).finally(() => {
        if (!won) {
          throw renameErr;
        }
      });
    });
  }

  /** Where {@link ensureTree} publishes, as an absolute path on this machine. */
  public get treePath(): string {
    return this.treeRoot;
  }

  /**
   * The tree pool as a mountable link — what a step stages when it addresses
   * trees by name itself (a generated manifest naming them) rather than
   * mounting one tree at a position. Handed out by the cache because the cache
   * owns both halves: the pool's name within a cache, and where this cache is.
   */
  public get treePoolLink(): CacheLink {
    return new CacheLink(TREE_DIR, this.root);
  }

  /**
   * Materialize `files` once, permanently, and return the path of the tree.
   *
   * This is the **tree pool**, the exact counterpart of the blob pool one
   * dimension up: files by content hash, trees by manifest hash, the same
   * discipline. An existing tree is served as it stands; a missing one is built
   * in a temp sibling and published by a single atomic `rename`.
   *
   * **The tree at `tree/<H>` is the materialization of the FileSet whose
   * manifest hashes to `H`.** That is a property of this signature rather than
   * a convention callers keep: there is no key to pass, so none can be passed
   * wrongly, an entry deleted and demanded again rebuilds under the same name
   * by construction, and any entry can be checked by re-manifesting what it
   * holds — the pool is fsck-able, which is what a future GC will want when it
   * decides whether a directory is what it claims to be. (Modes are the one
   * subtlety for such a check: a tree's files carry the blob pool's read-only
   * bits, while the manifest records their real ones.)
   *
   * The cache knows nothing about what a tree MEANS — it is handed files. What
   * it guarantees is the discipline a consumer needs:
   *
   * - **Materialize-once.** Files are hardlinks out of the blob pool (an
   *   in-memory file is ingested first, so a tree is always a pure function of
   *   the blob pool), which is why a tree costs links once, ever, and why
   *   deleting the pool loses nothing: everything rematerializes byte-identically.
   * - **Atomic publish.** A concurrent process racing the same tree loses its
   *   rename (a non-empty destination is never replaced), discards its temp and
   *   uses the winner's — identical by construction. No locks.
   * - **Ordering is the caller's**, and it matters: trees reference each other
   *   by relative link, so a caller must publish
   *   dependencies before dependents, and a crash then leaves only complete
   *   trees whose references are complete.
   *
   * The temp sibling lives directly under the pool root (never the work tree),
   * so the publish is a rename within one directory of one filesystem — the same
   * assumption the hardlinks already make.
   */
  public ensureTree(files: FileSet): Computable<string> {
    /* Memoized on the FileSet, so a hit costs the lookup and an existsSync —
     * which is why nothing here needs deferring behind a thunk. */
    const key = files.toManifestHash();
    const entry = path.resolve(this.treeRoot, key);
    if (fs.existsSync(entry)) {
      return Computable.resolve(entry);
    }
    const running = this.inflightTrees.get(key);
    if (running) {
      return running;
    }
    const result = this.materializeTree(entry, files);
    this.inflightTrees.set(key, result);
    result.finally(() => this.inflightTrees.delete(key));
    return result;
  }

  /** Build the tree in a temp sibling and publish it by rename; a lost race
   * (it now exists — identical content by name) is success. The temp is
   * removed on every path, and registered meanwhile so an interrupted run does
   * not leave it behind. */
  private materializeTree(entry: string, files: FileSet): Computable<string> {
    /* Before anything exists to clean up. */
    this.assertNothingOwnedElsewhere(entry, files);
    fs.mkdirSync(this.treeRoot, { recursive: true });
    /* Built in this process's work tree, which is already the right place for
     * two reasons and needs no scheme of its own for either. It shares the
     * cache's filesystem — the invariant the staged hardlinks impose anyway —
     * so the publish below is a plain same-device rename. And its cleanup is
     * inherited whole: the work root is registered with the exit hook and swept
     * for dead owners at startup, so a crash needs nothing from here. The pool
     * therefore only ever contains complete trees, which is what lets anything
     * scanning it (a future GC, an fsck) trust every directory it sees. */
    const temp = this.createWorkDir("tree-");
    /* The assertion above is what makes a plain {@link storeContent} sound here,
     * and the order is the argument: past it no file is one a caller still owns,
     * so the rename arm — the only one that could evict content out from under
     * someone — is unreachable by construction. What is left is safe: a
     * pool-backed file skips, and an in-memory one takes the ensureBlob arm,
     * whose bytes and hash are the same object. So generated content interns on
     * its way through and every regular file in the tree is a link into the
     * pool, which is what keeps a tree a pure hardlink farm (and what any later
     * link-count reasoning over the pool would rely on). The view it returns
     * carries no origin, so restamp it: writeFileSet attributes a case-collision
     * through it, and the diagnostic should name where the tree came from. */
    return this.storeContent(files)
      .then(backed => writeFileSet(temp, files.origin === undefined ? backed : backed.withOrigin(files.origin)))
      .then(() =>
        rename(temp, entry).catch(err => {
          if (!fs.existsSync(entry)) {
            throw err;
          }
        })
      )
      /* Eager politeness on the failure path — the rename consumed it on the
       * success path, and the work-tree sweep is the backstop for neither. */
      .finally(() => this.releaseWorkDir(temp))
      .then(() => entry);
  }

  /**
   * Build (or rebuild) the entry: run `create` in a clean scratch dir, then
   * put its outputs. The put is the commit point — on failure the scratch dir
   * is removed and any previous manifest stands untouched.
   */
  private createEntry(key: string, create: (targetDir: string) => Computable<FileSet>, meta?: ICacheControl): Computable<FileSet> {
    /* A fresh dir in this process's work tree, not one named by the key: it is
     * scratch, so nothing about it needs to be findable from the key, and an
     * owner-named dir is one another process can neither collide with nor be
     * confused by (see {@link reclaimWorkTree}). */
    const targetDir = this.createWorkDir();
    /* The work dir is scratch either way: on success its outputs now live in
     * the content pool with the manifest written, and on failure the partial
     * work must go so a retry starts fresh. The `<key>.manifest` file is
     * untouched. */
    return create(targetDir)
      .then(result => this.cachePut(key, result, meta))
      .finally(() => this.releaseWorkDir(targetDir));
  }

  private manifestPath(key: string): string {
    return path.resolve(this.root, key + ".manifest");
  }

  /** Read the entry stored under the (hashed) key, if any: its (blob-backed)
   * files plus the cache-control metadata of a non-immutable entry.
   *
   * A missing entry is read as an ENOENT rather than tested for first: the open
   * settles the question the probe could only guess at (an entry can be written
   * or reclaimed between the two), and the read is one path resolution instead
   * of two — this is the hottest lookup in the cache. */
  private cacheGet(key: string): Computable<ICacheEntry | undefined> {
    const file = this.manifestPath(key);
    return readFile(file).then<ICacheEntry | undefined>(
      data => {
        try {
          return this.parseManifest(data);
        } catch {
          /* A corrupt or truncated manifest is treated as a miss, not a hard
           * failure: delete it so the entry rebuilds cleanly. This honors "the
           * cache is safe to delete" at entry grain — a half-written line (a
           * missing field, an undecodable name) must never fail the build forever. */
          fs.rmSync(file, { force: true });
          return undefined;
        }
      },
      err => {
        if (isNotFound(err)) {
          return undefined;
        }
        throw err;
      }
    );
  }

  /**
   * Store an entry under the (hashed) key: ingest the files into the blob pool
   * (a no-op for files already there — re-putting a held entry just rewrites
   * its manifest) and write the manifest, with the cache-control metadata for
   * a non-immutable entry. Returns the entry's cache-backed view.
   */
  private cachePut(key: string, files: FileSet, meta?: ICacheControl): Computable<FileSet> {
    return this.storeContent(files).then(stored => this.storeManifest(this.manifestPath(key), stored, meta));
  }

  /**
   * Write the entry's manifest and return its cache-backed view: in one pass,
   * serialize each file (just `hash name`) to the manifest AND build a FileSet of
   * BuildFiles rooted at the store. That view is the SAME representation a later
   * cache hit deserialises, so an entry surfaces with a stable IFile identity
   * whether freshly built or served from disk. A mutable entry's freshness
   * metadata leads the manifest as a `!meta` header line.
   *
   * Every regular file is blob-backed by now (storeContent ran), so its content
   * path is implicitly `blob/<hash>` and needn't be stored — but its original
   * mode does (as octal), since the blob itself is read-only 0o444/0o555 and the
   * true permission bits must survive to reapply on export. A symlink has no
   * blob — its target is its whole content — so it gets a distinct `@link` line
   * carrying the target inline (see LINK_PREFIX); today only npm-tarball unpack
   * produces one, since `getResultFileSet` collects only regular files.
   */
  private storeManifest(manifestPath: string, files: FileSet, meta?: ICacheControl): Computable<FileSet> {
    let manifest = meta ? `${META_PREFIX}${JSON.stringify(meta)}\n` : "";
    const backed = new Map<string, IFile>();
    for (const [name, file] of files) {
      if (file instanceof SymlinkFile) {
        manifest += `${LINK_PREFIX}${encodeURI(file.target)} ${encodeURI(name)}\n`;
        backed.set(name, file);
        continue;
      }
      /* The mime rides after the name (names are encodeURI'd, so the name can
       * never eat it). parseManifest requires the field, so an old-format
       * (mime-less) entry re-reads as malformed — a miss — and rebuilds: the
       * intended behavior for a manifest format change (the format-change
       * equivalent of a tag bump). */
      manifest += `${file.hash} ${file.mode.toString(8)} ${encodeURI(name)} ${file.mime}\n`;
      backed.set(name, new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime));
    }
    /* Write atomically (temp + rename), like blobs: a crash mid-write must not
     * leave a truncated manifest that `lookup`'s bare `existsSync` would trust,
     * deserialising to a silently-incomplete FileSet served as a hit forever.
     * The same rename atomically *replaces* an existing manifest on a mutable
     * entry's refresh — safe for concurrent readers, whose deserialised views
     * are blob-backed (blobs are never deleted). */
    const tmp = this.tempPath("manifest");
    return writeFile(tmp, manifest)
      .then(() => rename(tmp, manifestPath))
      .then(() => new FileSet(backed, undefined, CANONICAL));
  }

  /**
   * Refuse to materialize a tree from a file that lives at a path the cache
   * does not own — content someone else is holding, at a path they may still
   * write to.
   *
   * There is no safe way to take one. Staging is by HARDLINK, so taking it
   * would share an inode with that writer — making a content-named tree, which
   * everything downstream treats as immutable, mutable behind its readers.
   * Ingesting it into the pool first is no better: a RENAME evicts a file its
   * owner still expects to find, and taking its BYTES reads them now while
   * `file.hash` was recorded earlier, so a path that has drifted in between
   * lands under the stale hash — poisoning a blob every future consumer of that
   * hash then shares. The pool's whole discipline is that a file's hash and its
   * bytes come from ONE read; this is the only place that could separate them,
   * so it refuses instead.
   *
   * Nothing legitimate is being turned away: fetched, built and snapshot
   * content is pool-backed by construction, and generated content is in memory
   * (its bytes and its hash are the same object, so staging writes exactly what
   * was hashed). A path-backed file arriving here means something upstream
   * broke the delivery contract, which is worth a loud failure at the boundary
   * rather than a quiet one inside a tree everything else will trust.
   */
  private assertNothingOwnedElsewhere(entry: string, files: FileSet): void {
    for (const [name, file] of files) {
      const abspath = file.getAbsPath();
      if (abspath !== undefined && !(file instanceof SymlinkFile) && abspath !== path.resolve(this.blobRoot, file.hash)) {
        throw new Error(
          `Internal error: cannot materialize the tree '${entry}' from '${name}', which lives outside the cache at '${abspath}'`
        );
      }
    }
  }

  /**
   * Ingest every file of a completed build step's result into the shared
   * content-addressed pool — in-memory files by their bytes, files the step
   * wrote to its work dir by a rename (no copy; already hashed) — and return a
   * FileSet of blob-backed BuildFiles. So all content lives in one pool keyed by
   * hash (deduplicated globally), and the work dir can be discarded afterwards.
   */
  private storeContent(files: FileSet): Computable<FileSet> {
    const map = new Map<string, IFile>();
    const ops: Computable<void>[] = [];
    for (const [name, file] of files) {
      if (file instanceof SymlinkFile) {
        /* A symlink carries its target inline in the manifest, not a blob:
         * pass it through unchanged (storeManifest serialises it as a link
         * line). Its "content" is the link text, which would otherwise become
         * a regular blob and lose its symlink-ness across the cache. */
        map.set(name, file);
        continue;
      }
      if (file instanceof BuildFile && file.getAbsPath() === path.resolve(this.blobRoot, file.hash)) {
        /* Already one of our blobs (a re-put entry, or content shared with
         * another entry): nothing to ingest, not even an existence probe. */
        map.set(name, file.name === name ? file : new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime));
        continue;
      }
      const abspath = file.getAbsPath();
      const stored =
        abspath === undefined
          ? file.getBuffer().then(buffer => this.ensureBlob(file.hash, buffer, file.mode))
          : this.ingestFile(file.hash, abspath, file.mode);
      ops.push(stored.then(() => undefined));
      /* The mime carries over from the incoming file — classified wherever its
       * bytes were first read (hashing, streaming) — so the rename-ingest arm
       * stays a rename: the store never re-reads content to classify it. */
      map.set(name, new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime));
    }
    return ops.length === 0
      ? Computable.resolve(new FileSet(map, undefined, CANONICAL))
      : Computable.forAll(ops, () => new FileSet(map, undefined, CANONICAL));
  }

  /**
   * Parse a manifest: an optional `!meta` header line, then one line per file
   * — `hash octalmode name mime` for a regular file, `@link target name` for a
   * symlink. Only the FIRST line is ever considered as the header — matching
   * the writer, which only puts it there — so a file line can never be mistaken
   * for it, whatever the file is named. (It couldn't anyway: a file line begins
   * with the content hash, whose hex alphabet excludes `!`, and the name field
   * percent-encodes spaces — but the structural rule makes that safety
   * independent of the hash alphabet.) The mime is required: a mime-less line
   * (a pre-mime entry) is malformed like any other missing field, so the entry
   * rebuilds on demand — the format-change equivalent of a tag bump, never a
   * manual flush.
   */
  private parseManifest(data: string): ICacheEntry {
    const result = new Map();
    let meta: ICacheControl | undefined;
    let pos = 0;
    const end = data.length;
    if (data.startsWith(META_PREFIX)) {
      const eol = data.indexOf("\n");
      meta = JSON.parse(data.substring(META_PREFIX.length, eol < 0 ? end : eol)) as ICacheControl;
      pos = eol < 0 ? end : eol + 1;
    }
    /* Read line by line and field by field over the text as it stands, rather
     * than splitting it into arrays: a large build reads hundreds of thousands
     * of these lines, so every intermediate string here is one per file. */
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
          throw new Error(`Malformed cache manifest link line: '${line}'`);
        }
        result.set(decodeName(rest.substring(gap + 1)), new SymlinkFile(decodeName(rest.substring(0, gap))));
        continue;
      }
      const afterHash = line.indexOf(" ");
      const afterMode = line.indexOf(" ", afterHash + 1);
      const afterName = line.indexOf(" ", afterMode + 1);
      if (afterHash < 0 || afterMode < 0 || afterName < 0) {
        throw new Error(`Malformed cache manifest line: '${line}'`);
      }
      /* Validated, not merely parsed: a corrupt field must fail the parse (and
       * so rebuild the entry) rather than ride on the IFile as a bogus
       * permission mask. */
      const mode = line.substring(afterHash + 1, afterMode);
      let bits = 0;
      for (let i = 0; i < mode.length; i++) {
        const digit = mode.charCodeAt(i) - ZERO;
        if (digit < 0 || digit > 7) {
          throw new Error(`Malformed cache manifest line: '${line}'`);
        }
        bits = bits * 8 + digit;
      }
      if (mode.length === 0) {
        throw new Error(`Malformed cache manifest line: '${line}'`);
      }
      const name = decodeName(line.substring(afterMode + 1, afterName));
      result.set(name, new BuildFile(this.blobRoot, line.substring(0, afterHash), name, bits, line.substring(afterName + 1)));
    }
    /* A manifest is fabr's own memo of a canonical FileSet — its names were
     * canonicalized when the set was constructed and encoded when it was
     * written, so a read-back is trusted without rechecking. */
    return { files: new FileSet(result, undefined, CANONICAL), meta };
  }
}
