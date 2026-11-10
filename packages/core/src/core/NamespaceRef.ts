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
import { FabrError, toError } from "./Errors";
import type { FileSource } from "./FileSet";
import { PartialRepositoryRef } from "./PartialRepositoryRef";
import { NO_REFERENCE_FIELDS, Reference, ReferenceFields } from "./Reference";
import { isRepository } from "./Repository";
import type { Repository } from "./Repository";

/**
 * A namespace (an AWS account's services): each of its names is made the
 * first time it is asked for, and is what a declaration's value could be — a
 * repository, a further namespace, or files. It answers no name itself: a
 * name goes on from the member its first part names.
 */
export abstract class Namespace {
  /** Get what `name` names here, made the first time it is asked for. Rejects where it names nothing. */
  public abstract get(name: string): Computable<Repository | Namespace | FileSource>;

  /** List the names here, each mapped to the reference naming it (see {@link Repository.children}). Absent, nothing here can be listed. */
  public children?(ref: NamespaceRef): Computable<Map<string, Reference>>;
}

/**
 * A reference to a {@link Namespace}: what a name declared as one finds, or a
 * namespace's member that is one. It names no package and no files, so a
 * collection point refuses it. A name goes on from it through the member its
 * first part names ({@link get}).
 */
export class NamespaceRef extends Reference {
  /** A namespace answers no requirement on a package. */
  public readonly requiresPackage = false;

  constructor(
    public readonly namespace: Namespace,
    /** The namespace's name as written (`@aws`, `@aws:111122223333`). */
    public readonly name: string,
    fields: ReferenceFields = NO_REFERENCE_FIELDS
  ) {
    super(fields);
  }

  /**
   * Get the source `name`, written after `separator`, names in the namespace,
   * once it is made, written `<this><separator><name>` (see
   * {@link sourceOf}).
   */
  public get(name: string, separator: string): Computable<PartialRepositoryRef | NamespaceRef | FileSource> {
    const written = `${this.name}${separator}${name}`;
    return this.namespace.get(name).then(
      member => sourceOf(member, written),
      err => {
        throw this.attributed(toError(err));
      }
    );
  }

  /** List the names in the namespace. Rejects, attributed to this reference, where it cannot be listed. */
  public children(): Computable<Map<string, Reference>> {
    return this.listedChildren(this.namespace.children?.(this));
  }

  public toString(): string {
    return this.name;
  }

  /** A namespace has no name a `-> name` could be about. */
  public override withRenameTo(renameTo: string): this {
    const written = this.toString();
    throw this.attributed(
      new FabrError(`'${written}' names a namespace, which cannot be renamed`).withHelp(`rename something in it instead, as in '${written}:<name> -> ${renameTo}'`)
    );
  }

  /** Make the error for asking this reference for a package or files, attributed to where it was written. */
  public refused(): Error {
    const written = this.toString();
    return this.attributed(
      new FabrError(`'${written}' names a namespace, not a package or files`).withHelp(`name what you want in it, as in '${written}:<name>:…'`)
    );
  }

  protected withFields(fields: ReferenceFields): this {
    return new NamespaceRef(this.namespace, this.name, fields) as this;
  }
}

/**
 * Make the source `made` is, written `written`: a reference to a repository
 * ({@link PartialRepositoryRef}) or to a namespace, or the files as they
 * stand. What a declaration's value and a namespace's member are both made
 * into.
 */
export function sourceOf(made: Repository | Namespace | FileSource, written: string): PartialRepositoryRef | NamespaceRef | FileSource {
  if (made instanceof Namespace) {
    return new NamespaceRef(made, written);
  }
  return isRepository(made) ? new PartialRepositoryRef(made, "", NO_REFERENCE_FIELDS, written) : made;
}

/** A reference that names no package and no files: a repository or a name in one that is not yet a complete reference, or a namespace. A consumer of content refuses it; a listing lists its children. */
export type IncompleteRef = PartialRepositoryRef | NamespaceRef;

/** @return true if `source` is an {@link IncompleteRef}, otherwise false. */
export function isIncompleteRef(source: unknown): source is IncompleteRef {
  return source instanceof PartialRepositoryRef || source instanceof NamespaceRef;
}

/** Take `sources` as content, refusing an {@link IncompleteRef} among them. */
export function refuseNamespaces<T>(sources: ReadonlyArray<T | IncompleteRef>): T[] {
  const refused = sources.find(isIncompleteRef);
  if (refused !== undefined) {
    throw refused.refused();
  }
  return sources as T[];
}
