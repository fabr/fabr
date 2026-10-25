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
import { NO_REFERENCE_FIELDS, Reference, ReferenceFields } from "./Reference";
import type { Name } from "./Name";
import type { Repository, RepositoryPublishRef, RepositoryRef } from "./Repository";

/**
 * A reference to a repository named on its own (`@npm`, `@fabr-home`), or a
 * name in it that is not yet a complete reference (`@fabr-home:@fabr-build`, a
 * scope; `@npm:glob`, a package with no version): what a name declared as a
 * repository finds, or what a repository vends for such a name. It names no
 * package and no files, so a collection point refuses it. Where a name goes on
 * from it, the repository vends the reference for the whole name, completed
 * as written (`A:4.17.21` with `A = @npm:lodash;` is `@npm:lodash:4.17.21`), a
 * publish ref likewise, and a route takes the repository from it. Where the
 * repository can list it, its {@link children} are what `fabr ls` shows of it.
 */
export class NamespaceRef extends Reference {
  /** A repository answers no requirement on a package. */
  public readonly requiresPackage = false;

  constructor(
    /** The repository named. */
    public readonly repository: Repository,
    /** The repository's name this narrows to, which a name projected into it
     * goes on from; empty for the whole repository. */
    public readonly name: string = "",
    fields: ReferenceFields = NO_REFERENCE_FIELDS,
    /** The repository's name as written, as on a {@link RepositoryRef}:
     *  display only. */
    public readonly repositoryName?: string
  ) {
    super(fields);
  }

  /** Vend the read reference for this name completed by `name`, written after
   *  `separator` (`:` or `/`; see {@link Repository.getRepositoryRef}),
   *  carrying the repository's written name. */
  public getRepositoryRef(name: Name, separator: string, repositoryName = this.repositoryName): RepositoryRef | NamespaceRef {
    const ref = this.repository.getRepositoryRef(this.completedBy(name, separator));
    return repositoryName === undefined ? ref : ref.withRepositoryName(repositoryName);
  }

  /** Vend the publish ref for this name completed by `name`, written after
   *  `separator` (see {@link Repository.getRepositoryPublishRef}), carrying
   *  the repository's written name. */
  public getRepositoryPublishRef(name: Name, separator: string, repositoryName = this.repositoryName): RepositoryPublishRef {
    const ref = this.repository.getRepositoryPublishRef(this.completedBy(name, separator));
    return repositoryName === undefined ? ref : ref.withRepositoryName(repositoryName);
  }

  /** @return a copy carrying the written repository name (see repositoryName). */
  public withRepositoryName(repositoryName: string): NamespaceRef {
    return new NamespaceRef(this.repository, this.name, this.fields, repositoryName);
  }

  /**
   * List this name's children, as the repository lists them (see {@link
   * Repository.children}). Rejects, attributed to this reference, where the
   * repository cannot list it.
   */
  public children(): Computable<Map<string, Reference>> {
    const listed = this.repository.children?.(this);
    if (listed === undefined) {
      return Computable.reject(this.attributed(new FabrError(`'${this.toString()}' cannot be listed`)));
    }
    return listed.catch(err => {
      throw this.attributed(toError(err));
    });
  }

  public toString(): string {
    return [this.repositoryName, this.name].filter(part => part !== undefined && part !== "").join(":");
  }

  /** Make the error for asking this reference for a package or files,
   * attributed to where it was written. */
  public refused(): Error {
    const written = this.toString();
    return this.attributed(
      this.name === ""
        ? new FabrError(`'${written}' names a repository, not a package or files`).withHelp(`name what you want from it, as in '${written}:<name>'`)
        : new FabrError(`'${written}' is not a complete reference, so it names no package or files`).withHelp(
            "write the rest of the name after it"
          )
    );
  }

  /** Attribute `err` to where this reference was written. */
  private attributed(err: Error): Error {
    return err instanceof RequirementResolutionError ? err : new RequirementResolutionError([this], err);
  }

  /** Complete this repository name by `name`, written after `separator`. */
  private completedBy(name: Name, separator: string): Name {
    return this.name === "" ? name : name.withPrefix(`${this.name}${separator}`);
  }

  protected withFields(fields: ReferenceFields): this {
    return new NamespaceRef(this.repository, this.name, fields, this.repositoryName) as this;
  }
}

/** Take `sources` as content, refusing a namespace among them (see
 *  {@link NamespaceRef.refused}). */
export function refuseNamespaces<T>(sources: ReadonlyArray<T | NamespaceRef>): T[] {
  const namespace = sources.find((source): source is NamespaceRef => source instanceof NamespaceRef);
  if (namespace !== undefined) {
    throw namespace.refused();
  }
  return sources as T[];
}
