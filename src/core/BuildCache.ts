import * as crypto from "crypto";
import * as fs from "fs";
import { Computable } from "./Computable";
import { EMPTY_FILESET, FileSet } from "./FileSet";

function hash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export class BuildCache {
  private root: string;
  constructor(path: string) {
    this.root = path;
    this.ensureExists();
  }

  public getFileSet(manifest: string): Computable<FileSet | undefined> {
    const key = hash(manifest);
    const result = this.lookup(key);
    return Computable.resolve(EMPTY_FILESET);
  }

  private ensureExists(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  private lookup(key: string): void {}
}
