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
import type { Repository } from "./Repository";

/**
 * A reference to a repository named on its own (`@npm`, `@fabr-build`): what
 * a name declared as a repository finds. It names no package and no files, so
 * a collection point refuses it. A reference into the repository is vended
 * from it ({@link Repository.getRepositoryRef}) where the name goes on
 * (`@npm:lodash:4.17.21`), and a route or a publish coordinate takes the
 * repository from it.
 */
export class NamespaceRef extends Reference {
  /** A repository answers no requirement on a package. */
  public readonly requiresPackage = false;

  constructor(
    /** The repository named. */
    public readonly repository: Repository,
    /** The name it is declared as. */
    public readonly name: string,
    fields: ReferenceFields = NO_REFERENCE_FIELDS
  ) {
    super(fields);
  }

  public toString(): string {
    return this.name;
  }

  /** Make the error for asking this reference for a package or files,
   * attributed to where it was written. */
  public refused(): Error {
    return new RequirementResolutionError(
      [this],
      new FabrError(`'${this.name}' names a repository, not a package or files`).withHelp(
        `name what you want from it, as in '${this.name}:<name>'`
      )
    );
  }

  protected withFields(fields: ReferenceFields): this {
    return new NamespaceRef(this.repository, this.name, fields) as this;
  }
}
