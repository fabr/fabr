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
import { FileSet } from "./FileSet";
import { ResolvedNode } from "./PackageFileSet";
import { chainSteps, IProvenanceStep, referenceStep } from "./Provenance";
import { IProjection, Miss, NO_REFERENCE_FIELDS, Reference, ReferenceFields } from "./Reference";
import { renamedAndProjected, ProjectedPackage, renamedAs, RepositoryRef, SourceRef } from "./Repository";

/**
 * What a target is before it is built, as a source: its node, or a projection
 * pending over it.
 */
export type Unbuilt = ResolvedNode | ProjectedPackage;

/**
 * A target's node, as a reference to the target finishes it: a resolved node
 * that can be built, and whose build a projection selects from. The
 * configuration's resolved target implements it.
 */
export interface TargetNode extends ResolvedNode {
  /** Build the target and return its result, as its rule yields it. Built on
   * first demand, once. */
  materialize(): Computable<SourceRef[]>;
  /** Apply `projection` to `sources`, what the target built, as a reference
   * selecting its files does; `miss` is the error where it selects nothing. */
  projectBuilt(sources: SourceRef[], projection: IProjection, miss: Miss | undefined): SourceRef[] | Computable<SourceRef[]>;
}

/** What a {@link TargetRef} resolves against: the configuration that keeps each
 * of its targets resolved by name. */
export interface TargetSource {
  resolvedTarget(name: string): Computable<TargetNode>;
}

export class TargetRef extends Reference {
  private materialized?: Computable<SourceRef[]>;
  private asNodes?: Computable<Unbuilt[]>;

  constructor(
    /** The configuration the target is resolved in. */
    public readonly source: TargetSource,
    /** The target's name. */
    public readonly name: string,
    fields: ReferenceFields = NO_REFERENCE_FIELDS
  ) {
    super(fields);
  }

  /** A target answers for itself, whatever it builds. */
  public readonly requiresPackage = false;

  /** Whether this is the target itself, and not a selection of its files. */
  public get whole(): boolean {
    return this.projections.length === 0;
  }

  /** Resolve the target, with nothing written on this reference applied. */
  public resolveTarget(): Computable<TargetNode> {
    return this.source.resolvedTarget(this.name);
  }

  /** Get the target as its node, with what was written on this reference
   * applied: resolved, not built. */
  public nodes(): Computable<Unbuilt[]> {
    return (this.asNodes ??= Computable.detached(() => this.resolveTarget().then(target => [this.applyToNode(target)])));
  }

  /** Build the target and return its result, with what was written on this
   * reference applied. Built on first demand, once. */
  public materialize(): Computable<SourceRef[]> {
    return (this.materialized ??= Computable.detached(() =>
      this.resolveTarget().then(target => {
        const named = target.materialize().then(sources => sources.map(source => this.applyToBuilt(source)));
        const projected = this.projections.reduce(
          (result, projection, index) => result.then(sources => target.projectBuilt(sources, projection, this.misses[index])),
          named
        );
        return answeredBy(projected, this.steps);
      })
    ));
  }

  protected withFields(fields: ReferenceFields): this {
    return new TargetRef(this.source, this.name, fields) as this;
  }

  /** The reference as a message names it. */
  public toString(): string {
    return this.renameTo === undefined ? this.name : `${this.name} -> ${this.renameTo}`;
  }

  /** Stamp the reference's steps on one source of what the target built, and
   * apply its rename. */
  private applyToBuilt(source: SourceRef): SourceRef {
    const { renameTo, steps } = this;
    const stepped =
      source instanceof FileSet || source instanceof RepositoryRef || source instanceof TargetRef
        ? steps.reduce<SourceRef>((stepped, step) => (stepped as FileSet | RepositoryRef | TargetRef).withStep(step), source)
        : source;
    return renameTo === undefined ? stepped : renamedAs(stepped, renameTo, this.toString());
  }

  /** Apply what was written to the target's node. */
  private applyToNode(node: TargetNode): Unbuilt {
    const { steps } = this;
    const origin = chainSteps(steps, node.origin);
    const stamped = origin === undefined ? node : node.withOrigin(origin);
    const answered =
      steps.length === 0 ? stamped : stamped.withContent({ ...stamped.content, files: () => answeredBy(stamped.content.files(), steps) });
    const miss = this.misses[this.misses.length - 1];
    return renamedAndProjected(answered, { renameTo: this.renameTo, projections: this.projections, miss }, this.toString()) as Unbuilt;
  }
}

/**
 * Report a failure of `result` as the failure of each reference `steps`
 * record, innermost first, and label each for a cycle through it.
 */
function answeredBy<T>(result: Computable<T>, steps: ReadonlyArray<IProvenanceStep>): Computable<T> {
  return steps.reduce((answered, step) => {
    const handling = referenceStep(step);
    return handling === undefined
      ? answered
      : answered
          .catch((err: Error): never => {
            throw handling.failure(step, err);
          })
          .labelled(handling.label(step));
  }, result);
}

function opened(sources: ReadonlyArray<SourceRef>, open: (ref: TargetRef) => Computable<SourceRef[]>): Computable<SourceRef[]> {
  if (!sources.some(source => source instanceof TargetRef)) {
    return Computable.resolve([...sources]);
  }
  return Computable.forAll(
    sources.map(source =>
      source instanceof TargetRef ? open(source).then(inner => opened(inner, open)) : Computable.resolve([source])
    ),
    (...lists: SourceRef[][]) => lists.flat()
  );
}

/** Build every target reference among `sources` and replace it with the
 * target's result. */
export function materializeTargets(sources: ReadonlyArray<SourceRef>): Computable<SourceRef[]> {
  return opened(sources, ref => ref.materialize());
}
