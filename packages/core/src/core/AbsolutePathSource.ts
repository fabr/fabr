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

import * as path from "node:path";
import { Computable, type ComputableSource } from "./Computable";
import type { FileSet, FileSource, IFile } from "./FileSet";
import type { FSFileSource } from "./FSFileSource";
import type { Name } from "./Name";
import { toHostPath } from "../support/Paths";
import { FabrError } from "./Errors";

/**
 * A FileSource reading files by absolute path, through one source per
 * filesystem root, made when a path under it is first asked for: `/` on
 * POSIX; on Windows each drive (`C:\`) and share (`\\server\share\`). A
 * name is an absolute path, `/`-separated in a pattern (`C:/x/*.fabr`); each
 * file found is named relative to its root, as that root's source names it.
 */
export class AbsolutePathSource<S extends FSFileSource = FSFileSource> implements FileSource {
  private readonly roots = new Map<string, S>();

  /** @param make makes the source over a filesystem root. */
  constructor(private readonly make: (root: string) => S) {}

  /** @return the sources made so far, one per filesystem root. */
  public get sources(): S[] {
    return [...this.roots.values()];
  }

  /** Get the files `name`, an absolute path, selects; rejects for a relative name, which names no root. */
  public find(name: Name, prefix?: string): ComputableSource<FileSet> {
    const head = name.getLiteralPathPrefix();
    if (!path.isAbsolute(toHostPath(head))) {
      return Computable.reject(new FabrError(`Internal error: '${name.toString()}' is no absolute path`));
    }
    /* On Windows a path rooted with no drive (`/x`) is on the current drive,
     * named from its root. */
    const source = this.sourceAt(toHostPath(head));
    const rebased = source.rebase(name);
    const named = rebased === name && path.sep === "\\" && /^\/(?!\/)/.test(head) ? name.rebase("/") : rebased;
    return source.find(named, prefix);
  }

  /** Get the file at `name`, a host path (a relative one taken from the working directory). */
  public get(name: string): ComputableSource<IFile | undefined> {
    const absolute = path.resolve(name);
    return this.sourceAt(absolute).get(absolute);
  }

  /** @return the source over the filesystem root `file`, a host path, lies under. */
  private sourceAt(file: string): S {
    /* Windows reads `c:\` and `C:\` as one drive. */
    const root = path.parse(path.resolve(file)).root.replace(/^[a-z](?=:)/, drive => drive.toUpperCase());
    let source = this.roots.get(root);
    if (source === undefined) {
      source = this.make(root);
      this.roots.set(root, source);
    }
    return source;
  }
}
