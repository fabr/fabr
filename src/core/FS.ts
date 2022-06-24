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
import { FileSet } from "./FileSet";

export const EMPTY_FILESET: FileSet = {
  find() {
    return EMPTY_FILESET;
  },

  findRelative() {
    return EMPTY_FILESET;
  },

  readFileAsString(file: string): Computable<string> {
    return Computable.reject<string>(new Error("File not found"));
  },

  getDisplayName(file: string): string {
    return file;
  },
};

class LazyFileSet implements FileSet {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }

  public find(name: Name) {
    /* TODO */
    return EMPTY_FILESET;
  }

  public findRelative(baseFile: string, name: Name) {
    /* TODO */
    return EMPTY_FILESET;
  }

  readFileAsString(file: string, encoding: BufferEncoding = "utf8"): Computable<string> {
    return Computable.from<string>((resolve, reject) => {
      const fullFile = path.resolve(this.root, file);
      fs.readFile(fullFile, encoding, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  getDisplayName(file: string): string {
    return path.resolve(this.root, file);
  }
}

export const FS = {
  /**
   * Obtain a FileSet representing a real directory on the filesystem.
   * @param path
   */
  get(dirname: string): Computable<FileSet> {
    return Computable.from<FileSet>((resolve, reject) => {
      if (fs.existsSync(dirname)) {
        resolve(new LazyFileSet(dirname));
      } else {
        reject(new Error("No such path"));
      }
    });
  },
};
