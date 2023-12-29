import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Computable } from "./Computable";
import { FileSet } from "./FileSet";

function hash(input: string) {
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
  }

  private ensureExists() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  private lookup(key: string) {
    
  }
}
