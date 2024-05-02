/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import { Name } from "../model/Name";

import { Computable } from "./Computable";
import { FileSet, IFile, FileSource } from "./FileSet";
import { hashFile, readFile, readFileBuffer } from "./FSWrapper";
import * as picomatch from "picomatch";

export interface FSFileStats {
  size: number;
  mtime: Date;
}

export class FSFile implements IFile {
  private root: string;
  public stat: FSFileStats;
  public name: string;
  public hash: string;

  constructor(root: string, name: string, stat: FSFileStats, hash: string) {
    this.root = root;
    this.name = name;
    this.stat = stat;
    this.hash = hash;
  }

  public readString(encoding?: BufferEncoding): Computable<string> {
    return readFile(path.resolve(this.root, this.name), encoding);
  }

  public getDisplayName(): string {
    return path.resolve(this.root, this.name);
  }

  public isSameFile(file: IFile): boolean {
    return file instanceof FSFile && this.getDisplayName() === file.getDisplayName();
  }

  public getAbsPath(): string {
    return path.resolve(this.root, this.name);
  }

  public getBuffer(): Computable<Buffer> {
    return readFileBuffer(path.resolve(this.root, this.name));
  }
}

/**
 * FileSet implementation that loads the directory tree from the real FS on demand
 */
export class FSFileSource implements FileSource {
  protected root: string;
  constructor(root: string) {
    this.root = root;
  }

  /**
   * FIXME: This has multiple issues - it never closes even if the dependency
   * is otherwise drops, and it has no way to actually apply the post-ready
   * updates when we're in real watch mode.
   * @param name
   * @returns
   */
  public find(name: Name): Computable<FileSet> {
    return Computable.from<FileSet>((resolve, reject) => {
      const nameString = name.toString();
      const colonIdx = nameString.lastIndexOf(":");
      const stripPrefix =
        colonIdx === -1 ? undefined : new RegExp("^" + picomatch.parse(nameString.substring(0, colonIdx) + "/").output);
      const searchString = nameString.replace(":", "/");
      console.log("Chokidaring " + this.root + ":" + searchString);
      const watch = chokidar.watch(searchString, {
        cwd: this.root,
        persistent: false,
      });
      const files: Map<string, Computable<FSFile>> = new Map();
      watch.on("add", (path, stat) => {
        files.set(path, this.fileAdded(path, stat));
      });
      watch.on("unlink", path => {
        files.delete(path);
      });
      watch.on("error", err => reject(err));
      watch.on("ready", () => {
        resolve(
          Computable.forAll(
            Array.from(files.values()),
            (...done) => new FileSet(done.reduce((result, file) => result.set(removePrefix(file.name, stripPrefix), file), new Map()))
          )
        );
      });
    });
  }

  protected fileAdded(filename: string, stat: FSFileStats | undefined): Computable<FSFile> {
    const filepath = path.resolve(this.root, filename);
    const fileStat = stat ?? fs.statSync(filepath);
    return hashFile(filepath).then(hash => new FSFile(this.root, filename, fileStat, hash));
  }

  public get(name: string): Computable<IFile> {
    /* FIXME: Should support watching as well. */
    return Computable.from((resolve, reject) => {
      const file = path.resolve(this.root, name);
      fs.stat(file, (err, stat) => {
        if (err) {
          reject(err);
        } else {
          resolve(hashFile(file).then(hash => new FSFile(this.root, name, stat, "")));
        }
      });
    });
  }
}

export const FS = {
  /**
   * Obtain a FileSet representing a real directory on the filesystem.
   * @param path
   */
  get(dirname: string): Computable<FileSource> {
    return Computable.from<FileSource>((resolve, reject) => {
      if (fs.existsSync(dirname)) {
        resolve(new FSFileSource(dirname));
      } else {
        reject(new Error("No such path"));
      }
    });
  },
};

function removePrefix(filename: string, pattern: RegExp | undefined): string {
  if (pattern) {
    const match = pattern.exec(filename);
    if (match) {
      return filename.substring(match[0].length);
    }
  }
  return filename;
}
