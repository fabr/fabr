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
import { FabrError, RequirementResolutionError, toError } from "./Errors";
import type { Name } from "./Name";
import type { IProvenanceStep } from "./Provenance";

/**
 * One projection written on a reference: the pattern matched against the
 * names the previous projection produced, and the prefix put before each
 * matched name (`alias/path` keeps the written `alias/`; `alias:path` has an
 * empty prefix).
 */
export interface IProjection {
  pattern: Name;
  prefix: string;
}

/**
 * A check of what a projection selected, present only where selecting nothing
 * is an error (a written name with no glob). Called with whether the source it
 * was given selected anything, it returns the error where the written name as
 * a whole selected nothing, and undefined where it selected something or other
 * sources the name reached have yet to answer. A name reaching several sources
 * gives each its own through {@link jointMiss}.
 */
export type Miss = (selected: boolean) => Error | undefined;

/**
 * Make the misses for the sources one name reached, each answering to `miss`
 * once every one of them has: the name selected nothing only where none did.
 * A source may answer again (a target rebuilt under watch), superseding its
 * last answer.
 */
export function jointMiss(miss: Miss): () => Miss {
  const answers: Array<boolean | undefined> = [];
  return () => {
    const slot = answers.push(undefined) - 1;
    return selected => {
      answers[slot] = selected;
      return answers.every(answer => answer !== undefined) ? miss(answers.some(answer => answer === true)) : undefined;
    };
  };
}

/** What a {@link Reference} is made of, beside what it names. */
export interface ReferenceFields {
  readonly projections: ReadonlyArray<IProjection>;
  /** For each of `projections`, the error where it selects nothing and that
   * is an error. */
  readonly misses: ReadonlyArray<Miss | undefined>;
  readonly renameTo?: string;
  readonly steps: ReadonlyArray<IProvenanceStep>;
  readonly override?: "alternate" | "force";
}

/** The fields of a reference with nothing written on it beside what it names. */
export const NO_REFERENCE_FIELDS: ReferenceFields = { projections: [], misses: [], steps: [] };

/**
 * A name looked up and not yet resolved: what a written reference finds,
 * unless that is content already. What was written on it beside the name (its
 * projections, rename, provenance steps and override marker) is held on it,
 * the same for every kind, and is applied to what it resolves to. A subclass
 * says what answers it.
 *
 * Instances are immutable: each `with…` method makes a copy of the same kind,
 * so a reference cached in a shared property value is never changed by one of
 * its consumers.
 */
export abstract class Reference {
  constructor(protected readonly fields: ReferenceFields = NO_REFERENCE_FIELDS) {}

  /** The name of what this reference names: a package, or a target. */
  public abstract readonly name: string;

  /** Whether what answers this reference must be a package. */
  public abstract readonly requiresPackage: boolean;

  /** The name what this reference names is required as: the rename
   * written on it, or its own. */
  public get localName(): string {
    return this.renameTo ?? this.name;
  }

  /** The reference as written, for a message. */
  public abstract toString(): string;

  /** The projections written on this reference, in order. */
  public get projections(): ReadonlyArray<IProjection> {
    return this.fields.projections;
  }

  /** For each of {@link projections}, the error where it selects nothing and
   * that is an error. */
  public get misses(): ReadonlyArray<Miss | undefined> {
    return this.fields.misses;
  }

  /** The name what this reference names is delivered under, where it was
   * written with a rename (`-> name`). */
  public get renameTo(): string | undefined {
    return this.fields.renameTo;
  }

  /** The provenance steps of the reference, innermost first. */
  public get steps(): ReadonlyArray<IProvenanceStep> {
    return this.fields.steps;
  }

  /** The override marker written on this reference (`?` / `!`), which the
   * collection it is written in consumes when it resolves it. */
  public get override(): "alternate" | "force" | undefined {
    return this.fields.override;
  }

  /** Get a reference narrowed to what `name` selects from what this one
   * resolves to, named as `prefix` says. `miss` is the error where it selects
   * nothing and that is an error. */
  public find(name: Name, prefix = "", miss?: Miss): this {
    return this.copy({ projections: [...this.projections, { pattern: name, prefix }], misses: [...this.misses, miss] });
  }

  /** Get this reference with another provenance step (innermost first). */
  public withStep(step: IProvenanceStep): this {
    return this.copy({ steps: [...this.steps, step] });
  }

  /** Get this reference with what it names delivered under `renameTo`. */
  public withRenameTo(renameTo: string): this {
    return this.copy({ renameTo });
  }

  /** Get this reference as written with an override marker. */
  public marked(override: "alternate" | "force"): this {
    return this.copy({ override });
  }

  /** Attribute `err` to where this reference was written. */
  protected attributed(err: Error): Error {
    return err instanceof RequirementResolutionError ? err : new RequirementResolutionError([this], err);
  }

  /**
   * Take `listed`, this reference's children as what it names lists them, or
   * undefined where it cannot list them. Rejects, attributed to this reference,
   * where they cannot be listed or the listing fails.
   */
  protected listedChildren(listed: Computable<Map<string, Reference>> | undefined): Computable<Map<string, Reference>> {
    if (listed === undefined) {
      return Computable.reject(this.attributed(new FabrError(`'${this.toString()}' cannot be listed`)));
    }
    return listed.catch(err => {
      throw this.attributed(toError(err));
    });
  }

  /** Make a copy with `changes` made, of the same kind as this reference. */
  protected copy(changes: Partial<ReferenceFields>): this {
    return this.withFields({ ...this.fields, ...changes });
  }

  /** Make a reference of this kind, naming what this one names, made of
   * `fields`. */
  protected abstract withFields(fields: ReferenceFields): this;
}
