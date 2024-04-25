import * as fs from "fs";
import * as path from "path";
import { Computable } from "./Computable";
import { EMPTY_FILESET, FileSet, IFile } from "./FileSet";
import { hashString, readFile, readFileBuffer, writeFile } from "./FSWrapper";

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

  public getFileSet(manifest: string): Computable<FileSet | undefined> {
    const key = hashString(manifest);
    const result = this.lookup(key);
    return Computable.resolve(EMPTY_FILESET);
  }

  public getOrCreate(manifest: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    const key = hashString(manifest);
    return this.lookup(key).then(result => {
      if (result) {
        return result;
      } else {
        const targetDir = path.resolve(this.root, key);
        fs.mkdirSync(targetDir, { recursive: true });
        return create(targetDir)
          .then(fs => writeMemoryFiles(targetDir, fs))
          .then(fs => writeFile(targetDir + ".manifest", this.serializeFileSet(fs)).then(() => fs));
      }
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
        const [hash, name, path] = line.split(" ");
        result.set(decodeURI(name), new BuildFile(this.root, decodeURI(path), hash));
      });
    return new FileSet(result);
  }
}

/**
 * Write all in-memory (or otherwise non-fs-based) files out to disk, and return a FileSet
 * with those files replaced with an equivalent FSFile.
 *
 * @param targetDir Base directory in which to write files.
 * @param fs The fileset to write out.
 */
function writeMemoryFiles(targetDir: string, fs: FileSet): Computable<FileSet> {
  const map = new Map();
  const output: Computable<void>[] = [];
  for (const [name, file] of fs) {
    if (file.getAbsPath() === undefined) {
      const writeName = file.hash + ".dat";
      output.push(file.getBuffer().then(buffer => writeFile(writeName, buffer)));
      map.set(name, new BuildFile(targetDir, writeName, file.hash));
    } else {
      map.set(name, file);
    }
  }
  if (output.length === 0) {
    return Computable.resolve(fs);
  } else {
    return Computable.forAll(output, () => new FileSet(map));
  }
}
