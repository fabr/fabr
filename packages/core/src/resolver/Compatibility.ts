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

/**
 * The `compatibility` reading of a registry: each reference names a runtime
 * the output must be compatible with, at its floor (`@browser:chrome:120`,
 * Chrome 120 and newer). Requirements combine by union, so of each package the
 * lowest version required is selected, and nothing is fetched.
 */

import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { Repository, RepositoryPublishRef, RepositoryReader, RepositoryRef } from "../core/Repository";
import { PackageFormat } from "./PackageFormat";
import { resolveBarePackage, vendPackageRef } from "./PackageResolver";
import { Requirement } from "./Types";

/** A constraint read for compatibility: the floor it states, or none where it states no lower bound. */
export interface CompatibilityConstraint<V> {
  readonly floor?: V;
}

/**
 * Make the compatibility reading of `format`: a constraint is its floor in
 * `format` (`minimumOf`), satisfied by that version and every older one, and
 * versions order newest first, so the highest floor in that order, which a
 * resolution selects, is the lowest version required. A constraint with no
 * floor (`*`) requires nothing. Only the floor counts: an upper bound states
 * nothing about what must be supported.
 */
export function compatibilityFormat<V, C>(format: PackageFormat<V, C>): PackageFormat<V, CompatibilityConstraint<V>> {
  const read = (constraint: C): CompatibilityConstraint<V> =>
    format.isFloorless(constraint) ? {} : { floor: format.minimumOf(constraint) };
  return {
    name: format.name,
    resolutionTag: `${format.resolutionTag}:compatibility`,
    parseConstraint: text => read(format.parseConstraint(text)),
    unconstrained: {},
    compare: (a, b) => format.compare(b, a),
    /* A floorless constraint's minimum is never read: isFloorless says it has none. */
    minimumOf: constraint => constraint.floor as V,
    isFloorless: constraint => constraint.floor === undefined,
    satisfies: (version, constraint) => constraint.floor === undefined || format.compare(version, constraint.floor) <= 0,
    versionToString: version => format.versionToString(version),
    parseVersion: text => format.parseVersion(text),
    exactVersion: format.exactVersion === undefined ? undefined : text => format.exactVersion!(text),
    exactConstraint: format.exactConstraint === undefined ? undefined : version => format.exactConstraint!(version),
    isStable: format.isStable === undefined ? undefined : version => format.isStable!(version),
    splitReference: name => format.splitReference(name),
    validateRequirement: reference => format.validateRequirement(reference),
    parsePublishCoordinate: () => {
      throw new FabrError("a compatibility reading cannot be published to");
    },
    readContentPackage: () => Computable.reject(new FabrError("content cannot be read for compatibility")),
    makeRunnable: () => Computable.reject(new FabrError("a package read for compatibility is not a program fabr can run")),
    purl: format.purl === undefined ? undefined : (name, version) => format.purl!(name, version),
  };
}

/**
 * Make the compatibility reading of `registry`, the registry a repository
 * provides under the `compatibility` operation: its packages and their
 * requirements as `registry` publishes them, resolved over
 * {@link compatibilityFormat}, apart from the registry's other readings (its
 * own identity), and fetched as packages with no files.
 */
export function compatibilityReader<V, C>(
  registry: RepositoryReader<V, C>
): RepositoryReader<V, CompatibilityConstraint<V>> & Repository {
  return new CompatibilityReader(registry);
}

class CompatibilityReader<V, C> implements RepositoryReader<V, CompatibilityConstraint<V>>, Repository {
  public readonly format: PackageFormat<V, CompatibilityConstraint<V>>;

  constructor(private readonly registry: RepositoryReader<V, C>) {
    this.format = compatibilityFormat(registry.format);
  }

  public get identity(): string {
    return `${this.registry.identity} compatibility`;
  }

  public get name(): string | undefined {
    return this.registry.name;
  }

  public get operation(): string {
    return this.registry.operation;
  }

  /** Vend the reference to the package `name` names; a reference selecting files is refused, as a package read for compatibility has none. */
  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    const ref = vendPackageRef(this, this.format, name);
    if (ref instanceof RepositoryRef && ref.projections.length > 0) {
      throw new FabrError(`'${name.toString()}' selects files, and a package read for compatibility has none`);
    }
    return ref;
  }

  public getRepositoryPublishRef(): RepositoryPublishRef {
    throw new FabrError(`${this.registry.name ?? "a registry"} cannot be published to for compatibility`);
  }

  public environmentKey(operation?: string): Computable<string> {
    return this.registry.environmentKey(operation);
  }

  public getRequirements(name: string, version: V, operation?: string): Computable<Requirement[]> {
    return this.registry.getRequirements(name, version, operation);
  }

  public availableVersions(name: string): Computable<V[] | undefined> {
    return this.registry.availableVersions?.(name) ?? Computable.resolve(undefined);
  }

  /** Find the lowest version, in this reading's order, satisfying `versionConstraint`: the newest published at or below its floor. */
  public lowestAvailable(name: string, versionConstraint: string): Computable<V | undefined> {
    let constraint: CompatibilityConstraint<V>;
    try {
      constraint = this.format.parseConstraint(versionConstraint);
    } catch {
      return Computable.resolve(undefined);
    }
    return this.availableVersions(name).then(
      versions => versions?.filter(version => this.format.satisfies(version, constraint)).sort(this.format.compare)[0]
    );
  }

  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    return Computable.resolve(undefined).then(() => resolveBarePackage(this, reference));
  }

  /** Fetch a version: a package with no files. */
  public fetch(name: string, version: V): Computable<PackageFileSet> {
    return Computable.resolve(new PackageFileSet(new Map(), name, this.format.versionToString(version)));
  }
}
