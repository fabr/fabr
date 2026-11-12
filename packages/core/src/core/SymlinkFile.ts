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

import * as path from "path";
import { Computable } from "./Computable";
import { hashString } from "./FSWrapper";
import { IFile } from "./FileSet";
import { FabrError } from "./Errors";

/**
 * A symbolic link in a FileSet: a file whose content is the path it names,
 * `target`, which `readString` and `getBuffer` return. It is matched and keyed
 * by its own name like any file, and staged as a real symlink
 * (`writeFileSet`), which staging leaves out where the target leads outside
 * the tree being written. A FileSet does not follow links: a consumer that
 * wants the file a link names looks `target` up itself, as RunnableFileSet
 * does for a package's bins.
 */
export class SymlinkFile implements IFile {
  public readonly hash: string;
  /** A symlink's own permission bits, which most systems ignore. */
  public readonly mode = 0o777;
  /** The freedesktop type for a symlink: fixed for the class, never sniffed
   * from the link text, and not written to the cache manifest, where a link has
   * a line of its own form. */
  public readonly mime = "inode/symlink";

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

  /** @return undefined: a symlink has no file on disk to read. */
  public getAbsPath(): undefined {
    return undefined;
  }
}

/** The scheme a {@link HostLink}'s `target` starts with. Nothing parses it: a
 * host link written to a manifest and read back is a plain symlink whose target
 * names no path, which staging leaves out. */
const HOST_LINK_SCHEME = "fabr-host:";

/**
 * A link to a program of the host, used where it lies (`@host:clang`).
 *
 * Its identity (its hash and `target`, and so every action key holding it) is
 * the program's content hash, not its location on this machine: a different
 * build of the program is a different key, and the same program at another
 * path is the same one. `location` is where the program is run from (see
 * `toArgv`), and what a link is staged to when the program is read as a file;
 * it is no part of the identity.
 *
 * Staging writes a host link even though it leads out of the tree being
 * written. Construct one only for a program fabr found itself, and never make
 * one from content read back (a manifest, an archive).
 */
export class HostLink extends SymlinkFile {
  constructor(
    /** The content hash of the program `location` names. */
    public readonly contentHash: string,
    /** The program's absolute path on this machine, as PATH lookup or the reference named it. */
    public readonly location: string
  ) {
    super(`${HOST_LINK_SCHEME}${contentHash}`);
    if (!path.isAbsolute(location)) {
      throw new FabrError(`Internal error: a host link must name an absolute path, not '${location}'`);
    }
  }

  public override getDisplayName(): string {
    return `-> ${this.location}`;
  }
}
