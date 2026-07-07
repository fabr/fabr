/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { Computable } from "./Computable";
import { hashString } from "./FSWrapper";
import { IFile } from "./FileSet";

/**
 * A symbolic link within a FileSet: an IFile that names another path (its
 * `target`) rather than carrying content of its own. It participates in a
 * FileSet like any file — matched by `find`, keyed by its own name — and stages
 * to disk as a real symlink (see BuildCache.writeFileSet). Its "content" is the
 * link text (the target path), so `readString`/`getBuffer` return that.
 *
 * A consumer that wants to follow the link resolves `target` within the set
 * itself (a FileSet doesn't dereference for you); RunnableFileSet uses this to
 * carry a package's bins (`tsc` → its real file) as find-time entries, resolving
 * the target to the real install path at launch — so no symlink is ever staged
 * on that path, though staging one is fully supported for other uses.
 */
export class SymlinkFile implements IFile {
  public readonly hash: string;

  constructor(public readonly target: string) {
    this.hash = hashString(Buffer.from("symlink\0" + target));
  }

  public readString(): Computable<string> {
    return Computable.resolve(this.target);
  }

  public getBuffer(): Computable<Buffer> {
    return Computable.resolve(Buffer.from(this.target));
  }

  public getDisplayName(): string {
    return `-> ${this.target}`;
  }

  public isSameFile(file: IFile): boolean {
    return file instanceof SymlinkFile && file.target === this.target;
  }

  /** A symlink has no source path on disk — it names its target, which BuildCache stages as a real link. */
  public getAbsPath(): undefined {
    return undefined;
  }
}
