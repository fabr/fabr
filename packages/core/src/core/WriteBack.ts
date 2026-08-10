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
 * Write-back: how a build result offers files to be written back into the
 * USER'S SOURCE TREE — recorded snapshots a test run refreshed, a golden test's
 * blessed expectations. The build invariants fix the shape: actions are
 * hermetic and cache entries are memos, so nothing inside the build graph may
 * write to (or embed absolute paths of) the source tree. Only *resolution*
 * knows which produced file corresponds to which source file, and only the
 * **driver** may touch the user's tree, at explicit request.
 *
 * So a candidate list rides the built result as a partition on the FileSet —
 * runtime-only ghost data, never serialized, never in a manifest or cache key,
 * exactly like provenance and a runnable's launch descriptor. Because the rule
 * computes it in resolution (re-run every evaluation), the candidates
 * reconstruct on the CACHE-HIT path too: a warm replay of an update run whose
 * writes were never applied still offers them.
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
 * One offered write, as the rule that produced it can honestly state it: the
 * content, named relative to an INPUT it belongs beside.
 *
 * Deliberately not a host path. A rule knows the domain facts — which produced
 * file corresponds to which input, and what it is called there (for a recorded
 * snapshot, `__snapshots__/<test file>.snap`, which is *not* the name the run
 * emitted: the runner only ever sees compiled names). Where that input actually
 * lives on this machine is a generic provenance question with one answer for
 * every producer, and belongs to the layer that is allowed to touch the tree —
 * so the driver resolves it ({@link locateSource}) and nothing in the model
 * layer ever manufactures an absolute source-tree path.
 */
export interface IWriteBackCandidate {
  /** What to put back, named in the SAME NAMESPACE as the inputs it corresponds
   * to (`a/__snapshots__/Foo.test.ts.snap` beside a test named
   * `a/Foo.test.ts`). A FileSet, so the name is a key like every other name in
   * fabr and one offer can carry a whole set. */
  readonly files: FileSet;
  /** How a name in {@link files} names the INPUT it belongs to, as a rename
   * projection — `**\/__snapshots__/*.snap -> **\/*`. One pattern for the whole
   * set rather than a per-file anchor: the relationship IS a naming rule, and
   * stating it once means the names and the relationship cannot drift apart.
   * The driver applies it, locates that input, and puts the file at its own
   * name relative to the input's directory. */
  readonly belongsTo: Name;
  /** Provenance of the input set {@link belongsTo} names into — runtime-only
   * ghost data, like everything else here. */
  readonly origin: IProvenanceStep | undefined;
}

/** A candidate the driver has resolved to a real destination — what actually
 * gets written. Absolute, and therefore never constructed in the model layer. */
export interface IResolvedWriteBack {
  readonly file: IFile;
  readonly destination: string;
}

/**
 * A built result that additionally offers source-tree write-backs. The FileSet
 * itself is the target's ordinary content (a test report); `candidates` is the
 * ghost partition the driver reads. Constructed by the rule in resolution; a
 * plain FileSet (no candidates) is the normal case and needs no wrapper.
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

/**
 * The write-back candidates offered by whatever was just built — the driver's
 * accessor, applied to a target's resolved sources. Anything that isn't a
 * {@link WriteBackFileSet} offers none, so this is total over any result.
 */
export function writeBackCandidates(sources: ReadonlyArray<SourceRef>): IWriteBackCandidate[] {
  return sources.flatMap(source => (source instanceof WriteBackFileSet ? [...source.candidates] : []));
}


/** What one applied candidate did — reported per file by the driver. */
/**
 * What a write-back does to the tree, told to whoever owns it.
 *
 * A write is not one event: it creates a temp sibling, renames it over the
 * destination, and may have had to create directories on the way. Under watch
 * every one of those is a filesystem event, so the owner of the tree has to
 * hear about all of them or it will recognize only part of its own work (see
 * {@link SourceFileSource.applyWriteBack}).
 */
export interface IWriteBackObserver {
  /** The bytes about to be placed at `destination` — announced BEFORE the
   * write, and whether or not one proves necessary, so no event can arrive
   * ahead of the expectation that explains it. */
  content(destination: string, buffer: Buffer): void;
  /** A path the write necessarily disturbs but whose content is incidental: the
   * temp sibling it renames from, a directory it had to create. */
  touches(path: string): void;
}

/**
 * Write one candidate into the source tree under `realRoot` (a destination
 * resolving outside it is refused, the same containment discipline staging
 * applies in the other direction).
 *
 * Every candidate IS a change — whoever built the list compared the produced
 * content against the recorded input it came from, both of which it holds
 * hashed, and dropped what matched. So nothing here re-reads the destination to
 * ask: an unchanged record never reaches this function, which is also what
 * keeps its mtime and, under watch, means no event at all.
 *
 * The mechanics live here; the CALLER is {@link SourceFileSource.applyWriteBack},
 * which owns the tree being written to and is therefore the only thing able to
 * recognize the resulting watch event as its own. `expect` is invoked with the
 * bytes destined for the file — before the write, and whether or not one proves
 * necessary — so that expectation is registered ahead of any event explaining it.
 *
 * The driver drives this — nothing in the build graph may.
 */
export function writeBackFile(write: IResolvedWriteBack, realRoot: string, observer: IWriteBackObserver): Computable<string> {
  const destination = path.resolve(write.destination);
  assertContained(destination, realRoot);
  return write.file.getBuffer().then(buffer => {
    observer.content(destination, buffer);
    /* Temp sibling + rename (stageWrite): atomic for a concurrent reader, and it
     * replaces the directory entry rather than writing through a cache-blob
     * hardlink — the same rule the served-install sync writes under. */
    const temp = `${destination}.fabr-writeback-${process.pid}`;
    observer.touches(temp);
    /* Announced before creating them, and only the ones that were actually
     * missing — an existing directory is nobody's change. */
    for (const dir of missingAncestors(path.dirname(destination), realRoot)) {
      observer.touches(dir);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    return stageWrite(temp, destination, writeFile(temp, buffer)).then(() => destination);
  });
}

/** The directories `mkdir -p` is about to create, deepest first: those that do
 * not exist yet, up to (never including) the tree root. */
function missingAncestors(dir: string, realRoot: string): string[] {
  const missing: string[] = [];
  for (let at = dir; at !== realRoot && at !== path.dirname(at) && !fs.existsSync(at); at = path.dirname(at)) {
    missing.push(at);
  }
  return missing;
}


/**
 * A write-back destination must stay inside the project. The candidate's path
 * comes from a source file's own recorded location, so this can only fire on a
 * genuinely out-of-tree input (a reference reaching outside the project root) —
 * but this is the boundary where a bad path becomes damage to the user's disk,
 * so it is checked regardless of producer. Judged against the REAL root and
 * through the destination's real parent directory: a purely lexical comparison
 * would be defeated by a symlinked component anywhere along the way.
 */
function assertContained(destination: string, realRoot: string): void {
  const real = path.join(realParent(path.dirname(destination)), path.basename(destination));
  if (!real.startsWith(realRoot + path.sep)) {
    throw new Error(`Refusing to write '${destination}': it is outside the project directory '${realRoot}'`);
  }
}

/** `dir` resolved through symlinks, tolerating that its deeper components may
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
