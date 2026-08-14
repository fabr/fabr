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
import { IProjection } from "../core/FileSetRef";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { Requirement, VersionDomain } from "./Types";

/**
 * A package as its ecosystem's manifest declares it — what
 * {@link PackageFormat.readContentPackage} reads out of package content:
 * the identity and requirements that let the content take part in version
 * selection. Purely the manifest's claims; delivering the files and wiring
 * the resolved dependencies stay the resolution machinery's business.
 */
export interface IContentPackage<V> {
  /** The name the manifest declares for itself, when it declares one — the
   * consumer decides whether it must agree with the name the content serves. */
  readonly name?: string;
  readonly version: V;
  readonly requirements: Requirement[];
}

/**
 * The written forms of one package ecosystem — how references, versions and
 * manifests read, and how a resolved package launches — with the ecosystem's
 * {@link VersionDomain} as its base: a format IS its version algebra plus the
 * reference/manifest/launch surface, so the resolution-algebra layer
 * (resolveMVS and friends), which is VersionDomain-parametric and never sees
 * manifests, takes a format directly. One shared, stateless instance per
 * ecosystem (all npm registries hold the same object): a domain borrows its
 * format from the registry serving it, and *sharing the instance* is what
 * admits two registries to one `repository_group` — the homogeneity check is
 * object identity, so a per-ecosystem format must be a shared singleton,
 * never constructed per registry (npm's spreads the SEMVER implementation:
 * `{ ...SEMVER, resolutionTag, … }`).
 */
export interface PackageFormat<V, C> extends VersionDomain<V, C> {
  /**
   * The memo tag persisted joint resolutions are keyed under (e.g.
   * `npm:resolve:18`) — bumped when the resolution computation or the document
   * shape changes behavior.
   */
  readonly resolutionTag: string;
  /**
   * Split a written reference into its identity (`name:version`, the part the
   * domain resolves) and whatever remains as a projection *into* the resolved
   * content — the split behind vendPackageRef.
   */
  splitReference(name: Name): { requirement: Name; projection?: IProjection };
  /** The requirement a reference identity declares (constraint syntax
   * validated, any override marker parsed off); throws with help attached on
   * a malformed or versionless one. */
  parseRequirement(name: Name): Requirement;
  /**
   * The name + exact version a publish coordinate assigns — the write-side
   * dual of {@link parseRequirement} (a coordinate pins an exact version where
   * a requirement declares a range). Throws, positioned in the coordinate's
   * own terms, on a malformed one — called at vend time so a bad address
   * fails fast.
   */
  parsePublishCoordinate(name: Name): { name: string; version: string };
  /**
   * Read package content as the package its manifest declares (npm: the
   * `package.json` at the fileset root) — the import half of a
   * `repository_group` content route, and deliberately ONLY the reading:
   * one pure function of the files, no registry surface. Throws (or rejects)
   * when the content carries no usable manifest, in the manifest's own terms —
   * the caller positions the error at whatever declared the content.
   */
  readContentPackage(files: FileSet): Computable<IContentPackage<V>>;
  /**
   * Make an already-resolved package launchable, keeping the exact closure it
   * carries (no re-resolution). Launching is ecosystem convention (npm: bin
   * entries under a node_modules mount), not transport — every registry of the
   * format launches a package the same way, which is why this lives here and
   * the repository faces delegate.
   */
  makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet>;
}
