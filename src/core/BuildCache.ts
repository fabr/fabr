import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { Computable } from "./Computable";
import { openUrlStream } from "./Fetch";
import { FileSet, IFile } from "./FileSet";
import { deleteFile, hardlink, hashFile, hashString, readFile, readFileBuffer, writeFile } from "./FSWrapper";
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
  constructor(path: string) {
    this.root = path;
  }

  public getOrCreate(manifest: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    const key = hashString(manifest);
    return this.lookup(key).then(result => {
      if (result) {
        return result;
      } else {
        const targetDir = path.resolve(this.root, key);
        /* No manifest means any existing directory content is debris from a
         * failed (or crashed) earlier attempt: start from a clean slate. */
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        return create(targetDir)
          .then(fs => writeMemoryFiles(targetDir, fs))
          .then(fs => writeFile(targetDir + ".manifest", this.serializeFileSet(fs)).then(() => fs))
          .catch(err => {
            /* Remove the partial entry so a retry starts fresh */
            fs.rmSync(targetDir, { recursive: true, force: true });
            throw err;
          });
      }
    });
  }

  /**
   * Download a URL through the cache: the cache key IS the url (by construction
   * — the fetch and the key cannot diverge), and the entry is created by passing
   * the response stream through the given process callback (e.g. unpacking an
   * archive, or validating and storing a metadata document).
   *
   * The process callback runs before anything is recorded in the cache, so
   * throwing on invalid content guarantees error responses are never cached.
   * Cached downloads are currently never refreshed: this must only be used for
   * URLs whose content is immutable by contract. (Any future invalidation/TTL
   * policy, and integrity verification of downloaded content, belongs here.)
   */
  public getOrFetch(url: string, process: (content: Readable, targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.getOrCreate(url, targetDir => openUrlStream(url).then(ins => process(ins, targetDir)));
  }

  private lookup(key: string): Computable<FileSet | undefined> {
    const file = path.resolve(this.root, key + ".manifest");
    if (fs.existsSync(file)) {
      return readFile(file).then(data => this.deserialiseFileSet(data));
    } else {
      return Computable.resolve(undefined);
    }
  }

  private serializeFileSet(data: FileSet): string {
    let result = "";
    for (const [name, file] of data) {
      let realpath = file.getAbsPath() as string; // Note: by the time we get here, we've replaced all non-fs files
      if (realpath.startsWith(this.root)) {
        realpath = path.relative(this.root, realpath);
      }
      result += `${file.hash} ${encodeURI(name)} ${encodeURI(realpath)}\n`;
    }
    return result;
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
  for (const [name, file] of files) {
    const targetName = path.resolve(targetDir, name);
    const dirname = path.dirname(targetName);
    fs.mkdirSync(dirname, { recursive: true });
    const filepath = file.getAbsPath();
    if (filepath) {
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
  const matcher = picomatch(pattern);
  const result = new Map();
  const ops: Computable<void>[] = [];
  const dirs = [];

  return Computable.from((resolve, reject) => {
    fs.readdir(targetDir, { withFileTypes: true, recursive: true }, (err, dirents) => {
      if (err) {
        reject(err);
      } else {
        dirents.forEach(dirent => {
          if (dirent.isFile() && matcher(dirent.name)) {
            ops.push(
              hashFile(path.resolve(targetDir, dirent.name)).then(hash => {
                result.set(dirent.name, new BuildFile(targetDir, dirent.name, hash));
              })
            );
          } else {
            if (dirent.isDirectory()) {
              dirs.push(dirent.name);
            } else {
              ops.push(deleteFile(path.resolve(targetDir, dirent.name)));
            }
          }
        });
      }
      Computable.forAll(ops, () => resolve(new FileSet(result)));
    });
  });
}
