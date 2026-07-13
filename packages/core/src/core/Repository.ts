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

import { Computable } from "./Computable";
import { FileSet, FileSource } from "./FileSet";
import { PackageFileSet } from "./PackageFileSet";
import { RunnableFileSet } from "./RunnableFileSet";
import { chainSteps, IProvenanceStep } from "./Provenance";
import { Name } from "../model/Name";

/**
 * One resolved root of a {@link Resolution}: the input reference and the name
 * the repository resolved it to — the one thing a caller can read out of an
 * otherwise-opaque Resolution, so it can key/address entries (a catalog keys its
 * members by this) *without* fetching them. `name` is whatever identity the
 * repository addresses entries by (npm: the package name).
 */
export interface ResolvedRoot {
  readonly reference: RepositoryRef;
  readonly name: string;
}

/**
 * The result of a repository's {@link Repository.resolve} phase: versions +
 * dependency tree, but nothing fetched. Opaque to everyone but the repository
 * that produced it (which hands it back to {@link Repository.materialize}),
 * *except* for `roots`. Ecosystem specifics (npm's version selection + reachable
 * tree) live in a private subtype; the generic surface is only `roots`.
 */
export interface Resolution {
  readonly roots: ReadonlyArray<ResolvedRoot>;
}

/**
 * A repository resolves named requirements into file content — as distinct
 * from a FileSource, which is a container that can answer queries about files
 * it already has. Resolution is a domain (all references against it at one
 * collection point resolve together, e.g. joint minimal-version-selection),
 * split into two phases so *fetching* can be deferred past *resolving*:
 * `resolve` fixes versions + the tree (cheap, eager — the pin); `materialize`
 * fetches + assembles a *subset* of that resolution on demand. `resolveAll`
 * (via {@link resolveAndMaterialize}) is just the two composed — what a normal
 * consumer, which needs all of its own references, uses.
 */
export interface Repository {
  /**
   * Phase 1 — resolve versions + dependency tree over the batch, WITHOUT
   * fetching. Returns an opaque, repository-specific Resolution the caller holds
   * and hands back to `materialize`; its `roots` name each resolved reference so
   * a caller (a catalog) can key by name without fetching.
   */
  resolve(references: RepositoryRef[]): Computable<Resolution>;

  /**
   * Phase 2 — materialize (fetch + assemble) the given references, a SUBSET of a
   * prior Resolution. Each reference's dependency closure comes from that
   * pre-resolved tree, never re-resolved, so a subset fetch preserves the joint
   * pin. The repository delivers the artifact its *operation* asks for — a plain
   * package for build/test, a runnable for run — reading it (and any global
   * config it selects on, e.g. a host platform) from its RepositoryContext,
   * interned per BuildContext. Projections and provenance carried by the
   * references are applied by the caller (see materializeAll).
   */
  materialize(references: RepositoryRef[], resolution: Resolution): Computable<FileSet[]>;

  /**
   * Claim the identity portion of a reference name that this repository
   * resolves (e.g. npm's `name:version`); anything left over is a projection
   * *into* the resolved package.
   */
  splitReference(name: Name): { requirement: Name; projection?: IProjection };

  /**
   * Repackage an already-resolved package (its closure carried) as a runnable,
   * **without re-resolving** — a pure, ecosystem-specific transform (for npm:
   * mount the closure as node_modules + a bin surface from package.json). It is
   * separate from `materialize`'s run delivery precisely so that a package
   * resolved in one place can be launched with the *exact* closure it was
   * resolved with: a catalog pins its members' versions jointly, then hands one
   * back here to be made runnable, keeping that joint closure rather than letting
   * a fresh resolution pick different (wrong) dependencies. The package must be
   * one this repository produced (a catalog delegates to its member's source).
   */
  makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet>;
}

/**
 * The eager one-shot: resolve a batch and immediately materialize the whole of
 * it — a normal consumer needs all of its own references, so it resolves and
 * fetches together. The collection point ({@link materializeAll}) uses this; a
 * catalog does NOT — it holds the Resolution and materializes members on demand.
 */
export function resolveAndMaterialize(repository: Repository, references: RepositoryRef[]): Computable<FileSet[]> {
  return repository.resolve(references).then(resolution => repository.materialize(references, resolution));
}

export function isRepository(source: SourceRef): source is Repository {
  return typeof (source as Partial<Repository>).resolve === "function";
}

/**
 * One narrowing step of a reference: the pattern to match (against the names
 * produced by the previous step), and the prefix prepended to the matched
 * names — the written-name rule: `alias/path` keeps the written `alias/` in
 * result names, `alias:path` strips it (empty prefix).
 */
export interface IProjection {
  pattern: Name;
  prefix: string;
}

/**
 * A deferred reference to files from a Repository, possibly narrowed by
 * projections: "the thing we resolve", explicitly separate from the FileSet
 * content it eventually produces. References travel through property and
 * target resolution as inert values, so that the consuming target's collection
 * point can gather every reference that surfaces and resolve them together.
 *
 * Instances are immutable: provenance steps and projections accumulate into
 * new copies, so instances cached in shared property values are never affected
 * by any individual consumer.
 */
export class RepositoryRef {
  constructor(
    public readonly source: Repository,
    public readonly name: Name,
    public readonly projections: ReadonlyArray<IProjection> = [],
    public readonly steps: ReadonlyArray<IProvenanceStep> = []
  ) {}

  /**
   * @return a copy carrying an additional provenance step (innermost first).
   */
  public withStep(step: IProvenanceStep): RepositoryRef {
    return new RepositoryRef(this.source, this.name, this.projections, [...this.steps, step]);
  }

  /**
   * Finding within a reference yields a narrower reference: once resolved,
   * only the files matching the given name remain (still resolved together
   * with everything else at the collection point), renamed under the given
   * prefix per the written-name rule. Note that a RepositoryRef is
   * deliberately NOT a FileSource — it cannot honestly promise files, only a
   * narrower reference.
   */
  public find(name: Name, prefix = ""): RepositoryRef {
    return new RepositoryRef(this.source, this.name, [...this.projections, { pattern: name, prefix }], this.steps);
  }

  /**
   * Apply this reference's projections and provenance to its resolved base
   * files; called by the collection point after resolution.
   */
  public finishMaterialize(base: FileSet): Computable<FileSet> {
    let result = Computable.resolve(base);
    for (const projection of this.projections) {
      /* Each projection narrows on the artifact's own terms (FileSource.find):
       * a package filters files (remapped under the prefix); a runnable re-points
       * its launch entry, ignoring the prefix. */
      result = result.then(files => files.find(projection.pattern, projection.prefix));
    }
    return result.then(files => {
      if (this.steps.length === 0) {
        return files;
      }
      if (files instanceof PackageFileSet) {
        /* The reference's provenance applies to the whole delivery: the root
         * package and every member of its resolved closure arrived via the
         * same reference. (Carried references stay as they are — they get
         * their attribution when they are themselves resolved.) */
        const dependencies = files.dependencies.map(dep =>
          dep instanceof PackageFileSet ? dep.withOrigin(chainSteps(this.steps, dep.origin)!) : dep
        );
        return new PackageFileSet(files, files.packageName, files.version, dependencies, chainSteps(this.steps, files.origin));
      }
      const origin = chainSteps(this.steps, files.origin);
      return origin ? files.withOrigin(origin) : files;
    });
  }
}

/**
 * A FileSource, Repository, or deferred RepositoryRef: the currency of
 * property and target resolution.
 */
export type SourceRef = FileSource | Repository | RepositoryRef;

/**
 * Shallow counterpart to {@link materializeAll} for the CLI verb entry points
 * (`fabr ls`/`cat`/`run` via `resolveName`): resolve only the top-level
 * references the name itself denotes — never the dependency closure a delivered
 * package carries. A verb wants the named entity's own content (its files, or
 * its runnable), not its mounted deps: recursing the closure here would
 * re-resolve a built package's carried externals pointlessly (ls/cat discard the
 * deps, reading only the delivered set's own files) and under the wrong
 * operation (those refs ride the repository instance they were built with, not
 * this `files` one), so it both wastes work and can fail on a requirement only
 * the original build context constrained. Non-reference sources (a built
 * package, a runnable) pass through untouched.
 */
export function materializeShallow(sources: SourceRef[]): Computable<(FileSource | Repository)[]> {
  const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
  if (references.length === 0) {
    return Computable.resolve(sources as (FileSource | Repository)[]);
  }
  const batches = [...groupByRepository(references).entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => resolveAndMaterialize(repository, refs)),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, Computable<FileSet>>();
      batches.forEach(([, refs], batchIndex) =>
        refs.forEach((ref, index) => finished.set(ref, ref.finishMaterialize(results[batchIndex][index])))
      );
      return Computable.forAll(
        sources.map(source => (source instanceof RepositoryRef ? finished.get(source)! : Computable.resolve(source))),
        (...resolved: (FileSource | Repository)[]) => resolved
      );
    }
  );
}

/**
 * Resolve the RepositoryRefs among the given sources: this is the collection
 * point — because the caller's inputs are all settled by the time the sources
 * are in hand, the set of references is provably complete. The batch includes
 * the references CARRIED by packages among the sources (a built package's
 * direct external requirements, gathered recursively through its built-package
 * deps), so every requirement reachable from this collection point takes part
 * in one joint resolution per repository — resolved fresh here, in this
 * consumer's context. Projections and provenance carried by the references are
 * applied to the results; packages are re-delivered with their carried
 * references replaced by the resolutions; other sources pass through
 * unchanged.
 */
export function materializeAll(sources: SourceRef[]): Computable<(FileSource | Repository)[]> {
  const references = gatherReferences(sources);
  if (references.length === 0) {
    /* No references present, so nothing to resolve */
    return Computable.resolve(sources as (FileSource | Repository)[]);
  }
  const batches = [...groupByRepository(references).entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => resolveAndMaterialize(repository, refs)),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, Computable<FileSet>>();
      batches.forEach(([, refs], batchIndex) =>
        refs.forEach((ref, index) => finished.set(ref, ref.finishMaterialize(results[batchIndex][index])))
      );
      const rebuilt = new Map<PackageFileSet, Computable<PackageFileSet>>();
      return Computable.forAll(
        sources.map(source => {
          if (source instanceof RepositoryRef) {
            return finished.get(source)!;
          } else if (source instanceof PackageFileSet) {
            return rebuildPackage(source, finished, rebuilt);
          } else {
            return Computable.resolve(source);
          }
        }),
        (...resolved: (FileSource | Repository)[]) => resolved
      );
    }
  );
}

/**
 * Materialize several gathered source-lists through ONE joint {@link materializeAll}
 * — so every reference across all of them resolves together — returning the
 * results partitioned back per input list. The shared core of the collection-point
 * accessors (`getFileSets`, `getGlobalTarget`, `collect`): each is just this plus
 * its own shaping (filter to FileSet / keep repositories / key per name).
 */
export function materializeLists(lists: SourceRef[][]): Computable<(FileSource | Repository)[][]> {
  return materializeAll(lists.flat()).then(resolved => {
    const partitioned: (FileSource | Repository)[][] = [];
    let index = 0;
    for (const list of lists) {
      partitioned.push(resolved.slice(index, index + list.length));
      index += list.length;
    }
    return partitioned;
  });
}

/**
 * @return every reference among the sources, plus those carried by packages —
 * recursively through their built-package deps — deduplicated by identity.
 */
function gatherReferences(sources: SourceRef[]): RepositoryRef[] {
  const references: RepositoryRef[] = [];
  const visited = new Set<RepositoryRef | PackageFileSet>();
  const gather = (source: SourceRef | PackageFileSet): void => {
    if (source instanceof RepositoryRef && !visited.has(source)) {
      visited.add(source);
      references.push(source);
    } else if (source instanceof PackageFileSet && !visited.has(source)) {
      visited.add(source);
      source.dependencies.forEach(gather);
    }
  };
  sources.forEach(gather);
  return references;
}

export function groupByRepository(references: RepositoryRef[]): Map<Repository, RepositoryRef[]> {
  const groups = new Map<Repository, RepositoryRef[]>();
  for (const reference of references) {
    const group = groups.get(reference.source);
    if (group) {
      group.push(reference);
    } else {
      groups.set(reference.source, [reference]);
    }
  }
  return groups;
}

/**
 * Re-deliver a package with its carried references replaced by their
 * resolutions (recursively through built-package deps); a reference that
 * resolved to something without package identity (e.g. a projection) cannot
 * be mounted and so drops out of the dependency list.
 */
function rebuildPackage(
  pkg: PackageFileSet,
  finished: Map<RepositoryRef, Computable<FileSet>>,
  rebuilt: Map<PackageFileSet, Computable<PackageFileSet>>
): Computable<PackageFileSet> {
  let result = rebuilt.get(pkg);
  if (!result) {
    if (pkg.dependencies.length === 0) {
      result = Computable.resolve(pkg);
    } else {
      result = Computable.forAll(
        pkg.dependencies.map(dep => (dep instanceof RepositoryRef ? finished.get(dep)! : rebuildPackage(dep, finished, rebuilt))),
        (...deps) =>
          new PackageFileSet(
            pkg,
            pkg.packageName,
            pkg.version,
            deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet),
            pkg.origin
          )
      );
    }
    rebuilt.set(pkg, result);
  }
  return result;
}
