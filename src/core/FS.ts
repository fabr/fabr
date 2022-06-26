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
import { FileSet, IFile, IFileSetProvider, IFileStats } from "./FileSet";

function readFileAsString(filepath: string, encoding: BufferEncoding = "utf8"): Computable<string> {
  return Computable.from<string>((resolve, reject) => {
    fs.readFile(filepath, encoding, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

class FSFile implements IFile {
  private root: string;
  private name: string;
  private stats: IFileStats | undefined;

  constructor(root: string, name: string, stats: fs.Stats | undefined) {
    this.root = root;
    this.name = name;
    this.stats = stats;
  }

  public readString(encoding?: BufferEncoding): Computable<string> {
    return readFileAsString(path.resolve(this.root, this.name), encoding);
  }

  public get stat(): IFileStats {
    if (!this.stats) {
      const stats = fs.statSync(path.resolve(this.root, this.name));
      this.stats = { size: stats.size, mtime: stats.mtime };
    }
    return this.stats;
  }

  public getDisplayName(): string {
    return path.resolve(this.root, this.name);
  }

  public isSameFile(file: IFile): boolean {
    return file instanceof FSFile && this.getDisplayName() === file.getDisplayName();
  }
}

/**
 * FileSet implementation that loads the directory tree from the real FS on demand
 */
class FSFileSetProvider implements IFileSetProvider {
  private root: string;
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
      console.log("Chokidaring");
      const watch = chokidar.watch(name.toString(), {
        cwd: this.root,
        persistent: false,
      });
      const files = new Map<string, IFile>();
      watch.on("add", (path, stat) => {
        files.set(path, new FSFile(this.root, path, stat));
      });
      watch.on("unlink", path => {
        files.delete(path);
      });
      watch.on("error", err => reject(err));
      watch.on("ready", () => resolve(new FileSet(files)));
    });
  }

  public get(name: string): Computable<IFile> {
    /* FIXME: Should support watching as well. */
    return Computable.from((resolve, reject) => {
      const file = path.resolve(this.root, name);
      fs.stat(file, (err, stat) => {
        if (err) {
          reject(err);
        } else {
          resolve(new FSFile(this.root, name, stat));
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
  get(dirname: string): Computable<IFileSetProvider> {
    return Computable.from<IFileSetProvider>((resolve, reject) => {
      if (fs.existsSync(dirname)) {
        resolve(new FSFileSetProvider(dirname));
      } else {
        reject(new Error("No such path"));
      }
    });
  },
};
