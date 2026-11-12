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

import { FileSet, IFile } from "./FileSet";
import { IProvenanceStep } from "./Provenance";
import type { RepositoryPublishRef } from "./Repository";

/**
 * The artifact one `sync` member publishes, as files (npm: `<name>-<version>.tgz`
 * and `package.json`). Building or `cat`-ing it is a dry run of the publish;
 * the driver uploads it with `destination.source.publish`. The fields are not
 * cached with the files: evaluation attaches them again where the files are
 * served from the cache.
 *
 * - `destination`: the publish reference the artifact goes to (a writer, and
 *   the name and version the artifact takes there).
 * - `provides`: the token this artifact satisfies (npm: its package name),
 *   where the destination has one. Several members may provide one token (a
 *   package at two major versions).
 * - `dependsOn`: the tokens it requires of the release's other members (npm:
 *   the names of the members its manifest depends on).
 *
 * Tokens are made by the ecosystem's writer and compared as plain strings:
 * `publishOrder` puts a member after every member providing a token it depends
 * on, across destinations, and the driver skips the members that depend on a
 * failed one.
 */
export class PublishableFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    public readonly destination: RepositoryPublishRef,
    public readonly provides?: string,
    public readonly dependsOn: ReadonlyArray<string> = [],
    origin?: IProvenanceStep
  ) {
    super(new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  public withOrigin(origin: IProvenanceStep): PublishableFileSet {
    return new PublishableFileSet(this, this.destination, this.provides, this.dependsOn, origin);
  }
}
