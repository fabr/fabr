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

import type { Name } from "./Name";
import type { IProvenanceStep } from "./Provenance";

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

/** What a {@link Reference} is made of, beside what it names. */
export interface ReferenceFields {
  readonly projections: ReadonlyArray<IProjection>;
  /** For each of `projections`, the error where it selects nothing and that
   * is an error. */
  readonly misses: ReadonlyArray<(() => Error) | undefined>;
  readonly renameTo?: string;
  readonly steps: ReadonlyArray<IProvenanceStep>;
  readonly override?: "alternate" | "force";
}

/** The fields of a reference with nothing written on it beside what it names. */
export const NO_REFERENCE_FIELDS: ReferenceFields = { projections: [], misses: [], steps: [] };

/**
 * A name looked up and not yet resolved: what a written reference finds,
 * unless that is content already. What was written on it beside the name (its
 * projections, rename, provenance and override marker) is data on it, the
 * same for every kind, and is applied to what it resolves to. A subclass says
 * what answers it.
 *
 * Instances are immutable: what is written accumulates into new copies, so a
 * reference cached in a shared property value is never changed by one of its
 * consumers. A copy is of the same kind as its original.
 */
export abstract class Reference {
  constructor(protected readonly fields: ReferenceFields = NO_REFERENCE_FIELDS) {}

  /** The name of what this reference names: a package, or a target. */
  public abstract readonly name: string;

  /** Whether what answers this reference must be a package. */
  public abstract readonly requiresPackage: boolean;

  /** The name what this reference names is delivered under: the rename
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
  public get misses(): ReadonlyArray<(() => Error) | undefined> {
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
  public find(name: Name, prefix = "", miss?: () => Error): this {
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

  /** Make a copy with `changes` made, of the same kind as this reference. */
  protected copy(changes: Partial<ReferenceFields>): this {
    return this.withFields({ ...this.fields, ...changes });
  }

  /** Make a reference of this kind, naming what this one names, made of
   * `fields`. */
  protected abstract withFields(fields: ReferenceFields): this;
}
