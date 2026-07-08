import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { Computable } from "./Computable";
import { openUrlStream } from "./Fetch";
import { FileSet, IFile } from "./FileSet";
import { FSFile } from "./FSFileSource";
import { deleteFile, hardlink, hashFile, hashString, readFile, readFileBuffer, symlink, writeFile } from "./FSWrapper";
import { SymlinkFile } from "./SymlinkFile";
import { describeSystemError, ExecutionError } from "../support/Execute";
import * as picomatch from "picomatch";

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

  /** Counter for unique blob temp names (with the pid, unique across processes
   * sharing the cache; the +rename is what makes a blob appear atomically). */
  private blobTempCounter = 0;
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

  constructor(cachePath: string) {
    this.root = cachePath;
    this.blobRoot = path.resolve(cachePath, "blob");
  }

  public getOrCreate(cacheKey: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    const key = hashString(cacheKey);
    const running = this.inflight.get(key);
    if (running) {
      return running;
    }
    const result = this.lookup(key).then(entry => {
      if (entry) {
        return entry;
      } else {
        const targetDir = path.resolve(this.root, key);
        /* No manifest means any existing directory content is debris from a
         * failed (or crashed) earlier attempt: start from a clean slate. */
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        return create(targetDir)
          .then(result => this.storeContent(result))
          .then(result => this.storeManifest(targetDir, result))
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
    });
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
   * Cached downloads are currently never refreshed: this must only be used for
   * URLs whose content is immutable by contract. (Any future invalidation/TTL
   * policy, and integrity verification of downloaded content, belongs here.)
   */
  public getOrFetch(
    url: string,
    tag: string,
    process: (content: Readable, targetDir: string) => Computable<FileSet>
  ): Computable<FileSet> {
    return this.getOrCreate(`fetch:${tag} ${url}`, targetDir => openUrlStream(url).then(ins => process(ins, targetDir)));
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
      const tmp = `${blobPath}.tmp-${process.pid}-${this.blobTempCounter++}`;
      return Computable.from<void>((resolve, reject) => {
        fs.writeFile(tmp, Uint8Array.from(bytes), err => (err ? reject(err) : resolve()));
      }).then(() => this.renameIntoPool(tmp, blobPath));
    });
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
    return Computable.from<void>((resolve, reject) => {
      fs.rename(from, blobPath, err => {
        if (!err) {
          resolve();
          return;
        }
        const won = fs.existsSync(blobPath);
        fs.rm(from, { force: true }, () => (won ? resolve() : reject(err)));
      });
    });
  }

  private lookup(key: string): Computable<FileSet | undefined> {
    const file = path.resolve(this.root, key + ".manifest");
    if (fs.existsSync(file)) {
      return readFile(file).then(data => this.deserialiseFileSet(data));
    } else {
      return Computable.resolve(undefined);
    }
  }

  /**
   * Write the entry's manifest and return its cache-backed view: in one pass,
   * serialize each file (just `hash name`) to the manifest AND build a FileSet of
   * BuildFiles rooted at the store. That view is the SAME representation a later
   * cache hit deserialises, so an entry surfaces with a stable IFile identity
   * whether freshly built or served from disk.
   *
   * Every file is blob-backed by now (storeContent ran), so its content path is
   * implicitly `blob/<hash>` and needn't be stored. (A symlink output, which has
   * no content hash, would need a distinct line form recording its target — build
   * steps don't currently produce them; `getResultFileSet` collects only regular
   * files.)
   */
  private storeManifest(targetDir: string, files: FileSet): Computable<FileSet> {
    let manifest = "";
    const backed = new Map<string, IFile>();
    for (const [name, file] of files) {
      manifest += `${file.hash} ${encodeURI(name)}\n`;
      backed.set(name, new BuildFile(this.blobRoot, file.hash, name));
    }
    return writeFile(targetDir + ".manifest", manifest).then(() => new FileSet(backed));
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
      const abspath = file.getAbsPath();
      const stored = abspath === undefined ? file.getBuffer().then(buffer => this.ensureBlob(file.hash, buffer)) : this.ingestFile(file.hash, abspath);
      ops.push(stored.then(() => undefined));
      map.set(name, new BuildFile(this.blobRoot, file.hash, name));
    }
    return ops.length === 0 ? Computable.resolve(new FileSet(map)) : Computable.forAll(ops, () => new FileSet(map));
  }

  private deserialiseFileSet(data: string): FileSet {
    const result = new Map();
    data
      .toString()
      .split("\n")
      .forEach(line => {
        if (line) {
          const [hash, name] = line.split(" ");
          result.set(decodeURI(name), new BuildFile(this.blobRoot, hash, decodeURI(name)));
        }
      });
    return new FileSet(result);
  }
}

export function writeFileSet(targetDir: string, files: FileSet): Computable<void> {
  const operations = [];
  let realRoot: string | undefined;
  for (const [name, file] of files) {
    const targetName = path.resolve(targetDir, name);
    const dirname = path.dirname(targetName);
    fs.mkdirSync(dirname, { recursive: true });
    const filepath = file.getAbsPath();
    if (file instanceof SymlinkFile) {
      /* Security: a symlink whose target escapes the staged tree (via `..`, an
       * absolute path, or a symlinked parent component) could point at — or,
       * written-through, clobber — files outside it. Resolve the target against
       * the *real* parent directory (path.resolve is purely lexical and would not
       * follow symlinks in the path), and only stage it if it stays within the
       * real root. */
      realRoot ??= fs.realpathSync(path.resolve(targetDir));
      const resolved = path.resolve(fs.realpathSync(dirname), file.target);
      if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) {
        operations.push(asExecutionError(symlink(file.target, targetName)));
      }
    } else if (filepath) {
      operations.push(asExecutionError(hardlink(filepath, targetName)));
    } else {
      operations.push(asExecutionError(file.getBuffer().then(buffer => writeFile(targetName, buffer))));
    }
  }
  return Computable.forAll(operations, () => {});
}

/**
 * Classify failures of a staging operation as execution errors (mechanical
 * failures of the build step, reported grouped per target).
 */
function asExecutionError<T>(operation: Computable<T>): Computable<T> {
  return operation.catch(err => {
    throw new ExecutionError(describeSystemError(err));
  });
}

export function getResultFileSet(targetDir: string, pattern: string): Computable<FileSet> {
  /* A "dir:glob" pattern matches under dir, and names the results relative to
   * it (consistent with the source-name convention) */
  const colon = pattern.indexOf(":");
  const rootDir = colon === -1 ? targetDir : path.resolve(targetDir, pattern.substring(0, colon));
  const matcher = picomatch(colon === -1 ? pattern : pattern.substring(colon + 1));
  const result = new Map<string, IFile>();
  const ops: Computable<void>[] = [];

  return Computable.from((resolve, reject) => {
    fs.readdir(targetDir, { withFileTypes: true, recursive: true }, (err, dirents) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        dirents.forEach(dirent => {
          if (!dirent.isFile()) {
            return;
          }
          /* Note: with recursive readdir, dirent.name is only the basename.
           * The containing directory is parentPath on current node versions,
           * but the (since removed) path on the ones our current @types are for. */
          const entry = dirent as typeof dirent & Partial<{ parentPath: string; path: string }>;
          const abspath = path.resolve(entry.parentPath ?? entry.path ?? targetDir, dirent.name);
          const relpath = path.relative(rootDir, abspath);
          if (!relpath.startsWith("..") && matcher(relpath)) {
            ops.push(
              hashFile(abspath).then(hash => {
                /* A work-dir output is path-backed (content at its relpath, not
                 * at a blob hash), so it can't be a BuildFile — storeContent then
                 * ingests it into the pool by rename. */
                result.set(relpath, new FSFile(rootDir, relpath, fs.statSync(abspath), hash));
              })
            );
          } else {
            /* Prune staged inputs, retaining only the results in the cache entry */
            ops.push(asExecutionError(deleteFile(abspath)));
          }
        });
      } catch (direntErr) {
        reject(direntErr);
        return;
      }
      Computable.forAll(
        ops,
        () => resolve(new FileSet(result)),
        opErr => reject(opErr)
      );
    });
  });
}
