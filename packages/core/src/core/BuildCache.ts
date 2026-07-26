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
import * as path from "path";
import { Readable, Transform, Writable } from "stream";
import { Computable } from "./Computable";
import { ICacheControl, openUrlStream } from "./Fetch";
import { CANONICAL, FileSet, IFile } from "./FileSet";
import { deleteFile, HASH_ALGORITHM, hashString, readFile, readFileBuffer, rename, writeFile } from "./FSWrapper";
import { Diagnostic, Log } from "../support/Log";

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
   * (now-complete) hash, and return a cache-backed file named `name`. */
  finalize(name: string): Computable<IFile>;
  /** Abandon the stream and delete its temp file — nothing enters the store. */
  discard(): void;
}

/**
 * What a build step's `run` receives (see IBuildActionDefinition): the scratch
 * work directory plus a factory for streaming outputs. Built by {@link runAction}
 * around the cache, so a step can produce work-dir files (collected afterward) or
 * stream output straight into the store ({@link createOutput}).
 */
export interface IActionContext {
  readonly workDir: string;
  createOutput(): IOutputHandle;
  /** Whether the action should capture a subprocess's output and show it only on
   * failure (`-q`), rather than inherit fabr's stderr and let it stream live. Set
   * by the framework from the run's verbosity. */
  readonly quiet: boolean;
}

const DIAG_SERVING_STALE = Diagnostic.Warn<{ url: string; reason: string }>(
  "cannot refresh {url} ({reason}); serving the cached copy"
);

class BuildFile implements IFile {
  private readonly root: string;
  public name: string;
  public hash: string;

  constructor(root: string, hash: string, name: string) {
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

const META_PREFIX = "!meta ";

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
  /** Clock for freshness decisions (injectable for tests); cache policy only,
   * never a build input. */
  private readonly now: () => number;
  /** The driver's diagnostic log, for cache behavior a user should see
   * (serving a stale copy on a fetch failure). */
  private readonly log: Log;

  /** Counter for unique temp names for blob/manifest writes (with the pid, unique
   * across processes sharing the cache; the +rename is what makes each appear
   * atomically). */
  private tempCounter = 0;
  /**
   * Entries currently being created, by hashed key: a second demand for the
   * same key joins the first's Computable rather than starting its own build
   * (removed once settled — later demands find the entry on disk). This is
   * both a redundant-work dedup (concurrent consumers sharing a package don't
   * re-download it — repository fetches are demanded per consuming collection
   * point, not gated by the per-target cache) AND an in-process write lock on
   * the entry: without it two concurrent misses would both rm+mkdir+write the
   * same targetDir, a genuine race (one's manifest can reference files the
   * other just deleted). Per-process only — two fabr processes sharing a cache
   * directory can still race (that needs on-disk locking; out of scope).
   */
  private readonly inflight = new Map<string, Computable<FileSet>>();

  constructor(cachePath: string, log: Log, now: () => number = Date.now) {
    this.root = cachePath;
    this.blobRoot = path.resolve(cachePath, "blob");
    this.log = log;
    this.now = now;
  }

  public getOrCreate(cacheKey: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    const key = hashString(cacheKey);
    return this.withLock(key, () =>
      this.cacheGet(key).then(entry => (entry && isFresh(entry, this.now()) ? entry.files : this.createEntry(key, create)))
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
    process: (content: Readable, targetDir: string) => Computable<FileSet>,
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
        return this.fetch(key, url, process, headers, entry, options);
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
    process: (content: Readable, targetDir: string) => Computable<FileSet>,
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
          return this.createEntry(key, targetDir => process(stream, targetDir), meta);
        }
        /* 304: only possible for a conditional request (the fetch layer rejects
         * it otherwise), so we hold the entry the validators came from —
         * re-putting it refreshes its lifetime in place (its files are already
         * blob-backed, so the content ingest is a no-op). */
        return this.cachePut(key, entry!.files, meta);
      },
      err => {
        if (entry) {
          /* Stale-if-error (per RFC 9111's cannot-reach-the-origin allowance):
           * a held copy beats failing the build on a registry blip — but never
           * silently. */
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
   * blob a later `existsSync` would trust.
   */
  public ensureBlob(hash: string, bytes: Buffer): Computable<string> {
    return this.materializeBlob(hash, blobPath => {
      const tmp = `${blobPath}.tmp-${process.pid}-${this.tempCounter++}`;
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
    fs.mkdirSync(this.blobRoot, { recursive: true });
    const tmpPath = path.resolve(this.blobRoot, `.tmp-${process.pid}-${this.tempCounter++}`);
    const hash = createHash(HASH_ALGORITHM);
    const fileStream = fs.createWriteStream(tmpPath);
    /* Baseline handler so a stream error (e.g. on discard's destroy, or a disk
     * failure before finalize is awaited) never escalates to an uncaught crash;
     * finalize adds its own error->reject on top. */
    fileStream.on("error", () => undefined);
    const sink = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    sink.on("error", () => undefined);
    sink.pipe(fileStream);
    return {
      stream: sink,
      finalize: (name: string): Computable<IFile> =>
        Computable.once<IFile>((resolve, reject) => {
          fileStream.once("error", reject);
          fileStream.once("finish", () => {
            const digest = hash.digest("hex");
            this.materializeBlob(digest, blobPath => this.renameIntoPool(tmpPath, blobPath)).then(
              () => resolve(new BuildFile(this.blobRoot, digest, name)),
              reject
            );
          });
          sink.end();
        }),
      discard: (): void => {
        sink.destroy();
        fileStream.destroy();
        fs.rmSync(tmpPath, { force: true });
      },
    };
  }

  /**
   * Move an already-written file (a build step's output, sitting in its work
   * dir) into the pool under `hash` — a rename, not a copy, since we already
   * hashed it. Rename preserves the file's mode, so a unique-content executable
   * keeps its exec bit. (Two byte-identical files that want *different* modes
   * would share one blob — rare, and the same content-vs-mode limitation as
   * source snapshots; a per-entry mode in the manifest is the eventual fix.)
   */
  private ingestFile(hash: string, sourcePath: string): Computable<string> {
    return this.materializeBlob(hash, blobPath => this.renameIntoPool(sourcePath, blobPath));
  }

  /**
   * Put content into the pool at `<blobRoot>/<hash>`: reuse an existing blob,
   * else `materialise` it (which must place it *atomically* at the given path).
   * No in-flight lock is needed — the atomic rename makes concurrent writers of
   * the same hash safe (identical content, atomic replace); the worst case is a
   * redundant temp-write that never corrupts the result.
   */
  private materializeBlob(hash: string, materialise: (blobPath: string) => Computable<void>): Computable<string> {
    const blobPath = path.resolve(this.blobRoot, hash);
    if (fs.existsSync(blobPath)) {
      return Computable.resolve(blobPath);
    }
    fs.mkdirSync(this.blobRoot, { recursive: true });
    return materialise(blobPath).then(() => blobPath);
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

  /**
   * Build (or rebuild) the entry: run `create` in a clean scratch dir, then
   * put its outputs. The put is the commit point — on failure the scratch dir
   * is removed and any previous manifest stands untouched.
   */
  private createEntry(key: string, create: (targetDir: string) => Computable<FileSet>, meta?: ICacheControl): Computable<FileSet> {
    const targetDir = path.resolve(this.root, key);
    /* Any existing directory content is debris from a failed (or crashed)
     * earlier attempt: start from a clean slate. */
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    return create(targetDir)
      .then(result => this.cachePut(key, result, meta))
      .then(result => {
        /* The work dir was only scratch for the step — its outputs now live
         * in the content pool and the manifest is written, so discard it.
         * The `<key>.manifest` sibling file is untouched. */
        fs.rmSync(targetDir, { recursive: true, force: true });
        return result;
      })
      .catch(err => {
        /* Remove the partial entry so a retry starts fresh */
        fs.rmSync(targetDir, { recursive: true, force: true });
        throw err;
      });
  }

  private manifestPath(key: string): string {
    return path.resolve(this.root, key + ".manifest");
  }

  /** Read the entry stored under the (hashed) key, if any: its (blob-backed)
   * files plus the cache-control metadata of a non-immutable entry. */
  private cacheGet(key: string): Computable<ICacheEntry | undefined> {
    const file = this.manifestPath(key);
    if (fs.existsSync(file)) {
      return readFile(file).then(data => this.parseManifest(data));
    } else {
      return Computable.resolve(undefined);
    }
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
   * Every file is blob-backed by now (storeContent ran), so its content path is
   * implicitly `blob/<hash>` and needn't be stored. (A symlink output, which has
   * no content hash, would need a distinct line form recording its target — build
   * steps don't currently produce them; `getResultFileSet` collects only regular
   * files.)
   */
  private storeManifest(manifestPath: string, files: FileSet, meta?: ICacheControl): Computable<FileSet> {
    let manifest = meta ? `${META_PREFIX}${JSON.stringify(meta)}\n` : "";
    const backed = new Map<string, IFile>();
    for (const [name, file] of files) {
      manifest += `${file.hash} ${encodeURI(name)}\n`;
      backed.set(name, new BuildFile(this.blobRoot, file.hash, name));
    }
    /* Write atomically (temp + rename), like blobs: a crash mid-write must not
     * leave a truncated manifest that `lookup`'s bare `existsSync` would trust,
     * deserialising to a silently-incomplete FileSet served as a hit forever.
     * The same rename atomically *replaces* an existing manifest on a mutable
     * entry's refresh — safe for concurrent readers, whose deserialised views
     * are blob-backed (blobs are never deleted). */
    const tmp = `${manifestPath}.tmp-${process.pid}-${this.tempCounter++}`;
    return writeFile(tmp, manifest)
      .then(() => rename(tmp, manifestPath))
      .then(() => new FileSet(backed, undefined, CANONICAL));
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
      if (file instanceof BuildFile && file.getAbsPath() === path.resolve(this.blobRoot, file.hash)) {
        /* Already one of our blobs (a re-put entry, or content shared with
         * another entry): nothing to ingest, not even an existence probe. */
        map.set(name, file.name === name ? file : new BuildFile(this.blobRoot, file.hash, name));
        continue;
      }
      const abspath = file.getAbsPath();
      const stored = abspath === undefined ? file.getBuffer().then(buffer => this.ensureBlob(file.hash, buffer)) : this.ingestFile(file.hash, abspath);
      ops.push(stored.then(() => undefined));
      map.set(name, new BuildFile(this.blobRoot, file.hash, name));
    }
    return ops.length === 0
      ? Computable.resolve(new FileSet(map, undefined, CANONICAL))
      : Computable.forAll(ops, () => new FileSet(map, undefined, CANONICAL));
  }

  /**
   * Parse a manifest: an optional `!meta` header line, then one `hash name`
   * line per file. Only the FIRST line is ever considered as the header —
   * matching the writer, which only puts it there — so a file line can never
   * be mistaken for it, whatever the file is named. (It couldn't anyway: a
   * file line begins with the content hash, whose hex alphabet excludes `!`,
   * and the name field percent-encodes spaces — but the structural rule makes
   * that safety independent of the hash alphabet.)
   */
  private parseManifest(data: string): ICacheEntry {
    const result = new Map();
    let meta: ICacheControl | undefined;
    const lines = data.toString().split("\n");
    if (lines[0]?.startsWith(META_PREFIX)) {
      meta = JSON.parse(lines[0].substring(META_PREFIX.length)) as ICacheControl;
      lines.shift();
    }
    for (const line of lines) {
      if (line) {
        const [hash, name] = line.split(" ");
        result.set(decodeURI(name), new BuildFile(this.blobRoot, hash, decodeURI(name)));
      }
    }
    /* A manifest is fabr's own memo of a canonical FileSet — its names were
     * canonicalized when the set was constructed and encoded when it was
     * written, so a read-back is trusted without rechecking. */
    return { files: new FileSet(result, undefined, CANONICAL), meta };
  }
}
