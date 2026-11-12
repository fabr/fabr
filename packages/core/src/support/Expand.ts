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
import { Readable } from "stream";
import { Computable, ComputableSource } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { Name } from "../core/Name";
import { isArchiveMime, sniffMime } from "./Mime";
import { unpackStream } from "./Unpack";
import { MemoryOutput } from "../core/MemoryFS";

/**
 * Archive descent: a projection that names a path inside an archive file
 * (`./x.tgz:*:**`) reads the archive as a directory of the same name. An
 * archive is expanded only where a pattern names a path inside it, never where
 * a `**` sweeps past it. Whether a file is an archive is judged by its
 * content, never its name.
 */

/**
 * A function expanding an archive file into its contents, named relative to
 * the archive's root: the build's cached expansion
 * (`BuildContextImpl.expandArchive`), or {@link expandOnce} where there is no
 * cache.
 */
export type ExpandFn = (file: IFile) => Computable<FileSet>;

/**
 * List the probes of a pattern: the prefixes that may name an archive file
 * with more of the pattern after it. For each separator with pattern after it,
 * the pattern up to the separator ({@link Name.componentPrefixes}), in slash
 * form, so a probe's matches are named by their paths.
 *
 * A prefix whose last component contains `**` is left out, so a recursive glob
 * never probes the files it sweeps. The list stops at a component holding an
 * unsubstituted `${var}`. A probe carries no rename or constraints.
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
 * Project `source` by `pattern` with archive descent: `source.find`, unioned
 * with the matches inside each archive a probe of the pattern lands on (see
 * {@link descentPrefixes}). The archive is expanded with `expand`, mounted at
 * the archive file's path, and the whole pattern matched over it again, so
 * `./a.tgz:*:**` names its results as it would were `a.tgz` a directory, and a
 * nested archive is descended into the same way.
 *
 * Where the pattern has no probes, or no probe lands on a file, this returns
 * `source.find` itself (a runnable keeps its entry selection, and a bare
 * reference to an archive stays the file). A file a probe lands on that is
 * not an archive adds nothing. Matching nothing is not an error here: the
 * caller reports it. A failure to expand an archive is an error where the
 * probe named it literally, and adds nothing where a glob matched it.
 *
 * `FileSource.find` never descends into archives; only this does.
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
        /* unionAll returns a sole argument as it is: where nothing was found
         * inside an archive, a runnable stays a runnable. */
        return FileSet.unionAll(directSet, ...descended.filter(files => !files.isEmpty()));
      }
    );
  });
}

/** A file a probe landed on: its path, and whether the probe named it
 * literally rather than matching it with a glob. */
interface BoundaryCandidate {
  at: string;
  file: IFile;
  named: boolean;
}

/**
 * Find the files a probe lands on, each with its path: a literal probe looks
 * its one path up with `get`, a glob probe is matched with `find`.
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
 * @return a literal probe's path normalized as a FileSet names files, or
 *   undefined where it names nothing within the source (empty, absolute, or
 *   leading out with `..`).
 */
function probePath(literal: string): string | undefined {
  const normalized = path.posix.normalize(literal);
  if (normalized === "" || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

/**
 * Match `pattern` inside the archive a probe landed on: where the file's
 * {@link IFile.mime} is an archive's, its expansion mounted at the file's path
 * and matched with {@link findWithDescent}; any other file gives the empty set.
 */
function descend(candidate: BoundaryCandidate, pattern: Name, prefix: string, expand: ExpandFn): Computable<FileSet> {
  const { at, file, named } = candidate;
  if (!isArchiveMime(file.mime)) {
    return Computable.resolve(EMPTY_FILESET);
  }
  /* An archive a glob matched that cannot be expanded (a corrupt or unreadable
   * file) adds nothing; one the pattern names literally fails. */
  const expansion = named ? expand(file) : expand(file).catch(() => EMPTY_FILESET);
  return expansion.then(expanded =>
    expanded.isEmpty() ? expanded : findWithDescent(FileSet.layout({ [at]: expanded }), pattern, prefix, expand)
  );
}

/**
 * Expand an archive, read whole into memory, into its files held in memory: the
 * {@link ExpandFn} where there is no cache. A file that is not an archive
 * expands to the empty set.
 */
export function expandOnce(file: IFile): Computable<FileSet> {
  return file.getBuffer().then(buffer => {
    if (!isArchiveMime(sniffMime(buffer))) {
      return Computable.resolve(EMPTY_FILESET);
    }
    return unpackStream(Readable.from([buffer]), () => new MemoryOutput());
  });
}

/** The cache tag of memoized expansions. Bump it when what an archive expands
 *  to changes (symlinks, name normalization, modes). */
export const EXPAND_TAG = "expand:1";
