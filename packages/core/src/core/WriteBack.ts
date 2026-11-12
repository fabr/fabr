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

/**
 * Write-back: files a build result offers to be written into the user's source
 * tree, such as the records a test run refreshed. Nothing in the build graph
 * writes to the source tree or holds an absolute path in it: a rule names each
 * offer relative to an input, and the driver alone writes, when asked to.
 *
 * The offers ride the result as a partition of its FileSet, kept in memory
 * only, like provenance: never serialized, never in a manifest or cache key. A
 * rule makes them in its action's reshape, so a cache hit offers them too.
 */

import * as fs from "fs";
import * as path from "path";
import { Computable } from "./Computable";
import { FileSet, IFile } from "./FileSet";
import { Name } from "./Name";
import { writeFile } from "./FSWrapper";
import { stageWrite } from "./Staging";
import { IProvenanceStep } from "./Provenance";
import type { SourceRef } from "./Repository";

/**
 * One offered write: content named relative to an input it belongs beside (a
 * recorded snapshot as `__snapshots__/<test file>.snap`, named after the test's
 * source, not the compiled file the run saw). The driver finds where the input
 * lives (its source path, then SourceFileSource.locate).
 */
export interface IWriteBackCandidate {
  /** What to write, named as the inputs it corresponds to are named
   * (`a/__snapshots__/Foo.test.ts.snap` beside a test named `a/Foo.test.ts`). */
  readonly files: FileSet;
  /** A rename projection from a name in {@link files} to the input it belongs
   * to, one for the whole set: `**\/__snapshots__/*.snap -> **\/*`. The driver
   * applies it, locates that input, and writes the file at its own name
   * relative to the input's directory. */
  readonly belongsTo: Name;
  /** Provenance of the input set {@link belongsTo} names into. */
  readonly origin: IProvenanceStep | undefined;
}

/** A candidate the driver has resolved to an absolute destination. Never made
 * in the model layer. */
export interface IResolvedWriteBack {
  readonly file: IFile;
  readonly destination: string;
}

/**
 * A built result that offers source-tree write-backs: the FileSet is the
 * target's ordinary content (a test report), and `candidates` the offers the
 * driver reads. A derivation of it (`find`, `union`, ...) is a plain FileSet,
 * without them.
 */
export class WriteBackFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    public readonly candidates: ReadonlyArray<IWriteBackCandidate>,
    origin?: IProvenanceStep
  ) {
    super(new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  public withOrigin(origin: IProvenanceStep): WriteBackFileSet {
    return new WriteBackFileSet(this, this.candidates, origin);
  }
}

/** Gather the write-back candidates among a target's materialized sources; a
 *  source that is not a {@link WriteBackFileSet} offers none. */
export function writeBackCandidates(sources: ReadonlyArray<SourceRef>): IWriteBackCandidate[] {
  return sources.flatMap(source => (source instanceof WriteBackFileSet ? [...source.candidates] : []));
}

/**
 * The listener a write-back tells of every path it disturbs, each a watch
 * event: the destination, the temp file renamed over it, and each directory
 * created (see {@link SourceFileSource.applyWriteBack}).
 */
export interface IWriteBackObserver {
  /** Announce the bytes about to be written at `destination`, before the
   * write, so no event arrives ahead of it. */
  content(destination: string, buffer: Buffer): void;
  /** Announce a path the write disturbs whose content is not checked: the
   * temp file it renames from, a directory it is about to create. */
  touches(path: string): void;
}

/** Counter making each temp file's name unique in the process: two candidates
 * in one batch may share a destination. */
let tempCounter = 0;

/**
 * Write `write.file` at `write.destination`, through a temp file renamed into
 * place, creating missing directories up to the tree root `realRoot`. Before
 * anything is written, `observer` is told the bytes, the temp file and each
 * directory to be created. The destination is not read first: a candidate is
 * already a change. Resolves to the absolute destination.
 *
 * Containment is not checked here: the caller
 * ({@link SourceFileSource.applyWriteBack}) has found the destination's name in
 * the tree ({@link treeNameOf}) and names it under the tree's root.
 */
export function writeBackFile(write: IResolvedWriteBack, realRoot: string, observer: IWriteBackObserver): Computable<string> {
  const destination = path.resolve(write.destination);
  return write.file.getBuffer().then(buffer => {
    observer.content(destination, buffer);
    /* Temp file + rename (stageWrite): atomic for a concurrent reader, and it
     * replaces the directory entry rather than writing through a hardlink into
     * a cache blob. */
    const temp = `${destination}.fabr-writeback-${process.pid}-${tempCounter++}`;
    observer.touches(temp);
    /* Announce only the directories that are missing: an existing one does
     * not change. */
    for (const dir of missingAncestors(path.dirname(destination), realRoot)) {
      observer.touches(dir);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    return stageWrite(temp, destination, writeFile(temp, buffer)).then(() => destination);
  });
}

/** List the directories `mkdir -p` is about to create, deepest first: those that do
 * not exist yet, up to (never including) the tree root. */
function missingAncestors(dir: string, realRoot: string): string[] {
  const missing: string[] = [];
  for (let at = dir; at !== realRoot && at !== path.dirname(at) && !fs.existsSync(at); at = path.dirname(at)) {
    missing.push(at);
  }
  return missing;
}

/**
 * @return the path within the tree whose real path is `realRoot` that
 * `destination` names, or undefined where it lies outside that tree. Judged
 * through the destination's real parent directory, so a symlinked component
 * cannot lead outside.
 */
export function treeNameOf(destination: string, realRoot: string): string | undefined {
  const real = path.join(realParent(path.dirname(path.resolve(destination))), path.basename(destination));
  return real.startsWith(realRoot + path.sep) ? path.relative(realRoot, real) : undefined;
}

/** Resolve `dir` through symlinks, tolerating that its deeper components may
 * not exist yet (a brand-new `__snapshots__/`): the nearest existing ancestor
 * is resolved for real and the not-yet-created remainder appended. */
function realParent(dir: string): string {
  for (let existing = dir; ; existing = path.dirname(existing)) {
    try {
      return path.join(fs.realpathSync(existing), path.relative(existing, dir));
    } catch {
      if (path.dirname(existing) === existing) {
        return dir;
      }
    }
  }
}
