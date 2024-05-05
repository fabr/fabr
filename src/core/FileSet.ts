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

import * as picomatch from "picomatch";
import * as path from "path";
import { Name } from "../model/Name";
import { Computable } from "./Computable";

export interface IFile {
  hash: string;
  readString(encoding?: BufferEncoding): Computable<string>;

  /**
   * @returns a human readable string representing the file (may not be parseable in any sense)
   */
  getDisplayName(): string;
  isSameFile(file: IFile): boolean;

  /**
   * @returns the real, absolute path to the file if it has one, or undefined if it does not.
   */
  getAbsPath(): string | undefined;

  /**
   * @returns a Buffer containing the contents of the file.
   */
  getBuffer(): Computable<Buffer>;
}

export interface FileSource {
  /**
   * @return a FileSet of all files that match the given Name
   * If no files match, yields the empty set.
   *
   * @param name
   */
  find(name: Name): Computable<FileSet>;

  /**
   * @return a single direct file by exact name or undefined if it does not exist.
   * @param name
   */
  get(name: string): Computable<IFile | undefined>;
}

type FileSetContent = Map<string, IFile>;

/**
 * Represents a set of files that may originate from arbitrary points of the file system
 * (or not even be on the filesystem). FileSets are immutable after construction.
 *
 * Current implementation is just a Map<string,IFile> but other code shouldn't depend on that.
 */
export class FileSet implements FileSource {
  private content: FileSetContent;

  constructor(content: FileSetContent) {
    this.content = content;
  }

  public find(name: Name): Computable<FileSet> {
    const newContent = new Map<string, IFile>();
    const matcher = picomatch(name.toString());
    for (const [path, file] of this.content) {
      if (matcher(path)) {
        newContent.set(path, file);
      }
    }
    return Computable.resolve(new FileSet(newContent));
  }

  /**
   * Read the contents of the given file as a string (convenience method).
   * Rejects if the file is not in the set.
   * @param filepath path of a file within the set.
   * @param encoding Optional encoding to use for the file (default UTF8)
   */
  readFile(filepath: string, encoding?: BufferEncoding): Computable<string> {
    const file = this.content.get(filepath);
    return file ? file.readString(encoding) : Computable.reject(new Error("File not found"));
  }

  /**
   *
   * @param name
   * @returns
   */
  public get(name: string): Computable<IFile | undefined> {
    return Computable.resolve(this.content.get(name));
  }

  public getAll(): Computable<FileSet> {
    return Computable.resolve(this);
  }

  public [Symbol.iterator](): IterableIterator<[string, IFile]> {
    return this.content[Symbol.iterator]();
  }

  public get size(): number {
    return this.content.size;
  }

  public isEmpty(): boolean {
    return this.content.size === 0;
  }

  public toManifest(): string {
    const result = [];
    for (const name of [...this.content.keys()].sort()) {
      result.push(`${this.content.get(name)?.hash} ${name}`);
    }
    return result.join("\n");
  }

  /* Set operations */

  /**
   * Partition the fileset into 1 or more subsets based on a partition function
   * (each file in the original will be placed in exactly one output partition).
   * @param cb
   */
  public partition(cb: (path: string) => string): Record<string, FileSet> {
    /* Note: we're technically mutating the content of each of the partitioned FileSets
     * as we go, but those FileSets can't escape from this function before they're finalized.
     */
    const partitions: Record<string, FileSet> = {};
    for (const [path, file] of this.content) {
      const dest = cb(path);
      if (!(dest in partitions)) {
        partitions[dest] = new FileSet(new Map());
      }
      partitions[dest].content.set(path, file);
    }
    return partitions;
  }

  /**
   * Remap the files in the fileset, and return a new FileSet with the result.
   * @param fn A function that either returns the new name for the given file, or undefined to exclude it from the result.
   */
  public remap(fn: (name: string, file: IFile) => string | undefined): FileSet {
    const result = new Map();
    for (const [name, file] of this.content) {
      const newName = fn(name, file);
      if (newName !== undefined) {
        result.set(newName, file);
      }
    }

    return new FileSet(result);
  }

  /**
   * @return all files in the receiver, excluding any file names that appear in the given
   *  fileset (irrespective of file content).
   * @param files
   */
  public minus(files: FileSet): FileSet {
    const result = new Map(this.content);
    for (const [name] of files.content) {
      result.delete(name);
    }
    return new FileSet(result);
  }

  public static unionAll(...sets: FileSet[]): FileSet {
    if (sets.length === 0) {
      return EMPTY_FILESET;
    } else if (sets.length === 1) {
      return sets[0];
    } else {
      const result = new Map<string, IFile>();
      for (const fs of sets) {
        for (const [path, file] of fs) {
          const old = result.get(path);
          if (old && !old.isSameFile(file)) {
            /* TODO: Needs much more diagnostic information */
            throw new Error("Conflicting files for " + path);
          }
          result.set(path, file);
        }
      }
      return new FileSet(result);
    }
  }

  public static layout(data: Record<string, FileSet | Array<FileSet | undefined> | IFile | undefined>): FileSet {
    const result = new Map<string, IFile>();
    for (const prefix in data) {
      const files = data[prefix];
      if (Array.isArray(files)) {
        for (const fs of files) {
          if (fs) {
            for (const [name, file] of fs) {
              result.set(path.join(prefix, name), file);
            }
          }
        }
      } else if (files instanceof FileSet) {
        for (const [name, file] of files) {
          result.set(path.join(prefix, name), file);
        }
      } else if (files !== undefined) {
        result.set(prefix, files);
      }
    }
    return new FileSet(result);
  }

  /**
   * Search all sources for the given name, and return a union of all matches
   */
  public static findAll(sources: FileSource[], name: Name): Computable<FileSet> {
    return Computable.forAll(
      sources.map(fs => fs.find(name)),
      (...sets) => FileSet.unionAll(...sets)
    );
  }
}

export const EMPTY_FILESET: FileSet = new FileSet(new Map());
