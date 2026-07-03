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
   * are applied by the caller (see materializeAll).
   */
  resolveAll(references: RepositoryRef[]): Computable<FileSet[]>;
}

export function isRepository(source: SourceRef): source is Repository {
  return typeof (source as Partial<Repository>).resolveAll === "function";
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
    public readonly projections: ReadonlyArray<Name> = [],
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
   * with everything else at the collection point). Note that a RepositoryRef
   * is deliberately NOT a FileSource — it cannot honestly promise files, only
   * a narrower reference.
   */
  public find(name: Name): RepositoryRef {
    return new RepositoryRef(this.source, this.name, [...this.projections, name], this.steps);
  }

  /**
   * Apply this reference's projections and provenance to its resolved base
   * files; called by the collection point after resolution.
   */
  public finishMaterialize(base: FileSet): Computable<FileSet> {
    let result = Computable.resolve(base);
    for (const projection of this.projections) {
      result = result.then(files => files.find(projection));
    }
    return result.then(files => {
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
 * are in hand, the set of references is provably complete. References are
 * partitioned by repository, and each repository resolves its own batch
 * jointly. Projections and provenance carried by the references are applied to
 * the results; other sources pass through unchanged.
 */
export function materializeAll(sources: SourceRef[]): Computable<(FileSource | Repository)[]> {
  const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
  if (references.length === 0) {
    /* No references present, so nothing to resolve */
    return Computable.resolve(sources as (FileSource | Repository)[]);
  }
  const groups = new Map<Repository, RepositoryRef[]>();
  for (const reference of references) {
    const group = groups.get(reference.source);
    if (group) {
      group.push(reference);
    } else {
      groups.set(reference.source, [reference]);
    }
  }
  const batches = [...groups.entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => repository.resolveAll(refs)),
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
