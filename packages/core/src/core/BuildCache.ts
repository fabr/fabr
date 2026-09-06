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
import { Computable } from "./Computable";
import { HttpStatusError } from "./Errors";
import { ICacheControl, openUrlStream, reportingProgress } from "./Fetch";
import { CANONICAL, DEFAULT_FILE_MODE, FileSet, IFile } from "./FileSet";

import {
  deleteFile,
  HASH_ALGORITHM,
  hashString,
  isNotDirectoryError,
  isNotFound,
  readdir,
  readFile,
  readFileBuffer,
  readOnlyPermissions,
  rename,
  symlink,
  writeFile,
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
  joinDepsPath,
  manifestLine,
  ABSENT_PREFIX,
  parseDiscoveredDeps,
  parseManifestLine,
  parseRecordedBase,
  sealRecordedBase,
  serializeDiscoveredDeps,
  splitDepsPath,
} from "./Manifest";
import { PackageFileSet } from "./PackageFileSet";
import { RepositoryRef } from "./Repository";
import { mapObject, select } from "../support/Functional";
import { registerTempTree, removeTempTree, writeFileSet } from "./Staging";
import { CacheLink, SymlinkFile } from "./SymlinkFile";
import { computableFind } from "./WorkList";
import { admitted, IOutputHandle, ITaskReport, type TaskTracker } from "../support/Execute";
import { Semaphore } from "../support/Semaphore";
import { Diagnostic, Log } from "../support/Log";
import { SNIFF_LENGTH, sniffMime } from "../support/Mime";

/** What a fetch `process` callback is handed alongside the response stream.
 * Large content should stream straight into the store via {@link createOutput},
 * never through the scratch dir. */
export interface IFetchContext {
  /** A cache-owned scratch dir the process may write files into. */
  readonly targetDir: string;
  /** A streaming CAS-output factory (see {@link getTemporaryWriteStream}). */
  readonly createOutput: () => IOutputHandle;
}

const DIAG_SERVING_STALE = Diagnostic.Warn<{ url: string; reason: string }>(
  "cannot refresh {url} ({reason}); serving the cached copy"
);

/**
 * Options for {@link BuildCache.getOrFetch}. `immutable` (the default) asserts
 * the content can never change: cached forever, cache headers ignored. With
 * `immutable: false` the entry honors HTTP caching instead — origin-declared
 * freshness, then conditional GET.
 *
 * `immutable: false` is only for POINTER documents over immutable content (a
 * registry's version list); content itself replaced under one URL stays banned.
 */
export interface FetchOptions {
  immutable?: boolean;
  /** Revalidate now regardless of remaining freshness — for a caller holding
   * evidence the copy is stale (e.g. it lacks a version known to exist). */
  forceRevalidate?: boolean;
}

/**
 * A build-state record read back — the cache read's own shape, coherent only
 * together, since a tool's state describes what that build emitted.
 *
 * Every part but `outputs` is **absent** where the record has none to give:
 * never recorded, or recorded and no longer readable. A consumer treats the two
 * the same — an absent base means {@link ActionContext.changedFiles} has no
 * answer, and no `incrementalState` means the tool plans cold. `outputs` is
 * always present: without it there is nothing to stage and nothing to check
 * the others against, which is no record at all.
 */
export interface IBuildState {
  /** What was GIVEN to the build — its non-discoverable inputs, by their
   * staged names. Present together with {@link IBuildState.discovered} or not
   * at all: the two are one diff base. */
  readonly inputs?: FileSet;
  /** What the build tried to ACCESS of its discoverable inputs, successfully
   * or not — see {@link IDiscoveredBase}. */
  readonly discovered?: IDiscoveredBase;
  readonly incrementalState?: FileSet;
  readonly outputs: FileSet;
}

/**
 * A build's discovered accesses, read back: each file it reached, named by the
 * path it was reached by, and the paths it looked along that found NOTHING.
 * An absence is an access like any other — the result depended on that path
 * finding nothing (a name nothing answers is one a tool may settle for
 * something else over), so a path that resolves next time is a change, and one
 * no row can state.
 */
export interface IDiscoveredBase {
  readonly files: FileSet;
  readonly absent: ReadonlyArray<string>;
}

/** What moved since the last green build of a target key — see
 * {@link ActionContext.changedFiles}. Each list is sorted. */
export interface IChangedFiles {
  readonly added: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
}

/** A cache entry as read back from disk: its files, plus freshness metadata for
 * a mutable entry. */
interface ICacheEntry {
  files: FileSet;
  meta?: ICacheControl;
}

/** How an entry is demanded (see {@link BuildCache.getOrCreate}). */
export interface ICreateOptions {
  /** Rebuild without consulting what is stored, then commit as usual. Defeats
   * the lookup only — an attempt already in flight for the key is still
   * joined. */
  force?: boolean;
  /** This action's target key — the coordinate its build-state record hangs
   * off. Present for an action belonging to a declared target. */
  targetKey?: string;
  /** The machine-wide execution funnel this entry's work is admitted through,
   * handed to the step on its {@link ActionContext}. A run always supplies its
   * own; a caller with no step to run (a resolution memo, a test) may omit it
   * and gets a funnel that admits everything. */
  processLimit?: Semaphore;
  /**
   * The action's discoverable inputs, present when the demanded key is an
   * **anchor** rather than a complete key: the step reports which of them it
   * read, and the entry is keyed on that selection via
   * {@link preciseActionKey}.
   *
   * A result is never stored under the anchor itself.
   */
  discoverable?: ActionFileInputs;
}

/* The files of a build-state record (see {@link BuildCache.readBuildState}).
 * `outputs` is a symlink to the entry manifest, `state` a manifest in the
 * ordinary dialect; `inputs` holds what was GIVEN to the build (its key text's
 * non-discoverable rows) and `discovered` what it tried to ACCESS — rows at
 * the paths taken, plus the paths that found nothing. The two are one diff
 * base recorded as two facts, written together: `discovered` is present —
 * possibly empty — whenever `inputs` is, which is also what tells this layout
 * from the retired one-file form. */
const STATE_INPUTS_FILE = "inputs";
const STATE_DISCOVERED_FILE = "discovered";
const STATE_OUTPUTS_FILE = "outputs";
const STATE_STATE_FILE = "state";

/** Work trees this process has already taken ownership of, by path — see
 * {@link BuildCache.reclaimWorkTree}. */
const reclaimedRoots = new Set<string>();

const META_PREFIX = "!meta ";

/* A symlink manifest line: `@link <encodeURI(target)> <encodeURI(name)>`. The
 * target rides inline — a symlink has no blob. A regular file line leads with a
 * hex content hash, so the two can never be confused. */
const LINK_PREFIX = "@link ";

/**
 * The build cache: entries keyed by an input manifest hash, over a
 * content-addressed blob pool that also backs source snapshots and step outputs.
 */
export class BuildCache {
  private readonly root: string;

  /* The stores, one resolved root each; each store's methods are grouped below
   * under a heading. Entries themselves have no store — the loose
   * `<hash>.manifest` files sit at the root (see {@link manifestPath}). */

  /** The content pool: one file per distinct content, named by its hash — what
   * every entry's files are ultimately backed by (see {@link ensureBlob}). */
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
  /** The discovered-deps records: one directory per anchor, one immutable file
   * per remembered record. Unbounded until the cache GC covers it. */
  private readonly depsRoot: string;
  /** What the next build of a target key works from: one directory per target
   * key, holding the previous build's input manifest, a link to the entry it
   * produced, and the tool's own kept state (see {@link writeBuildState}). */
  private readonly incrementalRoot: string;
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
  /** Entries currently being created, by hashed key: a second demand joins the
   * first rather than starting its own build. This process only — two runs
   * sharing a cache duplicate the effort, each in its own work tree. */
  private readonly inflight = new Map<string, Computable<FileSet>>();

  /** Trees currently being materialized, by name — the dedup {@link inflight}
   * gives entries. */
  private readonly inflightTrees = new Map<string, Computable<string>>();

  /** The generation each target key is up to, and the newest whose build state
   * has been written — see {@link beginBuildStateAttempt}. */
  private readonly stateGenerations = new Map<string, number>();
  private readonly statesWritten = new Map<string, number>();

  constructor(cachePath: string, log: Log, now: () => number = Date.now) {
    this.root = cachePath;
    this.blobRoot = path.resolve(cachePath, "blob");
    this.treeRoot = path.resolve(cachePath, "tree");
    this.workRoot = path.resolve(cachePath, "work");
    this.ownWorkRoot = path.resolve(this.workRoot, `${hostTag()}-${process.pid}`);
    this.depsRoot = path.resolve(cachePath, "deps");
    this.incrementalRoot = path.resolve(cachePath, "incremental");
    this.log = log;
    this.now = now;
    this.reclaimWorkTree();
  }

  /*
   * ── Work tree ───────────────────────────────────────────────
   * Everything transient, under one subtree per process: build-step scratch, the
   * temps behind every atomic write, and the installs the interactive verbs
   * stage. Reclaimed at construction, reaped for dead pids, released on exit.
   */

  /**
   * Take ownership of this process's work subtree (`work/<host>-<pid>/`), and
   * reap the subtrees of processes that are gone.
   *
   * Liveness is `kill(pid, 0)`. Other hosts' subtrees are never touched — their
   * pids mean nothing here, and they are their owners' to reap.
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
   * A fresh scratch directory in this process's work tree. Release it with
   * {@link releaseWorkDir}; the exit hook and the startup sweep are backstops.
   *
   * It is inside the store's own tree because staged files are hardlinks to
   * blobs — a work dir on another filesystem could not be populated at all
   * (EXDEV).
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

  /**
   * The entry for `cacheKey`, built by `create` if it is not already held.
   *
   * With {@link ICreateOptions.discoverable} the demand is two-phase: the key is
   * an anchor, so the lookup is a {@link cacheGetDiscovered} instead, and the result is
   * stored under the precise key its reported reads make.
   */
  public getOrCreate(
    cacheKey: string,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet> {
    return this.demand(cacheKey, undefined, create, options);
  }

  /**
   * {@link getOrCreate} for a build ACTION, which is the demand whole: the key
   * text, the discoverable inputs and the change tracking are read off the
   * action itself, so what the entry is keyed on and what a tracking record
   * holds always come from the one serialization. An `options.discoverable` is
   * ignored — the action's governs.
   */
  public getOrCreateAction(
    action: BuildAction,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet> {
    return this.demand(action.actionKey(), action, create, options);
  }

  private demand(
    cacheKey: string,
    action: BuildAction | undefined,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet> {
    const anchorKey = hashString(cacheKey);
    const discoverable = action === undefined ? options?.discoverable : action.discoverable;
    /* The scratch dir exists only once createEntry has made it, so the context
     * is built here, around it, as the entry is about to be built. */
    const inContext = (targetDir: string): Computable<BuildResult> =>
      create(
        new ActionContext(
          this,
          options?.processLimit ?? UNBOUNDED_FUNNEL,
          targetDir,
          options?.targetKey,
          options?.force ?? false,
          action?.inputs,
          discoverable
        )
      );
    /* The lock separates DISCOVERABLE SETS as well as actions: two demands can
     * share an anchor and differ in their discoverable deps (a superseded watch
     * cycle). In-process only, so it needs any key that tells those apart and
     * has no obligation to match the entry key's format. */
    return this.withLock(discoverable === undefined ? anchorKey : hashString(anchorKey + manifestFileInputs(discoverable)), () => {
      if (options?.force) {
        return this.createEntry(anchorKey, inContext, options, undefined, action, discoverable);
      }
      if (discoverable !== undefined) {
        return this.cacheGetDiscovered(anchorKey, discoverable).then(
          hit => hit ?? this.createEntry(anchorKey, inContext, options, undefined, action, discoverable)
        );
      }
      return this.cacheGet(anchorKey).then(entry =>
        entry && isFresh(entry, this.now()) ? entry.files : this.createEntry(anchorKey, inContext, options, undefined, action, discoverable)
      );
    });
  }

  /**
   * {@link cacheGet} for a demand whose key is not yet known: each remembered
   * record is replayed against the current discoverable deps and the key it
   * makes is probed, then the whole-discoverable key — where a non-reporting
   * run's entry lives, and which needs no record — last.
   */
  private cacheGetDiscovered(anchorKey: string, discoverable: ActionFileInputs): Computable<FileSet | undefined> {
    const probe = (record: DiscoveredDeps): Computable<FileSet | undefined> =>
      this.cacheGet(hashString(preciseActionKey(anchorKey, narrowDeps(discoverable, record)))).then(entry => entry?.files);
    return this.discoveredDepsFiles(anchorKey)
      .then(files => computableFind(files, file => this.readDiscoveredDepsDoc(file).then(record => record && probe(record))))
      .then(hit => hit ?? probe(new Map()));
  }

  /**
   * Run one attempt at an entry under the in-process lock: a concurrent demand
   * for the same key joins the running attempt; a settled one is never joined
   * (a failure must retry, not replay).
   *
   * The key a caller locks on must distinguish everything the ANSWER depends on
   * — for a discovered-deps demand, the anchor and the discoverable deps together.
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
   * Download a URL through the cache, passing the response stream through
   * `process` (unpacking an archive, validating a metadata document). The key is
   * the url plus `tag`, a stable `name:version` for what is done to the
   * response — bump it when that changes.
   *
   * `process` runs before anything is recorded, so throwing on invalid content
   * keeps error responses out of the cache.
   *
   * By default a cached download is never refreshed; with `immutable: false` the
   * entry honors HTTP caching instead (see {@link FetchOptions}).
   */
  public getOrFetch(
    url: string,
    tag: string,
    process: (content: Readable, ctx: IFetchContext) => Computable<FileSet>,
    /** Brackets the actual transfer as the caller's task, around the miss path
     * alone; byte progress lands on the report it provides. */
    track: TaskTracker<FileSet>,
    headers?: Record<string, string>,
    options?: FetchOptions
  ): Computable<FileSet> {
    /* `headers` authenticate the request only and are NOT part of the key: an
     * authenticated fetch of a private package caches by URL like any other. */
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
   * Fetch a missing-or-stale entry, conditionally where the held copy carries
   * validators: 304 refreshes its lifetime in place without re-running
   * `process`, fresh content replaces it, and a transient failure serves the
   * held copy.
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
              ).then(result => ({ result })),
            undefined,
            meta
          );
        }
        /* 304 is only possible for a conditional request, so we hold the entry
         * the validators came from; re-putting refreshes its lifetime in place. */
        return this.cachePut(key, entry!.files, meta);
      },
      err => {
        if (entry && isTransientFetchError(err)) {
          /* Stale-if-error (RFC 9111), never silently and only for a transient
           * failure — a definite 4xx answer propagates instead. */
          this.log.log(DIAG_SERVING_STALE, { url, reason: err instanceof Error ? err.message : String(err) });
          return entry.files;
        }
        throw err;
      }
    );
  }

  /*
   * ── Blob pool ───────────────────────────────────────────────
   * One file per distinct content, named by its hash: what every entry's files
   * are backed by, and the one place bytes are written. Immutable and shared —
   * published by rename, removed only by a future GC.
   */

  /**
   * Store `bytes` as an immutable content-addressed blob under `hash`, written
   * atomically so a crash or concurrent writer cannot leave a partial blob.
   * `mode` (default non-executable) sets the blob's read-only permissions.
   */
  public ensureBlob(hash: string, bytes: Buffer, mode: number = DEFAULT_FILE_MODE): Computable<string> {
    return this.materializeBlob(hash, mode, blobPath => {
      const tmp = this.tempPath("blob");
      return writeFile(tmp, bytes).then(() => this.renameIntoPool(tmp, blobPath));
    });
  }

  /**
   * A streaming write into the content store (see {@link IOutputHandle}), the
   * counterpart of {@link ensureBlob}: bytes are hashed on the fly and spooled
   * to a temp file, which `finalize` places in the pool under the completed
   * hash. `discard` drops it unplaced.
   */
  public getTemporaryWriteStream(): IOutputHandle {
    const tmpPath = this.tempPath("stream");
    const hash = createHash(HASH_ALGORITHM);
    const fileStream = fs.createWriteStream(tmpPath);
    /* `pipe` auto-unpipes on a destination error and no `finish` ever fires, so
     * finalize cannot wait on `finish` alone or it hangs: capture the first
     * error on either stream and reject with it. */
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
    /* Destroy both streams, then drop the temp file — but only once the spool has
     * CLOSED: `createWriteStream` opens asynchronously, so unlinking with an open
     * in flight lets that open recreate the file after the removal. Removal is
     * best-effort; a cleanup failure must not outrank the reported outcome. */
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
   * Move an already-written file into the pool under `hash` — a rename, not a
   * copy. `mode` is the file's real permission bits, used to set the blob
   * read-only; the original mode lives in the manifest, so two byte-identical
   * files with different modes share one blob and still export at their own.
   */
  private ingestFile(hash: string, sourcePath: string, mode: number): Computable<string> {
    return this.materializeBlob(hash, mode, blobPath => this.renameIntoPool(sourcePath, blobPath));
  }

  /**
   * Put content into the pool at `<blobRoot>/<hash>`: reuse an existing blob,
   * else `materialise` it — which MUST place it atomically at the given path.
   * No lock is needed; concurrent writers of one hash write identical content.
   *
   * The blob is chmod'd read-only (executable iff `mode` is), so a launched tool
   * cannot write through a staged hardlink into it.
   */
  private materializeBlob(hash: string, mode: number, materialise: (blobPath: string) => Computable<void>): Computable<string> {
    const blobPath = path.resolve(this.blobRoot, hash);
    if (fs.existsSync(blobPath)) {
      /* Only ever ADD the exec bit: byte-identical files with different modes
       * share this blob, and a hardlink cannot be chmod'd apart from it. */
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

  /*
   * ── Tree pool ───────────────────────────────────────────────
   * The blob pool one dimension up: one directory per materialized tree, named
   * by the manifest hash of its contents, files hardlinked out of the blob pool.
   * Immutable, shared, published atomically, reclaimed only by a future GC.
   */

  /** Where {@link ensureTree} publishes, as an absolute path on this machine. */
  public get treePath(): string {
    return this.treeRoot;
  }

  /** The tree pool as a mountable link, for a step that addresses trees by name
   * itself rather than mounting one at a position. */
  public get treePoolLink(): CacheLink {
    return new CacheLink(path.relative(this.root, this.treeRoot), this.root);
  }

  /**
   * Materialize `files` once, permanently, and return the path of the tree. An
   * existing tree is served as it stands; a missing one is built in a temp
   * sibling and published by a single atomic rename.
   *
   * **The tree at `tree/<H>` is the materialization of the FileSet whose
   * manifest hashes to `H`** — there is no key to pass, so a deleted tree
   * rebuilds under the same name and any tree can be checked by re-manifesting
   * what it holds. (Its files carry the blob pool's read-only bits, not the
   * modes the manifest records.)
   *
   * Files are hardlinks out of the blob pool; the publish is atomic and
   * lock-free, a racing process using the winner's tree.
   *
   * **Ordering is the caller's**: trees reference each other by relative link,
   * so publish dependencies before dependents.
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
    /* Built in this process's work tree: same filesystem, so the publish is a
     * same-device rename, and its cleanup is inherited from the work root's exit
     * hook and startup sweep. */
    const temp = this.createWorkDir("tree-");
    /* Past the assertion above, no file is one a caller still owns, so
     * storeContent's rename arm is unreachable. Restamp the returned view — it
     * carries no origin, and writeFileSet attributes a case-collision through it. */
    return (
      this.storeContent(files)
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
        .then(() => entry)
    );
  }

  /**
   * Build (or rebuild) the entry: run `create` in a clean scratch dir, then put
   * its outputs. The put is the commit point — on failure the scratch dir goes
   * and any previous manifest stands untouched.
   *
   * With `discoverable` the demanded key is the anchor, and the entry is stored
   * under the precise key the run's reported reads make. A failed run records
   * nothing.
   */
  private createEntry(
    key: string,
    create: (targetDir: string) => Computable<BuildResult>,
    options?: ICreateOptions,
    meta?: ICacheControl,
    /** The demanded action, where the demand is one — what a tracking record's
     * inputs part and the discoverable narrowing are derived from. */
    action?: BuildAction,
    discoverable?: ActionFileInputs
  ): Computable<FileSet> {
    const { targetKey } = options ?? {};
    const targetDir = this.createWorkDir();
    /* Taken at the miss, not the commit: an attempt superseded while it ran must
     * not move the target key's record backwards on its way out. */
    const attempt = targetKey === undefined ? undefined : this.beginBuildStateAttempt(targetKey);
    return create(targetDir)
      .then(produced =>
        this.mergedSelection(
          discoverable === undefined ? undefined : produced.discoveredDeps,
          discoverable,
          targetKey,
          options?.force === true
        ).then(selection => {
          /* A step that reports nothing read is taken as having read all of
           * them, which is the selection mentioning no input: every input then
           * keys whole, and the lookup reconstructs that key with no record. */
          const narrowed = discoverable === undefined ? undefined : narrowDeps(discoverable, selection ?? new Map());
          const entryKey = narrowed === undefined ? key : hashString(preciseActionKey(key, narrowed));
          /* The base is what the key was just made of, from the same bag the
           * key's own serialization walks — so the record and the key cannot
           * disagree. Two facts, two parts: what was GIVEN (the
           * non-discoverable inputs' rows) and what was ACCESSED (the rows and
           * absences the discoverable deps narrow to). */
          const inputs =
            action?.trackChangedFiles !== true ? undefined : recordedInputs(action.inputs, Object.keys(discoverable ?? {}));
          const discovered = inputs === undefined ? undefined : recordedDiscovered(narrowed);
          /* Entry first, records second, and only for a run that produced one: a
           * red run commits nothing and records nothing, which is what keeps
           * every record a green build's, and a crash mid-way costs a redundant
           * run rather than leaving a pointer to nothing. */
          return this.cachePut(entryKey, produced.result, meta)
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
   * A run's reported selection, extended with the paths the last green build
   * of this target key accessed — rows and absences alike. An incremental
   * run's program reads FEWER files than a full compile, so its reads alone
   * would narrow both the entry key and the recorded base build over build,
   * until the key over-hits and a recorded absence is forgotten before the
   * package arrives to answer it.
   *
   * A carry needs the per-input attribution the flat record does not keep, so
   * only the single-discoverable-input shape — every current consumer —
   * carries; anything else keeps its reported selection as it stands. A forced
   * build carries nothing: it exists to redo the work, and its own full run's
   * reads are the complete selection.
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
    return path.resolve(this.root, key + ".manifest");
  }

  /*
   * ── Discovered-deps records ───────────────────────────────────
   * What a run read of its discoverable deps, one directory per anchor holding one
   * immutable content-named file per record. Purely advisory — a torn, stale or
   * missing record costs a probe, never a wrong answer. Written only by a green
   * run, never rewritten, unbounded until the GC covers it.
   */

  /** Where an anchor's discovered-deps records live: a directory of immutable
   * files, each named by the hash of the name-set it holds. */
  private discoveredDepsDir(anchor: string): string {
    return path.resolve(this.depsRoot, anchor);
  }

  /** The record files under an anchor, in readdir order; empty for an anchor
   * with no directory. */
  private discoveredDepsFiles(anchor: string): Computable<string[]> {
    const dir = this.discoveredDepsDir(anchor);
    return readdir(dir).then(
      entries => entries.filter(entry => entry.isFile()).map(entry => path.join(dir, entry.name)),
      () => []
    );
  }

  /** One record file's document. Undefined for anything that doesn't read as
   * one. */
  private readDiscoveredDepsDoc(file: string): Computable<DiscoveredDeps | undefined> {
    return readFile(file)
      .then(data => parseDiscoveredDeps(data))
      .catch(() => undefined);
  }

  /**
   * Remember what a successful run read of its discoverable deps: the paths that found
   * the files, never what was found there.
   *
   * A directory of immutable content-named files rather than a list to update,
   * so it is lock-free — an identical record is a no-op, a distinct one a
   * distinct path, and there is no read-modify-write to lose.
   */
  private recordDiscoveredDeps(anchor: string, selection: DiscoveredDeps): Computable<void> {
    const body = serializeDiscoveredDeps(selection);
    const dir = this.discoveredDepsDir(anchor);
    const file = path.join(dir, hashString(body));
    let tmp: string;
    try {
      if (fs.existsSync(file)) {
        return Computable.resolve(undefined);
      }
      fs.mkdirSync(dir, { recursive: true });
      tmp = this.tempPath("deps");
    } catch {
      /* The record is an accelerator: failing to write one costs a redundant run
       * next time and nothing else, so it must never outrank the build's own
       * outcome — on this path or the asynchronous one below. */
      return Computable.resolve(undefined);
    }
    return writeFile(tmp, body)
      .then(() => rename(tmp, file))
      .catch(() => {
        deleteFile(tmp).catch(() => undefined);
        return undefined;
      });
  }

  /*
   * ── Incremental state ───────────────────────────────────────
   * What the next build of a target key works from: a directory per target key
   * holding three facts about one build — the inputs it was made of, the entry
   * it produced, and the state its tool wants kept. Unlike every other store
   * this one is MUTABLE — replaced whole by the newest attempt not overtaken by
   * a later one (see {@link beginBuildStateAttempt}).
   */

  /** Where a target key's build-state record lives: a directory, replaced
   * whole. */
  private buildStatePath(targetKey: string): string {
    return path.resolve(this.incrementalRoot, targetKey);
  }

  /**
   * The build state recorded for `targetKey`, or undefined where there is
   * nothing usable to build on. Damage of any kind — no directory, an old-format
   * file in its place, an unparseable manifest, a dangling `outputs` link, an
   * entry or a state file whose blob has been reclaimed — costs the caller a
   * cold build, never an error.
   *
   * A record's parts are only meaningful together: a tool's state names what
   * that build emitted, so an evicted entry makes the state a source of wrong
   * output rather than a slow build. The link is what invalidates an evicted
   * manifest; {@link isWholeEntry} covers a manifest that still parses over a
   * blob that is gone.
   *
   * Only `outputs` is required. Every other manifest reads as **absent**
   * wherever there is no usable file — never recorded, or recorded and damaged
   * — which a consumer handles the same way: nothing to work from.
   */
  public readBuildState(targetKey: string): Computable<IBuildState | undefined> {
    const dir = this.buildStatePath(targetKey);
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
        /* The entry's files and the tool's kept files must both still be backed;
         * the diff rows are never pool claims, so they are not checked. */
        if (
          outputs === undefined ||
          !this.isWholeEntry(outputs) ||
          (incrementalState !== undefined && !this.isWholeEntry(incrementalState))
        ) {
          return undefined;
        }
        /* The base is BOTH parts or neither: a diff over one half would report
         * its changes as the whole of what moved, which is how a lost deletion
         * on the other half rides into the entry. Requiring `discovered` is
         * also the migration: the retired one-file layout has no such part and
         * so reads as no base at all, never as a base whose dep rows sit in
         * `inputs` masquerading as staged names. */
        const inputs = inputsText === undefined ? undefined : parseRecordedBase(inputsText);
        const discovered = discoveredText === undefined ? undefined : parseRecordedBase(discoveredText);
        return {
          ...(inputs === undefined || discovered === undefined
            ? {}
            : {
                inputs: this.rowsAsFiles(inputs.rows),
                discovered: { files: this.rowsAsFiles(discovered.rows), absent: discovered.absent },
              }),
          incrementalState,
          outputs,
        };
      }
    );
  }

  /** The rows of a recorded base as files. Blob-backed like any other stored
   * file, but nothing ever opens one — the rows exist to be diffed, so they go
   * in uningested and their blobs are not checked. */
  private rowsAsFiles(rows: ReadonlyArray<IManifestRow>): FileSet {
    return new FileSet(
      new Map(rows.map(row => [row.name, new BuildFile(this.blobRoot, row.hash, row.name, row.mode, "")])),
      undefined,
      CANONICAL
    );
  }

  /** A record part read as its own text — the base is key material, not an
   * entry manifest. Absent where there is no file to read (never recorded, the
   * retired single-FILE layout, mid-replacement), and damage is the parser's
   * judgement; a genuine IO failure rethrows exactly as {@link readManifest}'s
   * does — a broken cache must be visible, not silently cold forever. */
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
   * Open an attempt at `targetKey`, answering the generation it is born with.
   *
   * Concurrent attempts at one target key are normal (a watch cycle's rebuild
   * has a different anchor, so the in-flight dedup does not join them). The
   * generation is what lets {@link writeBuildState} advance the record and never
   * move it backwards.
   */
  public beginBuildStateAttempt(targetKey: string): number {
    const next = (this.stateGenerations.get(targetKey) ?? 0) + 1;
    this.stateGenerations.set(targetKey, next);
    return next;
  }

  /**
   * Record what an attempt learned. **The caller must have committed its entry
   * first** — a record naming an entry that never landed is a dangling link.
   *
   * An attempt with nothing to record leaves any existing record alone: the
   * parts there still describe one real earlier build, so a later run may
   * still work from it. A superseded attempt (an older generation than one
   * already written) is refused silently, before it touches the filesystem.
   *
   * The record is built in the work tree and renamed into place over the old
   * one, which must be removed first since `rename(2)` will not replace a
   * non-empty directory. A crash in that window leaves no record — one cold
   * build, self-healing, and never a torn pairing of one build's state with
   * another's inputs.
   */
  public writeBuildState(
    targetKey: string,
    generation: number,
    entryKey: string,
    state: { inputs?: string; discovered?: string; incrementalState?: FileSet }
  ): Computable<void> {
    const { inputs, discovered, incrementalState } = state;
    if (generation <= (this.statesWritten.get(targetKey) ?? 0)) {
      return Computable.resolve(undefined);
    }
    this.statesWritten.set(targetKey, generation);
    /* The directory exists only if there is something to record: a lone
     * `outputs` link would say only what the action's own key already says. */
    if (inputs === undefined && isNothing(incrementalState)) {
      return Computable.resolve(undefined);
    }
    const dir = this.buildStatePath(targetKey);
    let staging: string;
    try {
      fs.mkdirSync(this.incrementalRoot, { recursive: true });
      staging = this.createWorkDir("state-");
    } catch {
      return Computable.resolve(undefined);
    }
    return (
      Computable.forAll(
        [
          /* The base goes in as the key material it IS — written, not rebuilt,
           * each part sealed with a trailing count so a torn or truncated copy
           * reads as no base rather than as a shorter one. Its rows are
           * uningested: they exist to be compared, and nothing ever opens one,
           * so keeping every input's content alive to hold them would be pure
           * cost. `discovered` is written whenever `inputs` is — empty is a
           * fact ("accessed nothing discoverable"), and a reader refuses a
           * base missing the part (see {@link readBuildState}). */
          inputs === undefined
            ? Computable.resolve(undefined)
            : writeFile(path.join(staging, STATE_INPUTS_FILE), sealRecordedBase(inputs)),
          inputs === undefined
            ? Computable.resolve(undefined)
            : writeFile(path.join(staging, STATE_DISCOVERED_FILE), sealRecordedBase(discovered ?? "")),
          isNothing(incrementalState)
            ? Computable.resolve(undefined)
            : this.storeContent(incrementalState).then(stored => this.storeManifest(path.join(staging, STATE_STATE_FILE), stored)),
          /* Relative to where the record will LIVE, not to the work dir it is
           * assembled in. */
          symlink(path.relative(dir, this.manifestPath(entryKey)), path.join(staging, STATE_OUTPUTS_FILE)),
        ],
        () => undefined
      )
        .then(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          return rename(staging, dir);
        })
        /* A work dir is private (mkdtemp's 0700); a record is ordinary store
         * content and readable like the rest of it. */
        .then(() => fs.chmodSync(dir, 0o755))
        .catch(() => {
          /* Advisory in the same sense the discovered-deps record is: failing to
           * record a target key costs its next build a cold compile, which is
           * exactly what having no record costs. It must never outrank the
           * build's outcome. */
          this.releaseWorkDir(staging);
          return undefined;
        })
    );
  }

  /**
   * One file of a build-state record, or undefined where the record has nothing
   * usable to give under that name — never written, evicted (the `outputs`
   * link's ENOENT), a record directory that is not there or is caught
   * mid-replacement, an old-format record FILE in its place (ENOTDIR), or a
   * damaged manifest. A genuine IO failure still surfaces
   * ({@link readManifest}).
   */
  private readRecordFile(dir: string, name: string): Computable<FileSet | undefined> {
    return this.readManifest(path.join(dir, name)).then(entry => entry?.files);
  }

  /*
   * ── Entries ─────────────────────────────────────────────────
   * The cache's main content: one `<hash>.manifest` at the ROOT per key (see
   * {@link manifestPath}), naming the blobs that hold the bytes. Immutable once
   * committed, so a read takes no lock; only creation is serialized.
   */

  /** Whether every file of an entry is still backed by the pool — see
   * {@link readBuildState}. */
  private isWholeEntry(files: FileSet): boolean {
    for (const [, file] of files) {
      if (!(file instanceof SymlinkFile) && !fs.existsSync(path.resolve(this.blobRoot, file.hash))) {
        return false;
      }
    }
    return true;
  }

  /** Read the entry stored under the (hashed) key, if any: its blob-backed files
   * plus the cache-control metadata of a non-immutable entry. A missing entry is
   * read as an ENOENT rather than tested for first — this is the hottest lookup
   * in the cache. */
  private cacheGet(key: string): Computable<ICacheEntry | undefined> {
    return this.readManifest(this.manifestPath(key));
  }

  /**
   * The manifest at `file`, or undefined where there is none to use — a missing
   * file, or a damaged one. **The reader for every manifest fabr stores.**
   *
   * A damaged manifest is DELETED so its entry rebuilds cleanly; the delete is
   * of the path given, so through a symlink it unlinks the LINK and never the
   * manifest that link names. A genuine IO failure (permissions, a failing
   * disk) rethrows rather than reading as a miss — a broken cache must be
   * visible, not silently cold forever.
   *
   * ENOTDIR counts as "no manifest here" beside ENOENT: a path component that
   * is a file (a build-state record in the retired single-FILE layout) means
   * nothing can be read below it, which is a cold build like any other absence.
   * It is judged here, not by a caller downstream, because a rethrown fs error
   * does not reliably carry its `code` back out.
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
   * Store an entry under the (hashed) key: ingest the files into the blob pool
   * (a no-op for files already there — re-putting a held entry just rewrites
   * its manifest) and write the manifest, with the cache-control metadata for
   * a non-immutable entry. Returns the entry's cache-backed view.
   */
  private cachePut(key: string, files: FileSet, meta?: ICacheControl): Computable<FileSet> {
    return this.storeContent(files).then(stored => this.storeManifest(this.manifestPath(key), stored, meta));
  }

  /**
   * Write the manifest and return its cache-backed view, in one pass. That view
   * is the SAME representation a later cache hit deserialises, so an entry has a
   * stable IFile identity whether freshly built or served from disk.
   *
   * The `!meta` header line is always written and always carries the file count
   * ({@link parseManifest} requires it); a mutable entry's freshness metadata
   * rides alongside it.
   *
   * Rows are the shared dialect ({@link manifestLine}) with this document's own
   * trailing field, the mime — a regular file's content path is implicitly
   * `blob/<hash>`, and its original mode rides the row because the blob is
   * read-only and the true bits must survive to reapply on export. A symlink has
   * no blob and gets an `@link` line carrying its target inline, which is this
   * document's own line kind.
   */
  private storeManifest(manifestPath: string, files: FileSet, meta?: ICacheControl): Computable<FileSet> {
    let manifest = `${META_PREFIX}${JSON.stringify({ entries: files.size, ...meta })}\n`;
    const backed = new Map<string, IFile>();
    for (const [name, file] of files) {
      if (file instanceof SymlinkFile) {
        manifest += `${LINK_PREFIX}${encodeName(file.target)} ${encodeName(name)}\n`;
        backed.set(name, file);
        continue;
      }
      /* The mime rides after the name — names are encoded, so the name cannot
       * eat it. */
      manifest += manifestLine(name, file.hash, file.mode, file.mime) + "\n";
      backed.set(name, new BuildFile(this.blobRoot, file.hash, name, file.mode, file.mime));
    }
    /* Write atomically (temp + rename): a crash mid-write must not leave a
     * truncated manifest that deserialises to a silently-incomplete FileSet. The
     * same rename replaces an existing manifest on a mutable entry's refresh. */
    const tmp = this.tempPath("manifest");
    return writeFile(tmp, manifest)
      .then(() => rename(tmp, manifestPath))
      .then(() => new FileSet(backed, undefined, CANONICAL));
  }

  /**
   * Refuse to materialize a tree from a file living at a path the cache does not
   * own — content someone else holds and may still write to. A path-backed file
   * arriving here means something upstream broke the delivery contract; fetched,
   * built, snapshot and generated content are all fine.
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
   * Ingest every file of a completed step's result into the pool — in-memory
   * files by their bytes, work-dir files by a rename — and return a FileSet of
   * blob-backed BuildFiles. The work dir can be discarded afterwards.
   */
  private storeContent(files: FileSet): Computable<FileSet> {
    const map = new Map<string, IFile>();
    const ops: Computable<void>[] = [];
    for (const [name, file] of files) {
      if (file instanceof SymlinkFile) {
        /* A symlink carries its target inline in the manifest, not a blob, so it
         * passes through unchanged. */
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
   * Parse a manifest: the `!meta` header line, then one line per file —
   * `hash octalmode name mime` for a regular file, `@link target name` for a
   * symlink. Only the FIRST line is ever considered as the header, so a file
   * line can never be mistaken for one.
   *
   * Both the header's `entries` count and each line's mime field are
   * **required**, and the count must match the lines read: a manifest torn at a
   * line boundary parses clean and lists fewer files than it was written with,
   * which the count is the only thing that catches. Requiring a field is also
   * how this dialect invalidates — an older manifest lacking one reads as
   * malformed and rebuilds, so there is no version to carry.
   *
   * The count is integrity, not cache control, so it does not reach
   * {@link ICacheEntry.meta}: that stays the freshness facts of a non-immutable
   * entry, absent for an immutable one.
   */
  private parseManifest(data: string): ICacheEntry {
    const result = new Map();
    const end = data.length;
    if (!data.startsWith(META_PREFIX)) {
      throw new Error("Malformed cache manifest: no header line");
    }
    const eol = data.indexOf("\n");
    const header = JSON.parse(data.substring(META_PREFIX.length, eol < 0 ? end : eol)) as {
      entries?: unknown;
    } & Partial<ICacheControl>;
    let pos = eol < 0 ? end : eol + 1;
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
      /* The shared row, with the mime as this document's own trailing field —
       * required, so a mime-less (pre-mime) line is malformed like any other. */
      const entry = parseManifestLine(line);
      if (entry === undefined || entry.extra === undefined) {
        throw new Error(`Malformed cache manifest line: '${line}'`);
      }
      result.set(entry.name, new BuildFile(this.blobRoot, entry.hash, entry.name, entry.mode, entry.extra));
    }
    if (header.entries !== result.size) {
      throw new Error(`Malformed cache manifest: header claims ${String(header.entries)} entries, read ${result.size}`);
    }
    const { expires, etag, lastModified } = header;
    /* A manifest is fabr's own memo of a canonical FileSet — its names were
     * canonicalized when the set was constructed and encoded when it was
     * written, so a read-back is trusted without rechecking. */
    return {
      files: new FileSet(result, undefined, CANONICAL),
      meta: expires === undefined ? undefined : { expires, etag, lastModified },
    };
  }
}

/**
 * What a build step's `run` is given, for one action: its scratch directory,
 * the cache services it may reach, and the funnel its work is admitted through.
 * Everything here is owned by the cache or the execution funnel; where the work
 * is *reported* is the step's separate `report` argument.
 *
 * Constructed by the cache for the entry it is about to build, and by a test
 * driving a step directly.
 */
export class ActionContext {
  private state?: Computable<IBuildState | undefined>;

  /**
   * @param cache the run's build cache, which backs `createOutput`,
   *   `ensureTree`, `treePool` and {@link buildState}.
   * @param processLimit the machine-wide execution funnel.
   * @param workDir this action's scratch directory.
   * @param targetKey the coordinate a build-state record hangs off. Absent for
   *   an action belonging to no declared target, which therefore has none.
   * @param force this build was asked to redo its work, so it is given no base
   *   to shortcut from.
   * @param inputs the action's resolved per-file inputs — the current side of
   *   {@link changedFiles}; absent for a demand that tracks nothing.
   * @param discoverable the action's discoverable inputs, which decide which
   *   half of the comparison a name is judged in.
   */
  constructor(
    private readonly cache: BuildCache,
    public readonly processLimit: Semaphore,
    public readonly workDir: string,
    private readonly targetKey?: string,
    private readonly force = false,
    private readonly inputs?: ActionFileInputs,
    private readonly discoverable?: ActionFileInputs
  ) {}

  /** A streaming CAS-output factory: bytes are hashed as written and placed
   * straight into the content store. */
  public createOutput(): IOutputHandle {
    return this.cache.getTemporaryWriteStream();
  }

  /** Materialize a tree in the cache's pool and answer its path. */
  public ensureTree(files: FileSet): Computable<string> {
    return this.cache.ensureTree(files);
  }

  /** The cache's tree pool as a mountable link, for a step that stages the pool
   * whole and addresses trees in it by name. */
  public get treePool(): CacheLink {
    return this.cache.treePoolLink;
  }

  /**
   * Run the step's own machine-heavy work (staging a tree of inputs) through the
   * execution funnel, announcing its funnel phases on `report`.
   *
   * MUST NOT enclose an `execute`: a slot held while asking for another is
   * hold-and-wait, which deadlocks at capacity. Stage, then run — separate
   * admissions, never nested.
   */
  public admit<T>(report: ITaskReport, work: () => Computable<T>): Computable<T> {
    return admitted(this.processLimit, report, work);
  }

  /**
   * What moved since the last green build of this target key, as one answer:
   * names present now that the base lacked (`added` — a new source, or a
   * dependency lookup that found nothing then and finds a package now), names
   * whose content moved (`changed`), and names the base had that are gone
   * (`deleted`). The action's own inputs are judged by their staged names, the
   * discoverable ones by the path each was accessed by — the same names the
   * step's tool reports its reads in and is handed changes in.
   *
   * Undefined where there is nothing to compare against — a first build, a
   * damaged or old-format record, a forced build — in which case everything is
   * new and the step's tool starts cold. How the answer is computed (what the
   * record holds, which accesses were tracked) is the cache's own business.
   */
  public changedFiles(): Computable<IChangedFiles | undefined> {
    return this.record().then(state =>
      state?.inputs === undefined || state.discovered === undefined || this.inputs === undefined
        ? undefined
        : diffBuildState(this.inputs, this.discoverable, state.inputs, state.discovered)
    );
  }

  /**
   * The files that build's tool asked to keep, as it left them. Absent where it
   * kept none or they are no longer readable, in which case the tool plans cold
   * — see {@link BuildResult.incrementalState}.
   */
  public incrementalState(): Computable<FileSet | undefined> {
    return this.record().then(state => state?.incrementalState);
  }

  /**
   * What that build produced, for a step emitting its delta over the previous
   * output rather than a whole one. Named for the earlier build, not for this
   * action's own outputs.
   */
  public previousOutputs(): Computable<FileSet | undefined> {
    return this.record().then(state => state?.outputs);
  }

  /**
   * The one read the three accessors answer from — memoized, so they cannot
   * disagree about which build they describe and a second caller joins the
   * first's read instead of starting another. A step that asks for none of them
   * reads nothing.
   *
   * Undefined for a first build, an unreadable record, an evicted entry, and
   * for a forced build, which exists to redo the work. Ask as late as the step's
   * own shape allows: the answer is the record as it stands when first asked,
   * not as it stood when the action began.
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

/** Whether a recorded half says nothing — absent and empty are one answer. */
function isNothing(files: FileSet | undefined): files is undefined {
  return files === undefined || files.size === 0;
}

/** What a demand that named no funnel admits work through: everything, at once.
 * The absence of a bound made explicit, rather than a second bound nobody
 * declared — a run always names its own (see {@link ICreateOptions}). */
const UNBOUNDED_FUNNEL = new Semaphore(Number.MAX_SAFE_INTEGER);

/**
 * Whether a refresh failure is transient enough to justify serving a stale copy:
 * any transport failure, any 5xx, and the two retry-later 4xx (408, 429). Every
 * other 4xx is a definite origin answer and must surface as itself.
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

  /** The file's original permission bits from the manifest — NOT the mode of the
   * backing blob, which is read-only. Reapplied when the file is exported or
   * packed. The mime likewise rides the manifest, so a cache-served file
   * classifies with no read. */
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

/** Whether the entry may be served as it stands: the manifest itself says — an
 * entry without cache-control metadata is immutable (fresh forever), one with
 * it is fresh until its expiry. */
function isFresh(entry: ICacheEntry, now: number): boolean {
  return entry.meta === undefined || entry.meta.expires > now;
}

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

/**
 * The INPUTS half of a build's recorded base: what was actually GIVEN to the
 * run — one row per file of the non-discoverable inputs, from the same bag the
 * key's own serialization walks. The discoverable inputs are excluded whole
 * because their diffing face is the {@link recordedDiscovered} part — what the
 * run tried to ACCESS — and a loose member's rows landing here would read as
 * staged names that are never staged, i.e. as a deletion every build.
 */
function recordedInputs(inputs: ActionFileInputs, discoverable: ReadonlyArray<string>): string {
  const excluded = new Set(discoverable);
  return Object.keys(inputs)
    .sort()
    .filter(name => !excluded.has(name))
    .flatMap(name => {
      const value = inputs[name];
      /* Sorted by NAME, per member: canonical against the content, so an edit
       * moves a row's hash and never its place. */
      return (Array.isArray(value) ? value : [value]).flatMap(member =>
        [...member]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([file, held]) => manifestLine(file, held.hash, held.mode))
      );
    })
    .join("\n");
}

/**
 * The DISCOVERED half of a build's recorded base: what the run tried to
 * access, successfully or not — one row per file at the path it was reached
 * by, plus the paths that found nothing. Every input is a genuine selection
 * (see {@link narrowDeps}), so the rows are its files' flat-spelled names as
 * they stand. Empty (never undefined) for an action with nothing discoverable
 * — the part is written regardless (see {@link BuildCache.writeBuildState}).
 */
function recordedDiscovered(used: INarrowedDeps | undefined): string {
  return used === undefined ? "" : baseRows(used).join("\n");
}

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
 * The {@link ActionContext.changedFiles} comparison: the recorded base against
 * the action's current inputs, each half judged in its own world. The action's
 * own inputs compare by staged name against the current bag; a discovered
 * access compares by re-resolving its path against the current delivery —
 * present-and-moved is changed, gone is deleted, and a recorded ABSENCE that
 * resolves now is added, the one change no row could state. Hashes decide,
 * exactly as the entry key does.
 */
function diffBuildState(
  current: ActionFileInputs,
  discoverable: ActionFileInputs | undefined,
  baseInputs: FileSet,
  baseDiscovered: IDiscoveredBase
): IChangedFiles {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  /* The action's own half: the current non-discoverable inputs as one name
   * space, exactly how the recorded rows name them. */
  const now = new Map<string, IFile>();
  for (const name of Object.keys(current)) {
    if (discoverable?.[name] !== undefined) {
      continue;
    }
    const value = current[name];
    for (const member of Array.isArray(value) ? value : [value]) {
      for (const [file, held] of member) {
        now.set(file, held);
      }
    }
  }
  for (const [name, file] of now) {
    const was = baseInputs.getFile(name);
    if (was === undefined) {
      added.push(name);
    } else if (was.hash !== file.hash) {
      changed.push(name);
    }
  }
  for (const [name] of baseInputs) {
    if (!now.has(name)) {
      deleted.push(name);
    }
  }
  /* The discovered half, judged against the delivery that arrived. */
  const members =
    discoverable === undefined
      ? []
      : Object.values(discoverable).flatMap(value => (Array.isArray(value) ? value : [value]));
  for (const [name, was] of baseDiscovered.files) {
    const resolved = resolvePackagePath(members, splitDepsPath(name));
    if (resolved === undefined) {
      deleted.push(name);
    } else if (resolved.hash !== was.hash) {
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

export function narrowDeps(discoverable: ActionFileInputs, selection: DiscoveredDeps): INarrowedDeps {
  return mapObject(discoverable, (input, value) => {
    const members = Array.isArray(value) ? value : [value];
    /* No discovery data for this input — the action believes it discoverable
     * and the run said nothing about it (a non-reporting tool, or a report
     * that omitted the input). The conservative default is applied HERE, once:
     * the selection becomes what a run that read EVERYTHING would have
     * reported, so nothing above this point can tell the two apart. */
    const selectedPaths = selection.get(input) ?? everythingPaths(members);
    const mapped = new Map<string, IFile>();
    const absent: string[] = [];
    for (const path of selectedPaths) {
      const name = joinDepsPath(path);
      const resolved = resolvePackagePath(members, path);
      if (resolved) {
        mapped.set(name, resolved);
      } else {
        absent.push(name);
      }
    }
    return { resolved: new FileSet(mapped, undefined, CANONICAL), absent };
  });
}

/**
 * The maximal selection of an input — what a run that read the whole delivery
 * would have reported, in the report's own vocabulary: every loose member's
 * file, every package's file at the path the canonical walk gives it, and one
 * manifest lookup per walk visit — a root or an EDGE, the same
 * `[route, "package.json"]` row a driver reports per resolution, which is what
 * pins every binding. A manifest-less package settles to an honest absence
 * (looked, found nothing — its manifest appearing later moves the key).
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
 * Walk a dependency path against the input's members and answer the file it
 * ultimately references — undefined where it lands on nothing. **Plain
 * indexing only**: the head is a direct member by delivered name, later hops
 * the requirer's own edges, the leaf a file. Whatever ecosystem semantics
 * decided a recorded path (a fallback-pool answer, an alias) were converted
 * to this form by the REPORTER — the cache replays, it never resolves.
 */
function resolvePackagePath(members: ReadonlyArray<FileSet>, path: DepsPath): IFile | undefined {
  if (path.length === 1) {
    return select(members, member => (member.name === "" ? member.getFile(path[0]) : undefined))[0];
  }
  const pkg = path.slice(1, -1).reduce<FileSet | RepositoryRef | undefined>(
    (prev, file) => (prev instanceof PackageFileSet ? prev.getDependency(file) : undefined),
    members.find(child => child.name === path[0])
  );
  return pkg instanceof FileSet ? pkg.getFile(path.at(-1)!) : undefined;
}
