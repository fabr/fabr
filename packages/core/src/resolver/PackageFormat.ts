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

import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { IProjection } from "../core/Reference";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { Requirement, ResolutionContext, VersionDomain } from "./Types";

/** A package as the manifest in its content declares it
 * ({@link PackageFormat.readContentPackage}). */
export interface IContentPackage<V> {
  /** The name the manifest declares, if it declares one. It may differ from
   * the name the content is served as; the caller judges that. */
  readonly name?: string;
  readonly version: V;
  readonly requirements: Requirement[];
}

/**
 * One package ecosystem's versions ({@link VersionDomain}), and how its
 * references, publish coordinates and manifests read and its packages launch.
 *
 * Make one stateless instance per ecosystem and share it among every registry
 * of the ecosystem: a `repository_group` admits two registries only where
 * their formats are the same object.
 */
export interface PackageFormat<V, C> extends VersionDomain<V, C> {
  /** The format's name as a message shows it (`npm`, `Maven`). */
  readonly name: string;
  /** The memo tag persisted resolutions are keyed under (`npm:resolve:20`).
   * Bump it when the resolution or its document changes. */
  readonly resolutionTag: string;
  /** Split a written reference (`vendPackageRef`) into the requirement it
   * states and any projection into the package's files that follows it. */
  splitReference(name: Name): Requirement & { projection?: IProjection };
  /** Check that the format can resolve `reference`. Throws, with help
   * attached, on a malformed version, or on a reference stating no version
   * where the format requires one. */
  validateRequirement(reference: Requirement): void;
  /** Get the name and exact version a publish coordinate assigns. Throws on
   * a malformed coordinate, in the coordinate's own terms. */
  parsePublishCoordinate(name: Name): { name: string; version: string };
  /** Read the package the manifest in `files` declares (npm: the
   * `package.json` at the root), for a `repository_group` content route.
   * Throws or rejects where there is no usable manifest; the caller
   * attributes the error to what declared the content. */
  readContentPackage(files: FileSet): Computable<IContentPackage<V>>;
  /** Make a resolved package runnable with the dependencies it carries,
   * resolving nothing again (npm: its bins, over a `node_modules` tree).
   * `context` is the consumer's, whose configuration names the tools a launch
   * needs (npm: `NODE`). */
  makeRunnable(pkg: PackageFileSet, context: ResolutionContext): Computable<RunnableFileSet>;
  /**
   * Get the package URL (purl) of the package `name` at `version`, as
   * advisory databases name it (`pkg:npm/%40scope/name@1.2.3`,
   * `pkg:maven/group/artifact@1.2.3`). Absent where the ecosystem has no
   * purl type.
   */
  purl?(name: string, version: string): string;
}
