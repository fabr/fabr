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
import { Readable, Writable } from "stream";
import type { IOutputHandle } from "./Execute";
import { Computable, ComputableSource } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { isArchiveMime, sniffMime } from "./Mime";
import { unpackStream } from "./Unpack";

/**
 * An archive read as a **directory of the same name**: the equivalence that lets
 * `./x.tgz:*:**` and `@dl:x.tgz:*:**` mean the same thing as projecting into a
 * directory. Expansion happens when something addresses *into* an archive, never
 * because a glob swept past one — `**` does not cross a namespace boundary, so a
 * recursive match over a source tree can never explode the archives in it.
 *
 * Whether a file *can* be read this way is decided by its content (magic bytes),
 * not its name: an extension is a convention, and a member of a `fetch` table is
 * named by its author.
 */

/**
 * The boundary action the walker is parameterized by: an archive file's
 * contents as a FileSet, named relative to the archive root. Production binds
 * this to the resolver's cached expansion (BuildContext.expandArchive — the
 * one owner of the traversal, with the BuildCache in hand); a caller with no
 * cache (tests) binds {@link expandOnce}. A domain seam, not cache plumbing —
 * it is also where a hypothetical second boundary kind would plug in.
 */
export type ExpandFn = (file: IFile) => Computable<FileSet>;

/**
 * The namespace-boundary probes of a selector — the walker's descent policy
 * over {@link Name.componentPrefixes}: for each separator with selector
 * remaining, the pattern up to (excluding) it, in slash form so a probe's
 * matches keep their in-namespace paths rather than being alias-stripped. A
 * prefix whose final component contains `**` is excluded: `**` never
 * participates in a crossing, which is what keeps a recursive glob sweeping a
 * source tree from probing every file it matches. Candidates stop at an
 * unsubstituted `${var}` (nothing concrete to probe with), and probes carry no
 * facets — a rename or constraint applies to the whole reference, never to a
 * probe. Exported so the policy is testable directly; the walker is its one
 * production consumer.
 */
export function descentPrefixes(pattern: Name): Name[] {
  const components = pattern.components();
  const prefixes = pattern.componentPrefixes();
  const probes: Name[] = [];
  for (let i = 0; i < components.length - 1; i++) {
    if (components[i].hasVarSubst()) {
      break;
    }
    if (!prefixes[i].isEmpty() && !components[i].getGlobUnits().some(unit => unit.includes("**"))) {
      probes.push(prefixes[i]);
    }
  }
  return probes;
}

/**
 * Project `source` by `pattern` with **archive descent**: the ordinary
 * polymorphic `find`, plus — wherever a proper prefix of the pattern lands on a
 * real file with pattern remaining (see {@link descentPrefixes}) — that file
 * read as a directory of its contents (`expand`) and the whole pattern
 * re-matched over the expansion mounted at the file's path. Mounting (rather
 * than splitting the remainder off) is what makes naming fall out of the
 * ordinary written-name rule: `./a.tgz:*:**` names results relative to
 * `a.tgz:*` exactly as it would were `a.tgz` a directory. Recursion over the
 * mounted set descends nested archives the same way.
 *
 * A pattern with no boundary candidates returns the source's own `find`
 * untouched — so a runnable's projection keeps its bin-selection semantics, and
 * a bare reference to an archive stays the file. Descent contributes only when
 * an expansion actually matches; a non-archive file landed on by a probe simply
 * contributes nothing (the projection's "matched no files" reporting is the
 * caller's, unchanged). This is the ONE place descent exists: `find` itself
 * stays archive-free, so a programmatic find can never explode an archive —
 * descent is projection-scoped by construction.
 */
export function findWithDescent(source: FileSource, pattern: Name, prefix: string, expand: ExpandFn): ComputableSource<FileSet> {
  const probes = descentPrefixes(pattern);
  const direct = source.find(pattern, prefix);
  if (probes.length === 0) {
    return direct;
  }
  return Computable.forAll(
    probes.map(probe => probeBoundary(source, probe)),
    (...found: BoundaryCandidate[][]) => found.flat()
  ).then(candidates => {
    if (candidates.length === 0) {
      return direct;
    }
    return Computable.forAll(
      [direct, ...candidates.map(candidate => descend(candidate, pattern, prefix, expand))],
      (...sets: FileSet[]) => {
        const [directSet, ...descended] = sets;
        /* unionAll returns a sole argument unchanged, so a runnable's narrowed
         * self survives when no descent contributed. */
        return FileSet.unionAll(directSet, ...descended.filter(files => !files.isEmpty()));
      }
    );
  });
}

/** A file a boundary probe landed on: its in-namespace path, and whether the
 * probe was literal — the user *named* this path — or a glob that merely swept
 * it (which decides how an expansion failure is judged; see descend). */
interface BoundaryCandidate {
  at: string;
  file: IFile;
  named: boolean;
}

/**
 * The files a boundary probe lands on, each with its in-namespace path. A
 * fully-literal probe is an exact-name lookup (`get` — no enumeration); a
 * globbed one is an ordinary find, whose slash-form pattern keeps result names
 * equal to their paths.
 */
function probeBoundary(source: FileSource, probe: Name): Computable<BoundaryCandidate[]> {
  const literal = probe.getSimpleName();
  if (literal !== undefined) {
    const at = probePath(literal);
    if (at === undefined) {
      return Computable.resolve([]);
    }
    return source.get(at).then(file => (file ? [{ at, file, named: true }] : []));
  }
  return source.find(probe).then(files => [...files].map(([at, file]) => ({ at, file, named: false })));
}

/**
 * A literal probe's path in canonical form (the namespace FileSet names / the
 * filesystem walk live in), or undefined for one that cannot name inside this
 * namespace (empty, absolute, or climbing out — such a pattern matches nothing
 * anyway, so there is no boundary to find).
 */
function probePath(literal: string): string | undefined {
  const normalized = path.posix.normalize(literal);
  if (normalized === "" || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

/**
 * Cross one boundary: if the file is an archive (by its sniffed {@link
 * IFile.mime} — a property read, no I/O), mount its expansion at the file's own
 * path and re-match the whole pattern over it (recursively, so a nested archive
 * descends again). Anything else contributes nothing.
 */
function descend(candidate: BoundaryCandidate, pattern: Name, prefix: string, expand: ExpandFn): Computable<FileSet> {
  const { at, file, named } = candidate;
  if (!isArchiveMime(file.mime)) {
    return Computable.resolve(EMPTY_FILESET);
  }
  /* A glob-swept candidate is speculative — the pattern merely swept past this
   * file — so one that cannot actually be expanded (an unsupported archive
   * kind like zip, gzip wrapping non-tar content, a corrupt or unreadable
   * file) contributes nothing, per the globs-are-lenient convention. A
   * literal probe is a path the user WROTE: its expansion failure is a real,
   * reportable error. */
  const expansion = named ? expand(file) : expand(file).catch(() => EMPTY_FILESET);
  return expansion.then(expanded =>
    expanded.isEmpty() ? expanded : findWithDescent(FileSet.layout({ [at]: expanded }), pattern, prefix, expand)
  );
}

/**
 * THE expansion: read the whole archive into memory and unpack it. Cached use
 * wraps this ({@link BuildContext.expandArchive} memoizes it in the build
 * cache, keyed on the file's content hash); a cache-less caller (tests) uses
 * it directly as its {@link ExpandFn}. A non-archive yields an empty set
 * rather than an error: "this file has no contents to address into" is the
 * projection's business to report, in the same terms as any other name that
 * matched nothing.
 */
export function expandOnce(file: IFile): Computable<FileSet> {
  return file.getBuffer().then(buffer => {
    if (!isArchiveMime(sniffMime(buffer))) {
      return Computable.resolve(EMPTY_FILESET);
    }
    return unpackStream(Readable.from([buffer]), () => new MemoryOutput());
  });
}

/** Bumped when expansion semantics change (symlink handling, name
 *  normalization, mode bits), so expansions memoized by an older fabr are not
 *  served (cache entries are memos, never inputs). */
export const EXPAND_TAG = "expand:1";

/** An in-memory sink for {@link unpackStream}: entries land as MemoryFiles,
 *  which whoever caches the expansion then ingests (see
 *  BuildContext.expandArchive → BuildCache). */
class MemoryOutput implements IOutputHandle {
  private readonly chunks: Buffer[] = [];

  public readonly stream = new Writable({
    write: (chunk: Buffer, _encoding: BufferEncoding, done: () => void): void => {
      this.chunks.push(Buffer.from(chunk));
      done();
    },
  });

  public finalize(_name: string, mode?: number): Computable<IFile> {
    return Computable.resolve(new MemoryFile(Buffer.concat(this.chunks), mode));
  }

  public discard(): void {
    this.chunks.length = 0;
  }
}
