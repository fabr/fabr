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

import { FabrError, RequirementResolutionError } from "./Errors";
import { NO_REFERENCE_FIELDS, Reference, ReferenceFields } from "./Reference";
import type { Name } from "./Name";
import type { Repository, RepositoryPublishRef, RepositoryRef } from "./Repository";

/**
 * A reference to a repository named on its own (`@npm`, `@fabr-home`), or to a
 * namespace of the names in it (`@fabr-home:@fabr-build`, a scope): what a name
 * declared as a repository finds, or what a repository vends for a name that
 * is a namespace of its references rather than one. It names no package and no
 * files, so a collection point refuses it. A reference into the namespace is
 * vended from it where the name goes on (`@npm:lodash:4.17.21`,
 * `@fabr-home:@fabr-build/sass-pnp-importer`), a publish ref likewise, and a
 * route takes the repository from it.
 */
export class NamespaceRef extends Reference {
  /** A repository answers no requirement on a package. */
  public readonly requiresPackage = false;

  constructor(
    /** The repository named. */
    public readonly repository: Repository,
    /** The namespace of the repository's names this narrows to, which a name
     * projected into it goes on from with a `/`; empty for the whole
     * repository. */
    public readonly name: string = "",
    fields: ReferenceFields = NO_REFERENCE_FIELDS,
    /** The repository's name as written, as on a {@link RepositoryRef}:
     *  display only. */
    public readonly repositoryName?: string
  ) {
    super(fields);
  }

  /** Vend the read reference for `name` within this namespace (see
   *  {@link Repository.getRepositoryRef}), carrying the repository's written
   *  name. */
  public getRepositoryRef(name: Name, repositoryName = this.repositoryName): RepositoryRef | NamespaceRef {
    const ref = this.repository.getRepositoryRef(this.within(name));
    return repositoryName === undefined ? ref : ref.withRepositoryName(repositoryName);
  }

  /** Vend the publish ref for `name` within this namespace (see
   *  {@link Repository.getRepositoryPublishRef}), carrying the repository's
   *  written name. */
  public getRepositoryPublishRef(name: Name, repositoryName = this.repositoryName): RepositoryPublishRef {
    const ref = this.repository.getRepositoryPublishRef(this.within(name));
    return repositoryName === undefined ? ref : ref.withRepositoryName(repositoryName);
  }

  /** @return a copy carrying the written repository name (see repositoryName). */
  public withRepositoryName(repositoryName: string): NamespaceRef {
    return new NamespaceRef(this.repository, this.name, this.fields, repositoryName);
  }

  public toString(): string {
    return [this.repositoryName, this.name].filter(part => part !== undefined && part !== "").join(":");
  }

  /** Make the error for asking this reference for a package or files,
   * attributed to where it was written. */
  public refused(): Error {
    const written = this.toString();
    return new RequirementResolutionError(
      [this],
      new FabrError(`'${written}' names a repository, not a package or files`).withHelp(
        `name what you want from it, as in '${written}${this.name === "" ? ":" : "/"}<name>'`
      )
    );
  }

  /** `name` as a name of the repository: gone on from this namespace. */
  private within(name: Name): Name {
    return this.name === "" ? name : name.withPrefix(`${this.name}/`);
  }

  protected withFields(fields: ReferenceFields): this {
    return new NamespaceRef(this.repository, this.name, fields, this.repositoryName) as this;
  }
}
