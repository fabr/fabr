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
import { chainSteps, IProvenanceStep } from "./Provenance";
import { Name } from "../model/Name";

/**
 * A repository resolves named requirements into file content — as distinct
 * from a FileSource, which is a container that can answer queries about files
 * it already has. A repository is the resolution domain: all of the references
 * against it that reach one collection point are resolved together, so that
 * the result of each requirement can depend on what else is being resolved
 * with it (e.g. joint minimal-version-selection).
 */
export interface Repository {
  /**
   * Resolve a batch of references together, returning the base files for each
   * reference in order. Projections and provenance carried by the references
   * are applied by the caller (see materializeAll). The repository delivers the
   * artifact its *operation* asks for — a plain package for build/test, or (its
   * ecosystem's notion of) a runnable for run — reading that operation (and any
   * other global config it selects on, e.g. a host platform) from its
   * RepositoryContext, which is interned per BuildContext and so reflects the
   * constraints these references were consumed under. Making a package runnable
   * is the repository's own business; the `run` delivery is a sealed launch
   * install, not files for the consumer to lay out, so "consumers decide layout"
   * is intact. Under the `files` operation the consumer wants only a package's
   * own files (see FILES_OPERATION), so a repository may deliver them without
   * resolving the dependency closure at all.
   */
  resolveAll(references: RepositoryRef[]): Computable<FileSet[]>;

  /**
   * Claim the identity portion of a reference name that this repository
   * resolves (e.g. npm's `name:version`); anything left over is a projection
   * *into* the resolved package.
   */
  splitReference(name: Name): { requirement: Name; projection?: IProjection };
}

export function isRepository(source: SourceRef): source is Repository {
  return typeof (source as Partial<Repository>).resolveAll === "function";
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
    batches.map(([repository, refs]) => repository.resolveAll(refs)),
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

function groupByRepository(references: RepositoryRef[]): Map<Repository, RepositoryRef[]> {
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
