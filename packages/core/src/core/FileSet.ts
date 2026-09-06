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

import { Name } from "./Name";
import { FileSetRef } from "./FileSetRef";
import type { IProjection } from "./FileSetRef";
import { Computable, ComputableSource } from "./Computable";
import { IDiagnosticNote } from "../support/Log";
import { IProvenanceStep, registerProvenanceLocator, registerProvenanceRenderer, renderProvenance, locateSource } from "./Provenance";
import { ConflictError } from "./Errors";
import { canonicalFileName, isCanonicalFileName } from "../support/Paths";
import { hashString } from "./FSWrapper";
import { manifestLine } from "./Manifest";

/** The permission bits (`man 2 stat`, the low 12 bits — rwx triples plus
 * setuid/setgid/sticky) fabr records for a file when none are otherwise known:
 * a plain non-executable file. A file's real mode is carried on {@link IFile.mode}
 * and preserved through the cache (see BuildCache's manifest) so it can be
 * reapplied on export (`fabr cp`, tar pack). */
export const DEFAULT_FILE_MODE = 0o644;

export interface IFile {
  hash: string;

  /**
   * The file's POSIX permission bits (low 12 bits, `0o7777` — including
   * setuid/setgid/sticky). Authoritative and preserved verbatim through the
   * cache manifest; reapplied when the file is exported to user space (`fabr cp`)
   * or packed into a tarball. The content-addressed blob a file is stored in is
   * *not* this mode — a blob is read-only (0o444, or 0o555 when this mode is
   * executable), since one blob may back several files with differing modes.
   */
  mode: number;

  /**
   * The file's sniffed content type (see Mime's `sniffMime`):
   * `application/octet-stream` for anything unrecognized. Total and synchronous
   * on every implementation — classified from the leading bytes wherever the
   * content is first read (hashing, streaming into the store), and persisted
   * through the cache manifest, so consulting it costs no I/O anywhere. A pure
   * function of the content (same hash ⇒ same mime); like the hash it
   * identifies, it never participates in cache keys. Identification only — the
   * consumer that acts on it (archive descent) still parses the content on its
   * own terms.
   */
  mime: string;

  readString(encoding?: BufferEncoding): Computable<string>;

  /**
   * @returns a human readable string representing the file (may not be parseable in any sense)
   */
  getDisplayName(): string;

  /**
   * Whether the receiver names the *same underlying file* as the given one
   * (same identity, not merely same content) — used to tell a genuine union
   * conflict from the same file arriving twice. A given cache entry surfaces
   * with a stable identity on both the fresh and served-from-disk paths (see
   * BuildCache.getOrCreate), so the two compare equal.
   */
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
   * Project this source to the part named by `name`, its result names rewritten
   * under `prefix` (the written-name rule: `alias/path` keeps `alias/`, `alias:path`
   * strips it). "Project" because a plain source yields the **matching files**,
   * but a source with its own notion of a named part may yield something else —
   * a RunnableFileSet re-points its launch entry, keeping the whole install. No
   * match yields the empty set.
   *
   * @param name the name/glob to match.
   * @param prefix prepended to every result name (default none).
   */
  find(name: Name, prefix?: string): ComputableSource<FileSet>;

  /**
   * @return a single direct file by exact name or undefined if it does not exist.
   * @param name
   */
  get(name: string): ComputableSource<IFile | undefined>;
}

type FileSetContent = Map<string, IFile>;

/**
 * The lazily-computed manifest hash of one content map, held in a cell **shared
 * by every set sharing that map**. The hash is a property of the content, not
 * of any one set, and only some sets are ever asked for it — a build constructs
 * ~3× more packages than it keys — so it is computed on demand. A per-instance
 * field would then be recomputed by whichever of a package's many re-wraps is
 * asked first; the cell travels with the map instead: share the content, share
 * the answer.
 */
interface IManifestHash {
  value?: string;
}

/**
 * Construction-site marker asserting that a content map's names are already
 * canonical, so the constructor skips canonicalization. For names that are
 * canonical *by construction* only: a set derived name-unchanged from an
 * existing FileSet (union, minus, partition), or one read back from a
 * fabr-written cache manifest (the cache is a memo of a canonical set — reads
 * are trusted without rechecking). Any site introducing NEW names goes through
 * the canonicalizing constructor.
 */
export const CANONICAL: unique symbol = Symbol("canonical-names");

/**
 * Represents a set of files that may originate from arbitrary points of the file system
 * (or not even be on the filesystem). FileSets are immutable after construction.
 *
 * Every name is **canonical** (see {@link canonicalFileName}): the constructor
 * canonicalizes whatever it is handed — so "no `../`, no absolute paths, no
 * control characters" holds for every FileSet *by construction*, whoever the
 * producer is (staging containment then cannot be escaped by a crafted name).
 * The common already-clean case costs one scan and keeps the map as given;
 * construction sites whose names are canonical by construction pass
 * {@link CANONICAL} to skip even that.
 *
 * Current implementation is just a Map<string,IFile> but other code shouldn't depend on that.
 */
export class FileSet implements FileSource {
  private content: FileSetContent;
  /** Shared with any set sharing {@link content} — see {@link IManifestHash}. */
  private readonly manifestHash: IManifestHash;
  /**
   * Optional provenance chain, preserved through single-source derivations.
   * This is runtime-only "ghost" data: it must never participate in manifests,
   * cache keys, or file equality.
   */
  public readonly origin: IProvenanceStep | undefined;

  /**
   * Handed an existing FileSet, the receiver **shares** its content map rather
   * than copying it: a set is immutable, its names are already canonical, and
   * the derivation keeps them verbatim — so a re-wrap (a restamped package, a
   * runnable over an install) costs nothing per file. Handed a raw map, `trust`
   * decides whether the names are canonicalized (see {@link CANONICAL}).
   */
  constructor(content: FileSetContent | FileSet, origin?: IProvenanceStep, trust?: typeof CANONICAL) {
    this.content =
      content instanceof FileSet ? content.content : trust === CANONICAL ? content : FileSet.canonicalizeContent(content, origin);
    this.manifestHash = content instanceof FileSet ? content.manifestHash : {};
    this.origin = origin;
  }

  /**
   * Canonicalize a raw content map's names. Fast path: every name already
   * canonical (the overwhelmingly common case) returns the map as given, no
   * allocation. Otherwise the map is rebuilt under canonical names, and two
   * *different* files landing on one canonical name is a {@link ConflictError}
   * (the same file twice dedups by identity, as in {@link unionAll}).
   */
  private static canonicalizeContent(content: FileSetContent, origin?: IProvenanceStep): FileSetContent {
    let clean = true;
    for (const name of content.keys()) {
      if (!isCanonicalFileName(name)) {
        clean = false;
        break;
      }
    }
    if (clean) {
      return content;
    }
    const result = new Map<string, IFile>();
    const sourceName = new Map<string, string>();
    for (const [name, file] of content) {
      const canonical = canonicalFileName(name);
      const existing = result.get(canonical);
      if (existing && !existing.isSameFile(file)) {
        throw new ConflictError(
          "files",
          canonical,
          { provenance: origin, detail: sourceName.get(canonical) ?? existing.getDisplayName() },
          { provenance: origin, detail: name }
        );
      }
      result.set(canonical, file);
      sourceName.set(canonical, name);
    }
    return result;
  }

  /**
   * This set's own delivered name — what a graph *edge* pointing at it is
   * called, and so how a discovered-deps path names the step that reaches it
   * (see BuildAction's DepsPath). Empty for an ordinary set: its files are already
   * named, so they are reached directly rather than through a step.
   *
   * Unversioned deliberately — it names the binding, not the thing bound: two
   * coexisting versions are told apart by *where* the walk found them, and the
   * bytes at that position are what the key carries.
   */
  public get name(): string {
    return "";
  }

  /**
   * @return a copy of the receiver carrying the given provenance.
   */
  public withOrigin(origin: IProvenanceStep): FileSet {
    /* `this`, not `this.content`: sharing the set shares its manifest-hash cell
     * along with the map, which passing the bare map would not. */
    return new FileSet(this, origin);
  }

  /**
   * @return a copy of the receiver with the given provenance step chained onto
   * its existing provenance.
   */
  public withStep(step: IProvenanceStep): FileSet {
    return this.withOrigin({ ...step, parent: this.origin });
  }

  /**
   * Resolve projections to positions *within this set* rather than extracting
   * the files: a map from each matched member's own name to the name the
   * projection gives it.
   *
   * The two names differ whenever the projection's naming facets do work — a path
   * segment before the `:` (`pkg/src/blah:index.ts` → `src/blah/index.ts` keyed,
   * called `index.ts`) or a rename (`pkg:*.ts -> *.js`). A rename never moves
   * anything: only the name the caller uses changes.
   */
  public locate(projections: ReadonlyArray<IProjection>): Map<string, string> {
    const projectors = projections.map(projection => projection.pattern.makeProjector(projection.prefix));
    const located = new Map<string, string>();
    for (const name of this.content.keys()) {
      let projected: string | undefined = name;
      for (const projector of projectors) {
        projected = projector(projected);
        if (projected === undefined) {
          break;
        }
      }
      if (projected !== undefined) {
        located.set(name, projected);
      }
    }
    return located;
  }

  /**
   * Apply projections as *content*: the matched files under their projected
   * names, the container gone. The extract half of the pair {@link locate}
   * completes — same projections, same matches, the other reading.
   *
   * Through the checked `rename`, so a many-to-one rename is the ordinary
   * ConflictError rather than a silently lost file. Overridden where a container
   * is addressed by something other than its own file names (a runnable's launch
   * surface), which is exactly why applying projections belongs to the container
   * rather than to whoever holds a pending reference to it.
   */
  public select(projections: ReadonlyArray<IProjection>): FileSet {
    return projections.reduce((set: FileSet, projection) => set.rename(projection.pattern.makeProjector(projection.prefix)), this);
  }

  public find(name: Name, prefix = ""): Computable<FileSet> {
    /* The name owns what a projection means (glob-select under `prefix`, or a
     * `sel -> tmpl` rename); find just applies it. Through the checked rename so
     * a user rename's name collisions surface — a plain glob projection can't
     * collide (distinct paths stay distinct under a constant prefix). */
    return Computable.resolve(this.rename(name.makeProjector(prefix)));
  }

  /**
   * Read the contents of the given file as a string (convenience method).
   * Rejects if the file is not in the set.
   * @param filepath path of a file within the set.
   * @param encoding Optional encoding to use for the file (default UTF8)
   */
  readFile(filepath: string, encoding?: BufferEncoding): Computable<string> {
    const file = this.content.get(filepath);
    return file ? file.readString(encoding) : Computable.reject(new Error(`File not found: ${filepath}`));
  }

  /**
   *
   * @param name
   * @returns
   */
  public get(name: string): Computable<IFile | undefined> {
    return Computable.resolve(this.content.get(name));
  }

  /** Synchronous member lookup by exact name — the FileSource `get` is the
   * Computable-valued interface form; a FileSet's membership is immediate. */
  public getFile(name: string): IFile | undefined {
    return this.content.get(name);
  }

  public getAll(): Computable<FileSet> {
    return Computable.resolve(this);
  }

  /** The sole file when this set holds exactly one, else undefined — the projection a
   * single-file query applies to reduce its (0-or-1-element) FileSet to that file. */
  public getSingleFile(): IFile | undefined {
    return this.content.size === 1 ? this.content.values().next().value : undefined;
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

  /**
   * The hash of this set's {@link toManifest} — a stable identity for its
   * content, distinguishing exactly what the manifest distinguishes (names,
   * content hashes and modes) and nothing else: not provenance, not the
   * delivery that produced it.
   *
   * For an action that assembles its own inputs: the key can name a whole
   * package by its id instead of listing its files, which is O(packages)
   * rather than O(files) while staying injective over the bytes.
   */
  public toManifestHash(): string {
    return (this.manifestHash.value ??= hashString(this.toManifest()));
  }

  public toManifest(): string {
    const result = [];
    for (const name of [...this.content.keys()].sort()) {
      const file = this.content.get(name);
      result.push(manifestLine(name, String(file?.hash), file?.mode ?? DEFAULT_FILE_MODE));
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
        partitions[dest] = new FileSet(new Map(), this.origin, CANONICAL);
      }
      partitions[dest].content.set(path, file);
    }
    return partitions;
  }

  /**
   * Remap the files in the fileset, and return a new FileSet with the result.
   * A synonym of {@link rename} (the name used where the intent is layout
   * rather than projection) — same canonicalization, same collision rule.
   * @param fn A function that either returns the new name for the given file, or undefined to exclude it from the result.
   */
  public remap(fn: (name: string, file: IFile) => string | undefined): FileSet {
    return this.rename(fn);
  }

  /**
   * This set mounted under `prefix` — every name prefixed, nothing dropped,
   * renamed or merged. The layout counterpart of {@link rename}: a canonical
   * prefix onto a canonical name is canonical, so one canonicalization of the
   * prefix stands in for one per file, and no collision is possible (a constant
   * prefix keeps distinct names distinct). An empty prefix mounts at the root
   * and is the receiver itself.
   */
  public mountedAt(prefix: string): FileSet {
    if (prefix === "") {
      return this;
    }
    const mount = canonicalFileName(prefix) + "/";
    const result = new Map<string, IFile>();
    for (const [name, file] of this.content) {
      result.set(mount + name, file);
    }
    return new FileSet(result, this.origin, CANONICAL);
  }

  /**
   * Apply a name projection: `renamer` maps each file's path to its result name
   * (undefined drops it), returning a new FileSet. This is the loop behind
   * {@link find} — a plain glob projection and a `sel -> tmpl` rename alike —
   * and the direct home of the collision rule: two *different* files landing on
   * one result name is a **conflict**, reported with both sides attributed via
   * provenance; the same file arriving twice at one name is fine (identity
   * dedup, as in {@link unionAll}). Result names are canonicalized as they are
   * produced (a renamer yielding `../x` flattens to `x` — the namespace rule),
   * and the collision check runs on the *canonical* names, so two names that
   * only collide after flattening still conflict rather than silently collapse.
   * A plain glob projection never collides (distinct paths stay distinct under
   * a constant prefix).
   */
  public rename(renamer: (name: string, file: IFile) => string | undefined): FileSet {
    const result = new Map<string, IFile>();
    const sourceName = new Map<string, string>();
    for (const [name, file] of this.content) {
      const rawName = renamer(name, file);
      if (rawName === undefined) {
        continue;
      }
      /* Canonicalization is the identity on an already-canonical name, and
       * answering that is much cheaper than producing the canonical form. */
      const newName = isCanonicalFileName(rawName) ? rawName : canonicalFileName(rawName);
      const existing = result.get(newName);
      if (existing && !existing.isSameFile(file)) {
        throw new ConflictError(
          "renamed files",
          newName,
          { provenance: this.origin, detail: sourceName.get(newName) ?? existing.getDisplayName() },
          { provenance: this.origin, detail: name }
        );
      }
      result.set(newName, file);
      sourceName.set(newName, name);
    }
    return new FileSet(result, this.origin, CANONICAL);
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
    return new FileSet(result, this.origin, CANONICAL);
  }

  /**
   * Union the given sets; two different files at the same path is a conflict,
   * reported with both sides attributed via their sets' provenance.
   */
  public static unionAll(...refs: Array<FileSet | FileSetRef>): FileSet {
    /* A materialized ref stands in for the content it projects — flattening is
     * the pure rename fold, so nothing here becomes async. A caller that needs
     * the CONTAINER to survive must not come through here (see FileSet.locate). */
    const sets = refs.map(ref => (ref instanceof FileSetRef ? ref.select() : ref));
    if (sets.length === 0) {
      return EMPTY_FILESET;
    }
    if (sets.length === 1) {
      return sets[0];
    }
    const result = new Map<string, IFile>();
    const firstOwner = new Map<string, FileSet>();
    for (const fs of sets) {
      for (const [path, file] of fs) {
        const old = result.get(path);
        if (old && !old.isSameFile(file)) {
          const owner = firstOwner.get(path) ?? fs;
          throw new ConflictError(
            "files",
            path,
            { provenance: owner.origin, detail: old.getDisplayName() },
            { provenance: fs.origin, detail: file.getDisplayName() }
          );
        }
        result.set(path, file);
        if (!firstOwner.has(path)) {
          firstOwner.set(path, fs);
        }
      }
    }
    /* Lazy merge provenance: retain the contributors (not a per-file map) so a
     * later diagnostic can trace any file back to its source (see IMergeOrigin). */
    return new FileSet(result, mergeOrigin(sets.map(fileset => ({ prefix: "", fileset }))), CANONICAL);
  }

  public static layout(data: Record<string, FileSet | Array<FileSet | undefined> | IFile | undefined>): FileSet {
    /* A mounted name is prefix + a member's own (already canonical) name, so
     * canonicalizing the *prefix* — once, not once per file — makes the whole
     * result canonical by construction. Names are `/`-separated everywhere,
     * whatever the host platform, so the join is a concatenation. */
    const result = new Map<string, IFile>();
    /* Contributors and the prefix each was mounted under, for lazy merge
     * provenance (see IMergeOrigin) — a raw IFile carries no origin, so only
     * FileSet sources are recorded. */
    const sources: IMergeSource[] = [];
    for (const prefix in data) {
      const files = data[prefix];
      const root = prefix === "" ? "" : canonicalFileName(prefix);
      const mount = root === "" ? "" : root + "/";
      if (Array.isArray(files)) {
        for (const fs of files) {
          if (fs) {
            for (const [name, file] of fs) {
              result.set(mount + name, file);
            }
            sources.push({ prefix: mount, fileset: fs });
          }
        }
      } else if (files instanceof FileSet) {
        for (const [name, file] of files) {
          result.set(mount + name, file);
        }
        sources.push({ prefix: mount, fileset: files });
      } else if (files !== undefined) {
        /* A bare file mounts *at* the prefix, which is then the whole name —
         * so an empty one names nothing and is rejected, as it always was. */
        result.set(canonicalFileName(prefix), files);
      }
    }
    return new FileSet(result, mergeOrigin(sources), CANONICAL);
  }
}

export const EMPTY_FILESET: FileSet = new FileSet(new Map());

/**
 * Provenance for a FileSet assembled from several sources (a `unionAll`, or a
 * prefixed `layout`). A single `origin` slot can't represent multiple sources,
 * so combinations used to drop it; instead this step retains only its
 * contributor FileSets (O(K) references — never a per-file map) and reconstructs
 * one file's origin **lazily**, at render/error time: given the file's path it
 * strips the matching mount prefix, finds the contributor that holds it, and
 * delegates to *that* set's origin — recursing through nested merges down to a
 * single-source origin (e.g. a package resolution) that explains the path.
 * Nothing is computed unless a diagnostic actually asks.
 */
export const FILESET_MERGE_PROVENANCE = "fileset-merge";

interface IMergeSource {
  /** The layout prefix this source was mounted under ("" for a bare union). */
  readonly prefix: string;
  readonly fileset: FileSet;
}

interface IMergeOrigin extends IProvenanceStep {
  readonly kind: typeof FILESET_MERGE_PROVENANCE;
  readonly sources: ReadonlyArray<IMergeSource>;
}

/** A merge-provenance step over `sources`, or undefined when none carries an
 * origin — nothing to attribute, so don't pay for a step that can never explain. */
function mergeOrigin(sources: IMergeSource[]): IMergeOrigin | undefined {
  return sources.some(source => source.fileset.origin !== undefined) ? { kind: FILESET_MERGE_PROVENANCE, sources } : undefined;
}

registerProvenanceRenderer(FILESET_MERGE_PROVENANCE, (step, context): IDiagnosticNote[] => {
  const merge = step as IMergeOrigin;
  if (context.path !== undefined) {
    const found = contributorOf(merge, context.path);
    if (found?.fileset.origin !== undefined) {
      return renderProvenance(found.fileset.origin, { ...context, path: found.rel });
    }
  }
  return [];
});

/* A merge repositions content, so it must rebase before delegating — the same
 * "strip the mount prefix, find the holder, recurse" walk the renderer does. */
registerProvenanceLocator(FILESET_MERGE_PROVENANCE, (step, path) => {
  const found = contributorOf(step as IMergeOrigin, path);
  return found && locateSource(found.fileset.origin, found.rel);
});

/** The merged-in set holding `path`, and the name it holds it under. */
function contributorOf(merge: IMergeOrigin, path: string): { fileset: FileSet; rel: string } | undefined {
  for (const { prefix, fileset } of merge.sources) {
    if (path.startsWith(prefix)) {
      const rel = path.slice(prefix.length);
      if (fileset.getFile(rel) !== undefined) {
        return { fileset, rel };
      }
    }
  }
  return undefined;
}
