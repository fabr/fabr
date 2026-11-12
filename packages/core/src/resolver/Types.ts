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

import type { RunnableArgument, RunnableFileSet } from "../core/RunnableFileSet";
import { Computable } from "../core/Computable";
import type { FileSet } from "../core/FileSet";
import type { Package, PackageFileSet, RegistrySelection } from "../core/PackageFileSet";
import type { RefSource, RepositoryReader, RepositoryRef } from "../core/Repository";
import type { IRepositoryResolveTask } from "../support/Tasks";
import type { ITaskReport } from "../support/Execute";

/** A package's name, which a {@link Requirement} names and the resolver
 * selects one version of (besides any forks). */
export type PackageName = string;

/**
 * A selected package version, written `name@version` (`nodeId`): the key of
 * every per-version table of a resolution. A `requiredBy` holds one, or
 * {@link ROOT_REQUIRER} for a root requirement.
 */
export type NodeId = string;

/** The name a requirer knows a dependency by, and the name it is installed
 * under: the package's own name, or a requirement's
 * {@link Requirement.renameTo}. */
export type DependencyName = string;

/**
 * A requirement on a package within one repository, whose format reads
 * `versionConstraint`. A reference ({@link RepositoryRef}) is a requirement
 * addressed to a named repository.
 */
export interface Requirement {
  readonly name: PackageName;
  /** The version or range wanted, in the format's syntax. Undefined where
   * none is stated (a catalog member, an unversioned package): any version
   * then satisfies it. */
  readonly versionConstraint: string | undefined;
  /**
   * The marker written on the requirement (`@npm:pkg:2.0.0!`,
   * `@npm:pkg:1.4.2?`); `versionConstraint` holds the version without it.
   *
   * - `"force"` (`!`): every requirement on the package, from any requirer,
   *   is answered by exactly this version, as npm's `overrides` do. Those
   *   the version does not satisfy are listed in `MVSResolution.coerced`,
   *   not as violations.
   * - `"alternate"` (`?`): the version may be shipped beside others of the
   *   package in a strict collection. It demands nothing and installs
   *   nothing: it raises the lower bound of every requirement on the package
   *   that it satisfies, and supplies the selection where the package is
   *   otherwise required only without a lower bound. Written with no version
   *   (`@npm:debug?`), it permits every version and raises and supplies none.
   *   It is a root of the resolution, and part of its memo key.
   */
  readonly override?: "alternate" | "force";
  /**
   * The name the requirer knows the package by, where it differs from the
   * package's own (`@npm:typescript:6.0.3 -> typescript-6`; npm's
   * `"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"`). The package is selected and
   * installed under this name (`requiredAs`), apart from the package of its
   * own name; the registry is asked for it by `name`.
   */
  readonly renameTo?: DependencyName;
  /**
   * The variant of the selected version this requirement is for: a Maven
   * classifier and/or extension (`linux-x86_64`). The
   * package's version is selected as for any requirement on it, so all its
   * variants share one version; the variant is installed as a package named
   * `<name>/<variant>` that requires the package itself.
   */
  readonly variant?: string;
  /**
   * The packages left out of what this requirement brings in, by name, `*`
   * matching any run of characters but `/` (`org.slf4j/*`): Maven's
   * `<exclusions>`. A package so named is left out unless some path reaches
   * it without excluding it.
   */
  readonly excludes?: readonly string[];
  /**
   * Set where the consumer is to provide the package: fabr's `provided_deps`,
   * npm's `peerDependencies`. The requirement binds to whatever version the
   * resolution selects for the package, and demands its lower bound only as
   * follows:
   *
   * - `"expected"`: where nothing else selects the package once the walk is
   *   done, as npm installs a missing peer.
   * - `"optional"` (npm's `peerDependenciesMeta`): never. Nothing is installed
   *   for it; it binds only where the package is otherwise selected.
   */
  readonly provided?: "expected" | "optional";
  /**
   * Set on a BOM's dependency (Maven's `dependencyManagement`, Gradle's
   * `platform`): its lower bound is demanded only where another requirement
   * requires the package, with or without a lower bound. It is not a
   * dependency of its requirer: nothing is installed, bound or checked
   * through it.
   */
  readonly bom?: true;
}

/** The `requiredBy` of a root requirement, one passed to the resolver rather
 * than declared by a package. */
export const ROOT_REQUIRER = "(root)";

/** A requirement as provenance records it: who declared it, and its
 * constraint. */
export interface IRequirementEdge {
  requiredBy: NodeId;
  /** The version constraint the requirement states, if it states one. */
  versionConstraint: string | undefined;
}

/**
 * A package version the resolver selected.
 *
 * `selectedBy` is the requirement whose lower bound selected the version. Its
 * `requiredBy` may be a version that is not itself selected, one a higher
 * requirement displaced. `reachedVia` is the requirement through which the
 * result's walk first reached the selection; following `requiredBy` through
 * each one's `reachedVia` leads back to a root.
 */
export interface Selected<V> {
  /** The name the package is required as (`requiredAs`), and installed as:
   * a rename's name where the requirement renames it. A violation's and a
   * raise's `name` is this. */
  name: PackageName;
  /** The name the registry publishes the package under, where it is not
   * `name`: what its requirements and content are fetched by. */
  publishedName?: PackageName;
  version: V;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  /**
   * The indices, in the resolver's list of roots, of the roots that reach this
   * selection. Set by the resolver, which finds each root's binding from it;
   * not persisted. To find what a root reaches, use
   * `MVSResolution.reachable`.
   */
  reachableFrom?: number[];
  /**
   * Undefined (or 0) for a package's selection without a fork. A positive
   * number marks a fork: a further selection of the package, for requirements
   * the selection without a fork does not satisfy. Forks are numbered from 1
   * per package in ascending version order.
   */
  fork?: number;
}

/** A selected package's names, which a reference to it is written from. */
export type PackageIdentity = Pick<Selected<unknown>, "name" | "publishedName">;

/**
 * A requirement the selection does not satisfy: `requiredBy` declared
 * `versionConstraint` on `name`, and `selected` is the version it was checked
 * against (the package's selection without a fork, or the fork it binds to
 * where it has only forks).
 * The same shape lists `MVSResolution.violations`, `coerced` and `shared`.
 * Where nothing published satisfies the constraint, no fork satisfies it
 * either (`satisfiedByAnySelection` is false).
 */
export interface Violation<V> {
  name: PackageName;
  versionConstraint: string;
  requiredBy: NodeId;
  selected: V;
}

/**
 * A raised lower bound: `requiredBy` declared `versionConstraint` on `name`,
 * whose lower bound `declared` was never published, and `raised`, the lowest
 * published version satisfying it ({@link RequirementSource.lowestAvailable}),
 * was demanded instead. Listed only where `raised` is selected.
 */
export interface RaisedFloor<V> {
  name: PackageName;
  versionConstraint: string;
  declared: V;
  raised: V;
  requiredBy: NodeId;
}

/**
 * An error in one requirement of a resolution, attributed to the root through
 * which it was reached, so that a repository can report it against the
 * written references requiring that root.
 */
export interface IResolutionError {
  message: string;
  /** The package of the root through which the requirement in error was
   * reached; the requirement's own package where it is a root. */
  rootName: string;
  /** For a package required only without a lower bound: that package. A
   * consumer groups such errors by it into one. */
  name?: string;
  /** With `name`: the name the registry publishes that package under, where
   * it is required under another (see {@link Selected.publishedName}). */
  publishedName?: string;
  /** With `name`: the node that declared the requirement. */
  requiredBy?: string;
  /** For the grouped error over packages required only without a lower
   * bound: every such package. */
  floorless?: ReadonlyArray<PackageIdentity>;
  /** Remedy lines a consumer attached (a version to require), shown as the
   * diagnostic's `help`. */
  help?: string[];
}

/**
 * The versions and version constraints of one package ecosystem (semver for
 * npm, Maven's versions). `V` is its parsed version, and `C` its parsed
 * constraint, both opaque to the resolver.
 */
export interface VersionDomain<V, C> {
  /**
   * Parse a constraint as written in package metadata.
   * @throws if the constraint is malformed or uses a feature the domain does
   *   not support.
   */
  parseConstraint(text: string): C;

  /** The constraint of a requirement that states no version: every version
   * satisfies it, and it has no lower bound ({@link isFloorless}). */
  readonly unconstrained: C;

  /** Compare two versions: negative, zero or positive, in a total order. */
  compare(a: V, b: V): number;

  /** Get the lowest version the constraint admits: the version a requirement
   * with it demands. */
  minimumOf(constraint: C): V;

  /**
   * @return true if the constraint has no lower bound (its minimum is the zero
   * version), otherwise false: npm's `*`, or an upper-bound-only range such as
   * `<4.1.0`. A requirement with such a constraint demands no version; it is
   * met by whatever the other requirements select, its upper bound still
   * checked. A package required only so is an error.
   */
  isFloorless(constraint: C): boolean;

  /**
   * How a provided requirement that its package's selection does not satisfy
   * is listed: `"tolerate"` binds it anyway and lists it in
   * `MVSResolution.shared`; `"refuse"`, or undefined, lists it as a violation.
   * It never gets a fork.
   */
  readonly providedMismatch?: "tolerate" | "refuse";

  /** True where every installation holds one version of each package (a JVM
   * classpath): an unsatisfied requirement gets no fork, and stays a
   * violation. */
  readonly flat?: boolean;

  /** @return true if the version satisfies the constraint, upper bound
   * included, otherwise false. */
  satisfies(version: V, constraint: C): boolean;

  /** Write a version in its canonical form, as keys and messages show it. */
  versionToString(version: V): string;

  /** Parse a version's canonical form ({@link versionToString}), as a
   * persisted resolution holds it. Throws on anything else. */
  parseVersion(text: string): V;

  /** Get the version `text` names where it is one exact version, otherwise
   * undefined. A domain without it treats no constraint as exact. */
  exactVersion?(text: string): V | undefined;

  /** Write the constraint that admits exactly `version`. A domain without it
   * writes a version as that constraint (semver). */
  exactConstraint?(version: V): string;

  /** @return true if the version is not a prerelease, otherwise false; only
   * such versions are suggested as remedies. A domain without it treats every
   * version as stable. */
  isStable?(version: V): boolean;
}

/**
 * The registry as `resolveMVS` reads it; `RepositoryReader` extends it. The
 * requirements of a version must never change, since resolutions are cached.
 */
export interface RequirementSource<V> {
  /**
   * Get the requirements `name` at `version` declares. Rejects with a
   * VersionNotFoundError where that version was never published, and with
   * another error where the registry fails. `operation` is the
   * `BUILD_OPERATION` they are resolved for, where the format tells them apart
   * (Maven: a compile under `build`, a program or test under `run` and
   * `test`); undefined asks for every requirement.
   */
  getRequirements(name: string, version: V, operation?: string): Computable<Requirement[]>;

  /**
   * Get the lowest published version of `name` satisfying
   * `versionConstraint`, or undefined where none does. Asked where the
   * constraint's lower bound was never published. The answer can change as
   * versions are published. Without it, an unpublished lower bound fails the
   * resolution.
   */
  lowestAvailable?(name: string, versionConstraint: string): Computable<V | undefined>;
}

/**
 * A root of a {@link Resolution}: a reference, and the name its package is
 * handed back under: the package's name, or the rename the reference writes
 * (`renamedAs`). A catalog keys its members by `name` without fetching them.
 */
export interface ResolvedRoot {
  readonly reference: RepositoryRef;
  readonly name: string;
}

/**
 * A registry's batch resolved (`resolvePackages`): versions and dependencies
 * selected, nothing fetched. Only `roots` is public; `packageClosure` reads
 * the rest.
 */
export interface Resolution {
  readonly roots: ReadonlyArray<ResolvedRoot>;
}

/**
 * A registry's selection that a collection reaches already bound (a
 * catalog's), and so requires at exactly that version in its own batch for
 * that registry. `via` is what the collection reached it through: a catalog
 * member's reference, or a build whose bound requirements lead to it.
 */
export interface Pin {
  readonly selection: RegistrySelection;
  readonly via: RepositoryRef | Package;
}

/**
 * A reference a collection point resolves, and what is wanted of it:
 *
 * - `"package"`: the package, resolved with the rest of its repository's
 *   batch as the collection's own requirement: any exact version, `?` or
 *   `!` written on it is the collection's.
 * - `"carried"`: the package a build among the sources requires by it,
 *   resolved as that build's requirement; nothing written on it is the
 *   collection's.
 * - `"files"`: the files its projection selects, alone: it joins no
 *   resolution and brings none of its dependencies (`fileRequests`).
 * - `"instance"`: the package at the reference's lower bound, joining no
 *   resolution, its own requirements carried as references to the same
 *   repository for a later collection point to resolve
 *   (`instanceRequests`).
 */
export interface PackageRequest {
  readonly reference: RepositoryRef;
  readonly as: "package" | "carried" | "files" | "instance";
}

/** The consuming collection point, as resolution reads it. A TargetContext
 * is one. */
export interface ResolutionContext {
  /** The consuming target's name, or a catalog's: the subject progress
   *  reports name. */
  readonly name: string;
  /**
   * The packages a sub-target was given among its inputs, already resolved
   * by its creator. A collection here takes one of them as it stands, like
   * an instance: its requirements stay bound as its creator bound them.
   */
  readonly given?: ReadonlySet<PackageFileSet>;
  /** The `BUILD_OPERATION` this collection's requirements are resolved for:
   *  the operation of the consumer's configuration. */
  readonly operation: string;
  /** Get the global `name`'s value as text. */
  getGlobalString(name: string): Computable<string>;
  /** Get `runnable` launched through the runnable the global `interpreter`
   *  names, given `interpreterArgs` before the entry (see {@link RunnableFileSet.launchedBy}). */
  launchedBy(
    runnable: RunnableFileSet,
    interpreter: string,
    interpreterArgs?: readonly RunnableArgument[]
  ): Computable<RunnableFileSet>;
  /** Get the result of `create` from the build cache under `memo:<tag>
   *  <key>`, running it in a work directory only where it is not there. */
  memoize(tag: string, key: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet>;
  /** Run `run` as one task reported to the build's progress. */
  runTask<T>(task: IRepositoryResolveTask, run: (report: ITaskReport) => Computable<T>): Computable<T>;
}

/**
 * A collection point's sources resolved: what is asked of each reference they
 * hold or carry, and each registry's resolution of its batch, made once when
 * first wanted, fetching nothing. `resolveSources` resolves any subset of the
 * sources from it, under the same selections.
 */
export interface ResolvedCollection {
  /** The request for each reference, by reference. */
  readonly requests: ReadonlyMap<RepositoryRef, PackageRequest>;
  /** Each registry's resolution of its batch; the instances of one registry
   * in one environment share one. */
  readonly resolutions: ReadonlyMap<RefSource, () => Computable<Resolution>>;
  /**
   * The resolution the packages built in the project are bound from, and its
   * registry: that of the registry a forced (`!`) reference to a build's
   * name is addressed to, else the first registry's (each holds every build),
   * else one of the builds alone. Undefined where the sources hold or reach
   * no build.
   */
  readonly builds?: { readonly registry?: RepositoryReader<unknown, unknown>; readonly resolution: () => Computable<Resolution> };
  /** The packages built in the project that the sources hold or reach, by
   * content key: the candidates the resolutions hold beside published ones. */
  readonly locals: ReadonlyMap<string, Package>;
  /**
   * The build that answers for each name within what another collection
   * resolved (a catalog's member and what it reaches): the one the collection
   * requires outright, or the forced one where it requires several of that
   * name. A package of that name there is replaced by it.
   */
  readonly members: ReadonlyMap<string, Package>;
  /** The packages among the sources taken as they stand
   * (`instanceRequests`), which no resolution selects. */
  readonly instances: ReadonlySet<Package>;
  /** Each catalog member among the requests, by reference, resolved as its
   * catalog resolved it, made when first asked for. Undefined where the
   * member is answered by its files alone. */
  readonly resolvedMembers: Map<RepositoryRef, Computable<Package | undefined>>;
}

/** A member of a collection a repository resolved, as
 * `RepositoryCollection.member` answers it, which the collection point that
 * asked takes into its own resolution (`resolveMember`). */
export interface ResolvedMember {
  readonly collection: ResolvedCollection;
  /** The member, as a source of that collection. */
  readonly entry: RepositoryRef | Package;
  /** The operation of the configuration the repository was made in: what the
   * member is answered with, as for {@link RepositoryReader.operation}. */
  readonly operation: string;
}
