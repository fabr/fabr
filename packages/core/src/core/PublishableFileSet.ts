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
 * One member's publish carrier: a FileSet whose content IS the wire artifact
 * (npm: `{ <name>-<version>.tgz, package.json }`) — the pure, cacheable output of
 * a `sync` member's `package()`, so building/`cat`-ing it is the dry-run. It
 * carries, as runtime-only shape (reattached by evaluation on the cache-hit path,
 * never serialized — only the artifact bytes are cached): the `destination` this
 * artifact goes to (the vended publish ref — a writer plus the name it will hold
 * in that namespace), and the release-ordering edges — `provides`, the opaque
 * token this artifact satisfies (npm: its package name; several members may
 * provide one token — a package at two major lines — and a destination without
 * the concept provides none), and `dependsOn`, the tokens it requires of
 * co-members (npm: its manifest's release-member dep names). The tokens are
 * minted and matched ecosystem-side but carried as generic data: the sync rule
 * orders uploads so a member follows everything providing a token it depends
 * on — across destinations — and the driver skips the dependants of a failed
 * member. The upload itself is `destination.source.publish(this)` — the carrier
 * exists because the driver (which cannot see the ecosystem plugin) needs a
 * core-level handle to it, exactly as RunnableFileSet carries "how to launch".
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
