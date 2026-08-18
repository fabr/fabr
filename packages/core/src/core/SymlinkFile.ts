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

  /** A symlink has no source path on disk — it names its target, which BuildCache stages as a real link. */
  public getAbsPath(): undefined {
    return undefined;
  }
}

/** The scheme a {@link CacheLink}'s symbolic target carries. It is not there to
 * be read back — nothing parses it, and that is the point (see
 * {@link CacheLink}) — but to make the degraded form INERT: should a link ever
 * be written to a manifest and re-read, it comes back as a plain symlink whose
 * target is `fabr-cache:tree`, which is not a path to anything and which the
 * staging containment guard drops. A scheme-free spelling would come back as
 * the plausible relative path `tree` and could quietly link somewhere real. */
export const CACHE_LINK_SCHEME = "fabr-cache:";

/**
 * A link into the cache's own space, at a path relative to the cache root
 * (`new CacheLink("tree")` mounts the tree pool whole).
 *
 * Its identity — hash, `target`, hence every action key it rides in — is the
 * cache-relative path, never the cache's location on this machine: that is what
 * keeps a key portable (move or share a cache and the keys referencing it are
 * unchanged), and it is sound because what a cache link names is content-
 * addressed on the other side. `cacheRoot` is where it resolves when STAGED and
 * is deliberately not part of that identity: it rides along from whichever
 * cache produced the link, so no global "current cache" is needed and a link
 * that never reaches a filesystem never needs one at all.
 *
 * **In-memory only, and that is a security property.** Staging exempts this
 * class from the containment guard that keeps every other symlink inside the
 * tree being written, so being one must not be something content can CLAIM.
 * There is deliberately no parse: a cache link exists only where fabr
 * constructs one, and a delivered tarball carrying a symlink whose target text
 * happens to read `fabr-cache:…` stays the ordinary symlink it was — garbage
 * relative path, dropped by the guard — through any number of manifest
 * round-trips. The constructor is the other half: the path is normalized and
 * must stay inside the cache, so no `..` can be smuggled through a caller
 * either.
 */
export class CacheLink extends SymlinkFile {
  /** The normalized cache-relative path this names. */
  public readonly relpath: string;
  private readonly cacheRoot: string | undefined;

  constructor(relpath: string, cacheRoot?: string) {
    super(`${CACHE_LINK_SCHEME}${containedCachePath(relpath)}`);
    this.relpath = this.target.substring(CACHE_LINK_SCHEME.length);
    this.cacheRoot = cacheRoot;
  }

  /** Where this link points on THIS machine, or undefined when it carries no
   * cache root (nothing has told it where the cache is, so it cannot be
   * staged). */
  public resolveTarget(): string | undefined {
    return this.cacheRoot === undefined ? undefined : path.resolve(this.cacheRoot, this.relpath);
  }

  /** The same link resolved against `cacheRoot` — same identity, different
   * machine-local location. */
  public withCacheRoot(cacheRoot: string): CacheLink {
    return new CacheLink(this.relpath, cacheRoot);
  }
}

/**
 * A cache link's path, normalized, having checked it stays inside the cache.
 * Every caller is fabr itself, so an escape is a fabr bug and not a condition
 * to handle: it throws rather than degrading to something staging would have to
 * second-guess.
 */
function containedCachePath(relpath: string): string {
  const normalized = path.posix.normalize(relpath);
  if (path.isAbsolute(relpath) || path.posix.isAbsolute(relpath) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Internal error: a cache link must name a path inside the cache, not '${relpath}'`);
  }
  return normalized;
}
