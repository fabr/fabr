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
import type { IProjection } from "./Reference";
import { Computable, ComputableSource } from "./Computable";
import { IDiagnosticNote } from "../support/Log";
import {
  derivedFromOf,
  IProvenanceStep,
  IRenameStep,
  namingDigest,
  RENAME_PROVENANCE,
  registerProvenanceNaming,
  registerProvenanceRenderer,
  renderProvenance,
  sourcePathOf,
  sourcePathPrefixOf,
  sourcePathsDigestOf,
} from "./Provenance";
import { ConflictError, FabrError } from "./Errors";
import { canonicalFileName, isCanonicalFileName } from "../support/Paths";
import { hashString } from "./FSWrapper";
import { manifestLine } from "./Manifest";

/** The permission bits ({@link IFile.mode}) fabr records for a file where
 * none are known: a plain non-executable file. */
export const DEFAULT_FILE_MODE = 0o644;

/** A file of a FileSet: its content, permission bits and type. */
export interface IFile {
  /** The file's identity in a manifest or a key: a digest of its content,
   * unless the implementation says otherwise. */
  hash: string;

  /**
   * The file's POSIX permission bits (the low 12 bits, `0o7777`, setuid,
   * setgid and sticky included). Kept exactly through the cache manifest, and
   * applied where the file is exported (`fabr cp`) or packed into a tarball.
   * The blob holding the content in the store does not have this mode: a blob
   * is read-only (0o444, or 0o555 where this mode is executable), and may hold
   * the content of several files with different modes.
   */
  mode: number;

  /**
   * The file's content type, as `sniffMime` classifies its leading bytes
   * (`application/octet-stream` where unrecognized). Every implementation
   * answers it synchronously: it is classified where the content is first read
   * (hashing, streaming into the store) and kept in the cache manifest. A
   * function of the content, and never part of a cache key. A consumer acting
   * on it (archive descent) still parses the content itself.
   */
  mime: string;

  readString(encoding?: BufferEncoding): Computable<string>;

  /**
   * @returns a name for the file in messages, which need not be a path.
   */
  getDisplayName(): string;

  /**
   * @return true if `file` is the same underlying file as this one, otherwise
   * false: the same file on disk (for a file of the store's content-addressed
   * pool, the same bytes), the same symlink target, or the same in-memory
   * buffer. Two files under one name in a union conflict only where this is
   * false. A cache entry's files compare equal whether just built or read back
   * (`BuildCache.getOrCreate`).
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

/** A container of files, looked up by name. */
export interface FileSource {
  /**
   * Project this source to the part `name` names, each result name under
   * `prefix` (`alias/path` keeps `alias/`, `alias:path` strips it). A plain
   * source yields the matching files; a source with its own reading of a name
   * may yield something else (a `sync` target's source yields a member's
   * publish artifact). Nothing matching yields the empty set.
   *
   * @param name the name/glob to match.
   * @param prefix prepended to every result name (default none).
   */
  find(name: Name, prefix?: string): ComputableSource<FileSet>;

  /**
   * @return the file named exactly `name`, or undefined where there is none.
   */
  get(name: string): ComputableSource<IFile | undefined>;
}

type FileSetContent = Map<string, IFile>;

/** The manifest hash of one content map, computed on first ask and shared by
 * every set sharing the map. */
interface IManifestHash {
  value?: string;
}

/**
 * Constructor argument asserting that a content map's names are already
 * canonical, so the constructor does not check them. Pass it only for names
 * taken unchanged from an existing FileSet (union, minus, partition) or read
 * back from a cache manifest fabr wrote. A site introducing new names goes
 * through the canonicalizing constructor.
 */
export const CANONICAL: unique symbol = Symbol("canonical-names");

/**
 * An immutable set of files by name, which may lie anywhere on disk or not on
 * disk at all.
 *
 * Every name is canonical ({@link canonicalFileName}: no `../`, no absolute
 * path, no control characters): the constructor canonicalizes the names it is
 * given, unless told they are {@link CANONICAL}.
 *
 * Do not depend on the set being a Map.
 */
export class FileSet implements FileSource {
  private content: FileSetContent;
  /** Shared with every set sharing {@link content}. */
  private readonly manifestHash: IManifestHash;
  /**
   * The set's provenance, kept through single-source derivations. Runtime-only:
   * it takes no part in manifests, cache keys or file equality, except as the
   * files' source paths ({@link sourcePaths}), which an action's key records.
   */
  public readonly origin: IProvenanceStep | undefined;

  /** {@link sourcePaths} and {@link sourcePathsDigest}, computed on first ask. */
  private sourcePathTable?: ReadonlyMap<string, string>;
  private sourcePathsDigestText?: string;

  /**
   * Make a set of `content` carrying `origin`. Given an existing FileSet, the
   * new set shares its content map and manifest hash, copying and checking
   * nothing. Given a map, its names are canonicalized unless `trust` is
   * {@link CANONICAL}.
   * @throws ConflictError where two different files canonicalize to one name,
   * and FabrError where a name has no canonical form (`\`, a control
   * character, or no path at all).
   */
  constructor(content: FileSetContent | FileSet, origin?: IProvenanceStep, trust?: typeof CANONICAL) {
    this.content =
      content instanceof FileSet ? content.content : trust === CANONICAL ? content : FileSet.canonicalizeContent(content, origin);
    this.manifestHash = content instanceof FileSet ? content.manifestHash : {};
    this.origin = origin;
  }

  /**
   * Canonicalize the names of `content`: the map itself where every name is
   * already canonical, otherwise a new map under canonical names.
   * @throws ConflictError where two different files land on one canonical
   * name; the same file twice is kept once.
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
   * The set's own name: what a dependency on it is called, and so how a
   * discovered-deps path (Manifest's DepsPath) names the step that reaches it.
   * Empty for a plain set, whose files are reached by their own names. It
   * holds no version: two versions held together are told apart by where the
   * walk found them.
   */
  public get name(): string {
    return "";
  }

  /**
   * @return a copy of the receiver carrying the given provenance.
   */
  public withOrigin(origin: IProvenanceStep): FileSet {
    /* Pass `this`, not `this.content`, so the copy shares the manifest hash
     * too. */
    return new FileSet(this, origin);
  }

  /**
   * @return a copy of the receiver with the given provenance step chained onto
   * its existing provenance.
   */
  public withStep(step: IProvenanceStep): FileSet {
    return this.withOrigin({ ...step, parent: this.origin });
  }

  /** Get the source path of the file this set names `name`, as its provenance
   *  gives it ({@link sourcePathOf}); undefined where no reference reaches it. */
  public sourcePathOf(name: string): string | undefined {
    return sourcePathOf(this.origin, name);
  }

  /** Get what the file this set names `name` was produced from, as its
   *  provenance gives it ({@link derivedFromOf}); undefined where no step
   *  derived it. */
  public derivedFromOf(name: string): string | undefined {
    return derivedFromOf(this.origin, name);
  }

  /** A hash of what the files' source paths depend on besides their names:
   *  equal digests mean every name has the same source path. Empty where no
   *  file has one. An action's key records it in place of each file's source
   *  path. */
  public get sourcePathsDigest(): string {
    if (this.sourcePathsDigestText === undefined) {
      this.sourcePathsDigestText = this.sourcePathsDigestOf([...this.content.keys()]);
    }
    return this.sourcePathsDigestText;
  }

  /** @return what the source paths of `names`, files of this set, depend on
   *  besides the names, as a hash ({@link sourcePathsDigest} of those alone). */
  public sourcePathsDigestOf(names: ReadonlyArray<string>): string {
    if (names.length === this.content.size && this.sourcePathsDigestText !== undefined) {
      return this.sourcePathsDigestText;
    }
    const text = sourcePathsDigestOf(this.origin, names);
    return text === "" ? "" : hashString(text);
  }

  /** The prefix every file's source path is formed from, `<prefix><name>`,
   *  where one names every file ({@link sourcePathPrefixOf}). */
  public get sourcePathPrefix(): string | undefined {
    return sourcePathPrefixOf(this.origin);
  }

  /** The source path of each of this set's files that has one, by name. */
  public get sourcePaths(): ReadonlyMap<string, string> {
    if (this.sourcePathTable === undefined) {
      const table = new Map<string, string>();
      for (const name of this.content.keys()) {
        const sourcePath = sourcePathOf(this.origin, name);
        if (sourcePath !== undefined) {
          table.set(name, sourcePath);
        }
      }
      this.sourcePathTable = table;
    }
    return this.sourcePathTable;
  }

  /**
   * Locate the files `projections` select within this set: a map from each
   * matched file's own name to the name the projections give it. The two
   * differ where a projection names its result: a path before the `:`
   * (`pkg/src/blah:index.ts` keys `src/blah/index.ts`, named `index.ts`), or a
   * rename (`pkg:*.ts -> *.js`).
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
   * Select the files `projections` select, under the names they give them, as
   * a set of their own: the files {@link locate} locates.
   * @throws ConflictError where two different files take one name.
   * Overridden by a set addressed by something other than its file names
   * (RunnableFileSet, by its launch surface).
   */
  public select(projections: ReadonlyArray<IProjection>): FileSet {
    return projections.reduce((set: FileSet, projection) => set.rename(projection.pattern.makeProjector(projection.prefix)), this);
  }

  public find(name: Name, prefix = ""): Computable<FileSet> {
    /* The name decides what the projection means (a glob under `prefix`, or a
     * `sel -> tmpl` rename); `rename` reports two different files taking one
     * name. */
    return Computable.resolve(this.rename(name.makeProjector(prefix)));
  }

  /**
   * Read the file named `filepath` as a string. Rejects where the set has no
   * such file.
   * @param encoding the file's encoding (default UTF-8).
   */
  readFile(filepath: string, encoding?: BufferEncoding): Computable<string> {
    const file = this.content.get(filepath);
    return file ? file.readString(encoding) : Computable.reject(new FabrError(`File not found: ${filepath}`));
  }

  /** @return the file named `name`, or undefined. */
  public get(name: string): Computable<IFile | undefined> {
    return Computable.resolve(this.content.get(name));
  }

  /** Look up a file by exact name, synchronously. */
  public getFile(name: string): IFile | undefined {
    return this.content.get(name);
  }

  public getAll(): Computable<FileSet> {
    return Computable.resolve(this);
  }

  /** @return the sole file where this set holds exactly one, otherwise undefined. */
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
   * Hash this set's {@link toManifest}: an identity of its content that tells
   * sets apart by what the manifest records (names, content hashes and modes),
   * and not by provenance or how the set was made. Computed once per content
   * map. An action that lays out its own inputs can key a whole package by it
   * rather than by each file.
   */
  public toManifestHash(): string {
    return (this.manifestHash.value ??= hashString(this.toManifest()));
  }

  /** Render the set's manifest: a line per file (name, content hash, mode), sorted by name. */
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
   * Partition the set by `cb`, which names the partition each file's path goes
   * to. Each file is in exactly one partition, and each partition carries this
   * set's origin.
   */
  public partition(cb: (path: string) => string): Record<string, FileSet> {
    /* The partitions are filled in after they are made; none leaves this
     * function before it is complete. */
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
   * Rename the files as {@link rename} does: the name used where the intent is
   * layout.
   * @param fn A function that either returns the new name for the given file, or undefined to exclude it from the result.
   */
  public remap(fn: (name: string, file: IFile) => string | undefined): FileSet {
    return this.rename(fn);
  }

  /**
   * Mount this set under `prefix`: every name prefixed, nothing dropped or
   * renamed. The prefix is canonicalized once, which makes every name
   * canonical. An empty prefix returns this set.
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
    return new FileSet(result, mergeOrigin([{ prefix: mount, fileset: this }]), CANONICAL);
  }

  /**
   * Rename each file by `renamer`, which gives its new name, or undefined to
   * leave it out, returning a new set: what {@link find} applies for a glob
   * and for a `sel -> tmpl` rename. Each new name is canonicalized (`../x`
   * becomes `x`, and a name with no canonical form throws) before names are
   * compared. Where any name changed, the
   * result's origin adds a rename step from each new name to its old one.
   * @throws ConflictError where two different files take one name, both sides
   * attributed by this set's provenance; the same file twice under one name is
   * kept once.
   */
  public rename(renamer: (name: string, file: IFile) => string | undefined): FileSet {
    const result = new Map<string, IFile>();
    const sourceName = new Map<string, string>();
    for (const [name, file] of this.content) {
      const rawName = renamer(name, file);
      if (rawName === undefined) {
        continue;
      }
      /* Checking a name is canonical is much cheaper than canonicalizing it. */
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
    return new FileSet(result, renamedOrigin(this.origin, sourceName), CANONICAL);
  }

  /**
   * @return the files of this set whose names `files` does not hold, whatever
   * their content.
   */
  public minus(files: FileSet): FileSet {
    const result = new Map(this.content);
    for (const [name] of files.content) {
      result.delete(name);
    }
    return new FileSet(result, this.origin, CANONICAL);
  }

  /**
   * Union `refs`, each FileSetRef taken as the files it selects. No sets gives
   * the empty set, and one gives itself.
   * @throws ConflictError where two different files share a name, each side
   * attributed by its set's provenance; the same file twice is kept once.
   */
  public static unionAll(...refs: Array<FileSet | FileSetRef>): FileSet {
    /* A ref is replaced by the files it selects, so its container is lost
     * here: a caller that needs the container uses `locate`. */
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
    /* The merge step holds the contributors, not a table of files (see
     * FILESET_MERGE_PROVENANCE). */
    return new FileSet(result, mergeOrigin(sets.map(fileset => ({ prefix: "", fileset }))), CANONICAL);
  }

  /**
   * Lay out `data`, each entry under its key: a FileSet, or a list of them,
   * mounted under the key as a directory, and a bare file named by the key
   * itself. A later file at a name replaces an earlier one, unchecked.
   * @throws where a bare file's key is empty.
   */
  public static layout(data: Record<string, FileSet | Array<FileSet | undefined> | IFile | undefined>): FileSet {
    /* A mounted name is a canonical prefix joined to a canonical name, so
     * canonicalize each prefix once. Names are `/`-separated on every
     * platform. */
    const result = new Map<string, IFile>();
    /* The sets laid out, with their mounts, for the merge step. A bare file
     * has no origin, so is not recorded. */
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
        /* A bare file is named by its key alone, so an empty key is refused. */
        result.set(canonicalFileName(prefix), files);
      }
    }
    return new FileSet(result, mergeOrigin(sources), CANONICAL);
  }
}

export const EMPTY_FILESET: FileSet = new FileSet(new Map());

/**
 * The provenance kind of a set assembled from several sets (`unionAll`,
 * `layout`, `mountedAt`). The step holds its contributors, not a table of
 * files, and finds a file's origin only when asked: it strips the file's
 * mount prefix, finds the contributor holding it, and asks that set's origin,
 * through any nested merges.
 */
export const FILESET_MERGE_PROVENANCE = "fileset-merge";

interface IMergeSource {
  /** The prefix the set is mounted under, ending in `/`; empty at the root. */
  readonly prefix: string;
  readonly fileset: FileSet;
}

interface IMergeOrigin extends IProvenanceStep {
  readonly kind: typeof FILESET_MERGE_PROVENANCE;
  readonly sources: ReadonlyArray<IMergeSource>;
  /** The sources by the prefix each is mounted under (see {@link holdersOf}). */
  readonly byPrefix: ReadonlyMap<string, ReadonlyArray<IMergeSource>>;
  /** The number of distinct names the merge holds, counted once asked. */
  readonly size: number;
}

/** Make a merge step over `sources`, or undefined where none has an origin. */
function mergeOrigin(sources: IMergeSource[]): IMergeOrigin | undefined {
  if (!sources.some(source => source.fileset.origin !== undefined)) {
    return undefined;
  }
  const byPrefix = new Map<string, IMergeSource[]>();
  for (const source of sources) {
    const mounted = byPrefix.get(source.prefix);
    if (mounted === undefined) {
      byPrefix.set(source.prefix, [source]);
    } else {
      mounted.push(source);
    }
  }
  let size: number | undefined;
  return {
    kind: FILESET_MERGE_PROVENANCE,
    sources,
    byPrefix,
    get size(): number {
      return (size ??= new Set(sources.flatMap(source => [...source.fileset].map(([name]) => source.prefix + name))).size);
    },
  };
}

/**
 * Get each source of `merge` holding `path`, with the name it holds it by: only
 * a source mounted at the root or at one of the path's directories can, so
 * those are the prefixes looked up.
 */
function holdersOf(merge: IMergeOrigin, path: string): Array<{ source: IMergeSource; rel: string }> {
  const holders: Array<{ source: IMergeSource; rel: string }> = [];
  for (let end = 0; end !== -1; end = path.indexOf("/", end) + 1 || -1) {
    const prefix = path.slice(0, end);
    for (const source of merge.byPrefix.get(prefix) ?? []) {
      const rel = path.slice(prefix.length);
      if (source.fileset.getFile(rel) !== undefined) {
        holders.push({ source, rel });
      }
    }
  }
  return holders;
}

registerProvenanceRenderer<IMergeOrigin>(FILESET_MERGE_PROVENANCE, (merge, context): IDiagnosticNote[] => {
  if (context.path !== undefined) {
    const found = contributorOf(merge, context.path);
    if (found?.fileset.origin !== undefined) {
      return renderProvenance(found.fileset.origin, { ...context, path: found.rel });
    }
  }
  return [];
});

/* A merge moves files: each answer strips the mount prefix and asks the
 * contributors holding the file, as the renderer does. */
registerProvenanceNaming<IMergeOrigin>(FILESET_MERGE_PROVENANCE, {
  /* The least of the holders' answers, as for the source path. */
  derivedFrom: (step, path) => {
    let least: string | undefined;
    for (const { source, rel } of holdersOf(step, path)) {
      const from = source.fileset.derivedFromOf(rel);
      if (from !== undefined && (least === undefined || from < least)) {
        least = from;
      }
    }
    return least;
  },
  /* Where several contributors hold the name (one file, kept once by the
   * union), the least of their source paths, whatever order the union was
   * given them in. */
  sourcePath: (step, path) => {
    let least: string | undefined;
    for (const { source, rel } of holdersOf(step, path)) {
      const sourcePath = source.fileset.sourcePathOf(rel);
      if (sourcePath !== undefined && (least === undefined || sourcePath < least)) {
        least = sourcePath;
      }
    }
    return least;
  },
  /* Each contributor by its mount and its own digest, sorted. Where another
   * contributor's mount overlaps its own, the names each holds are recorded
   * too: they decide which contributor answers for a name. */
  digest: (merge, names) => {
    if (names === undefined || names.length === merge.size) {
      return mergeDigestOf(merge.sources.filter(source => source.fileset.size > 0));
    }
    /* Each contributor holding one of the names, with the names it holds. */
    const holding = new Map<IMergeSource, string[]>();
    for (const name of names) {
      for (const { source, rel } of holdersOf(merge, name)) {
        const rels = holding.get(source);
        if (rels === undefined) {
          holding.set(source, [rel]);
        } else {
          rels.push(rel);
        }
      }
    }
    return mergeDigestOf([...holding].map(([{ prefix, fileset }, rels]) => ({ prefix, fileset, names: rels })));
  },
});

/**
 * Digest a merge over the names its contributors in `held` hold: each by its
 * mount and its own digest over those names (`names`, or all of its own where
 * absent), with the names listed where another contributor's mount overlaps
 * its own. A contributor's digest over all its names is its set's memoized
 * {@link FileSet.sourcePathsDigest}, so each set is digested once however many
 * merges hold it.
 */
function mergeDigestOf(held: ReadonlyArray<{ prefix: string; fileset: FileSet; names?: string[] }>): string {
  const namesOf = ({ fileset, names }: { fileset: FileSet; names?: string[] }): string[] =>
    names ?? [...fileset].map(([name]) => name);
  /* One contributor, at the root, names its files as it would alone. */
  if (held.length === 1 && held[0].prefix === "") {
    return sourcePathsDigestOf(held[0].fileset.origin, namesOf(held[0]));
  }
  const overlaps = (prefix: string): boolean =>
    held.filter(other => other.prefix.startsWith(prefix) || prefix.startsWith(other.prefix)).length > 1;
  const sources = held
    .map(contributor => {
      const { prefix, fileset, names } = contributor;
      const digest =
        names === undefined || names.length === fileset.size ? fileset.sourcePathsDigest : fileset.sourcePathsDigestOf(names);
      return { prefix, contributor, digest };
    })
    .filter(({ digest }) => digest !== "")
    .map(({ prefix, contributor, digest }) => {
      const listed = overlaps(prefix) ? ` ${hashString([...namesOf(contributor)].sort().join("\n"))}` : "";
      return `${JSON.stringify(prefix)}${listed} ${digest}`;
    })
    .sort();
  return sources.length === 0 ? "" : namingDigest(FILESET_MERGE_PROVENANCE, sources.join(" "), "");
}

/** Get the origin of a set renamed from one with `origin`, each new name to its
 * old one in `from`: a rename step over it where any name changed. */
function renamedOrigin(origin: IProvenanceStep | undefined, from: ReadonlyMap<string, string>): IProvenanceStep | undefined {
  if (origin === undefined || [...from].every(([name, was]) => name === was)) {
    return origin;
  }
  const step: IRenameStep = { kind: RENAME_PROVENANCE, from, parent: origin };
  return step;
}

/** Find the merged-in set holding `path`, and the name it holds it under. */
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
