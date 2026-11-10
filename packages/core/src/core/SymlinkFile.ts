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
 * A symbolic link within a FileSet: an IFile that names another path (its
 * `target`) rather than carrying content of its own. It participates in a
 * FileSet like any file — matched by `find`, keyed by its own name — and stages
 * to disk as a real symlink (see Staging.writeFileSet). Its "content" is the
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
  /** A symlink's own permission bits are conventionally 0o777 and ignored on
   * most systems (the target's mode governs); carried only to satisfy IFile —
   * a symlink stages as a link, never through the read-only blob path. */
  public readonly mode = 0o777;
  /** The freedesktop name for "this entry IS a symlink" — a constant of the
   * class, never sniffed (link text is a path, not content), and not written to
   * the manifest (a link line's form already says what it is). */
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

  /** A symlink has no source path on disk — it names its target, which staging (Staging.writeFileSet) writes as a real link. */
  public getAbsPath(): undefined {
    return undefined;
  }
}

/** The scheme a {@link HostLink}'s symbolic target carries. It is not there to
 * be read back — nothing parses it — but to make the degraded form inert: should
 * a link ever be written to a manifest and re-read, it comes back as a plain
 * symlink whose target is not a path to anything, which the staging containment
 * guard drops. */
const HOST_LINK_SCHEME = "fabr-host:";

/**
 * A link to a program of the host, used where it lies (`@host:clang`).
 *
 * Its identity — hash, `target`, hence every action key it rides in — is the
 * program's content hash, never its location on this machine: a different
 * build of the program is a different key, and the same program found at
 * another path is the same one. `location` is where it resolves when STAGED,
 * and is no part of that identity.
 *
 * **In-memory only, and that is a security property.** Staging lets this class
 * out of the tree being written, so being one must not be something content can
 * claim: a host link exists only where fabr constructs one, and nothing parses
 * one back.
 */
export class HostLink extends SymlinkFile {
  constructor(
    /** The content hash of the program `location` names. */
    public readonly contentHash: string,
    /** The program's real path on this machine. */
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
