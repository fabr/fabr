import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { Computable } from "./Computable";
import { openUrlStream } from "./Fetch";
import { FileSet, IFile } from "./FileSet";
import { deleteFile, hardlink, hashFile, hashString, readFile, readFileBuffer, symlink, writeFile } from "./FSWrapper";
import { SymlinkFile } from "./SymlinkFile";
import { describeSystemError, ExecutionError } from "../support/Execute";
import * as picomatch from "picomatch";

export class BuildFile implements IFile {
  private root: string;
  public name: string;
  public hash: string;

  constructor(root: string, name: string, hash: string) {
    this.root = root;
    this.name = name;
    this.hash = hash;
  }

  public readString(encoding?: BufferEncoding): Computable<string> {
    return readFile(path.resolve(this.root, this.name), encoding);
  }

  public getBuffer(): Computable<Buffer> {
    return readFileBuffer(path.resolve(this.root, this.name));
  }

  public getDisplayName(): string {
    return path.resolve(this.root, this.name);
  }

  public isSameFile(file: IFile): boolean {
    return file.getAbsPath() === this.getAbsPath();
  }

  public getAbsPath(): string {
    return path.resolve(this.root, this.name);
  }
}

/**
 * Implemements an MVP build cache.
 *
 * The Source Manifest is hashed and used to look up the target manifest. If not found,
 * we create a directory for the job to write to, and
 */
export class BuildCache {
  private root: string;
  /** Number of entries actually built (cache misses) during this run */
  private builds = 0;
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
  private inflight = new Map<string, Computable<FileSet>>();

  constructor(path: string) {
    this.root = path;
  }

  /**
   * @return the number of entries that had to be built (rather than served
   * from cache) so far — zero meaning the run had no effect.
   */
  public getBuildCount(): number {
    return this.builds;
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
        this.builds++;
        const targetDir = path.resolve(this.root, key);
        /* No manifest means any existing directory content is debris from a
         * failed (or crashed) earlier attempt: start from a clean slate. */
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        return create(targetDir)
          .then(fs => writeMemoryFiles(targetDir, fs))
          .then(fs => this.storeManifest(targetDir, fs))
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
   * serialize each file (all fs-backed by now — writeMemoryFiles ran) to the
   * manifest AND build a FileSet of BuildFiles rooted at the store. That view
   * is the SAME representation a later cache hit deserialises, so an entry
   * surfaces with a stable IFile identity whether freshly built or served from
   * disk — built directly here rather than by re-parsing the manifest.
   */
  private storeManifest(targetDir: string, files: FileSet): Computable<FileSet> {
    let manifest = "";
    const backed = new Map<string, IFile>();
    for (const [name, file] of files) {
      let realpath = file.getAbsPath() as string;
      if (realpath.startsWith(this.root)) {
        realpath = path.relative(this.root, realpath);
      }
      manifest += `${file.hash} ${encodeURI(name)} ${encodeURI(realpath)}\n`;
      backed.set(name, new BuildFile(this.root, realpath, file.hash));
    }
    return writeFile(targetDir + ".manifest", manifest).then(() => new FileSet(backed));
  }

  private deserialiseFileSet(data: string): FileSet {
    const result = new Map();
    data
      .toString()
      .split("\n")
      .forEach(line => {
        if (line) {
          const [hash, name, path] = line.split(" ");
          result.set(decodeURI(name), new BuildFile(this.root, decodeURI(path), hash));
        }
      });
    return new FileSet(result);
  }
}

/**
 * Write all in-memory (or otherwise non-fs-based) files out to disk, and return a FileSet
 * with those files replaced with an equivalent FSFile.
 *
 * @param targetDir Base directory in which to write files.
 * @param files The fileset to write out.
 */
function writeMemoryFiles(targetDir: string, files: FileSet): Computable<FileSet> {
  const map = new Map();
  const output: Computable<void>[] = [];
  for (const [name, file] of files) {
    if (file.getAbsPath() === undefined) {
      const writeName = file.hash + ".dat";
      output.push(file.getBuffer().then(buffer => writeFile(path.resolve(targetDir, writeName), buffer)));
      map.set(name, new BuildFile(targetDir, writeName, file.hash));
    } else {
      map.set(name, file);
    }
  }
  if (output.length === 0) {
    return Computable.resolve(files);
  } else {
    return Computable.forAll(output, () => new FileSet(map));
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
                result.set(relpath, new BuildFile(rootDir, relpath, hash));
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
