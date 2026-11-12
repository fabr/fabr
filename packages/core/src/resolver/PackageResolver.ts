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
import {
  FabrError,
  MetadataFetchError,
  MultiError,
  RequirementResolutionError,
  ResolutionWalkError,
  toError,
  VersionNotFoundError,
} from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { hashString } from "../core/FSWrapper";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import {
  contentOf,
  Dependency,
  dependencyName,
  isPackage,
  Package,
  PackageFileSet,
  PackageGraphBuilder,
  ResolvedNode,
  Provided,
  RegistrySelection,
} from "../core/PackageFileSet";
import { isRepositoryReader, RefSource, Repository, RepositoryReader, RepositoryRef, SourceRef } from "../core/Repository";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { TargetRef } from "../core/TargetRef";
import { PackageRequest, ResolutionContext, Resolution, ResolvedRoot, Pin } from "./Types";
import { chainSteps, IProvenanceStep, ISourcePathStep, SOURCE_PATH_PROVENANCE } from "../core/Provenance";
import type { Reference } from "../core/Reference";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { PackageFormat } from "./PackageFormat";
import { resolveMVS } from "./MVSResolver";
import { collectSanctions, satisfiedByAnySelection, writtenVersions } from "./Overrides";
import {
  allowingBuilds,
  BUILDS_ALONE,
  buildKey,
  buildReference,
  canonicalRequirements,
  constraintOf,
  isBuildVersion,
  dependencyNameOf,
  requiredAs,
  variantName,
  requirementKey,
  versionConstraintText,
  violationKey,
  violationKeys,
  exactConstraintOf,
} from "./Requirement";
import { deserializeResolutionDoc, serializeResolutionDoc, toResolutionDoc } from "./ResolutionDoc";
import { parseJson } from "../support/Json";
import { nodeId, MVSResolution } from "./MVSResolution";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./ResolutionProvenance";
import type { CheckedResolution, ResolvedBatch } from "./StrictCollection";
import { completeRepairSet, RefRenderer, SuggestSources, unrepairableError } from "./ResolutionReport";
import { IRequirementEdge, PackageIdentity, Requirement, RequirementSource, ROOT_REQUIRER, Selected, VersionDomain } from "./Types";

const RESOLUTION_FILE = "resolution.json";

/**
 * Make a {@link PackageContent.files} thunk that fetches on first demand and
 * then serves that one result to every asker. A failed fetch is made again
 * when next demanded.
 */
function fetchedOnce<T>(fetch: () => Computable<T>): () => Computable<T> {
  const held = Computable.detached(fetch);
  return () => held;
}

/**
 * Make the reference a registry vends for the written `name`, addressed to
 * `source`. `format.splitReference` splits the name into the package's
 * identity and, where text is left over, a projection into its content,
 * which the reference carries as a `find`. The result is:
 *
 * - a {@link PartialRepositoryRef}, where the name states only a package
 *   that `format` refuses without a version (`glob`), with no marker, rename
 *   or glob: a longer name completes it;
 * - otherwise a {@link RepositoryRef}, whose `override` is the name's `?` or
 *   `!` marker and whose `renameTo` is its rename.
 *
 * Throws what `format.splitReference` throws for a malformed name.
 */
export function vendPackageRef<V, C>(
  source: RefSource & Repository,
  format: PackageFormat<V, C>,
  name: Name
): RepositoryRef | PartialRepositoryRef {
  /* A `?` or `!` ending the name is a marker only where the identity runs to
   * its end; after a projection it is the last character of the pattern. A
   * rename written on the identity renames the package; one written after a
   * projection renames the files the projection selects. */
  const { projection, ...written } = format.splitReference(name);
  if (projection !== undefined) {
    return new RepositoryRef(source, written).find(projection.pattern, projection.prefix);
  }
  const override = name.getMarker();
  if (override === undefined && name.getRenameTo() === undefined && !name.hasGlob() && isIncomplete(format, written)) {
    return new PartialRepositoryRef(source, written.name);
  }
  const split = override === undefined ? written : format.splitReference(name.withoutMarker());
  const identity = override === undefined ? split : { ...split, override };
  return new RepositoryRef(source, { ...identity, renameTo: name.getRenameTo()?.toString() });
}

/** @return true if `written` states only a package name, which `format`
 *  refuses as a requirement without a version, otherwise false. A reference
 *  stating a version is complete, however malformed. */
function isIncomplete<V, C>(format: PackageFormat<V, C>, written: Requirement): boolean {
  if (written.versionConstraint !== undefined) {
    return false;
  }
  try {
    format.validateRequirement(written);
    return false;
  } catch {
    return true;
  }
}

/**
 * List a package's published `versions` as the children of its namespace (see
 * {@link Repository.children}): newest first, each mapped to the reference
 * pinning it exactly, addressed to `source`. Rejects where the registry has no
 * such package (`versions` undefined).
 */
export function versionChildren<V, C>(
  source: RefSource,
  format: PackageFormat<V, C>,
  pkg: string,
  versions: Computable<V[] | undefined>
): Computable<Map<string, Reference>> {
  return versions.then(published => {
    if (published === undefined) {
      throw new FabrError(`no package '${pkg}' is published`);
    }
    return new Map(
      [...published]
        .sort((a, b) => format.compare(b, a))
        .map((version): [string, Reference] => {
          const text = format.versionToString(version);
          return [text, new RepositoryRef(source, { name: pkg, versionConstraint: text })];
        })
    );
  });
}

/** Make the error for an override marker written on a reference that selects
 * a package's files. */
export function markerOnProjection(name: Name): Error {
  return new FabrError(`'${name.toString()}' selects files, so an override marker means nothing on it`).withHelp(
    "write the marker on a reference to the package itself (`@npm:pkg:1.2.3!`)"
  );
}

/**
 * Get the requirement a generated manifest records for a dependency on
 * `source`: what was written, never the version a resolution selected.
 *
 * - A {@link Dependency} declares what its reference states. Where that
 *   states no version (a catalog member built in the project), it takes the
 *   version of the package it is bound to. Where the reference declares
 *   nothing (a target's), it declares the bound package at its version, named
 *   as the target is and renamed to the alias the reference writes; unbound,
 *   it declares nothing.
 * - A package declares its own name and version (none for a build not yet
 *   published).
 * - A reference into a registry declares what it states, once the registry's
 *   format accepts it: rejects, with the error resolution gives, where the
 *   format refuses it (versionless or malformed).
 * - A reference into another repository declares what that repository's
 *   `declaredRequirement` answers (a catalog's member), or nothing.
 * - Anything else (plain content) declares nothing.
 *
 * A rename written on a reference is the declared requirement's `renameTo`
 * ({@link knownAs}).
 */
export function declaredRequirement(source: SourceRef | ResolvedNode | Dependency): Computable<Requirement | undefined> {
  if (isDependency(source)) {
    const { reference, package: bound } = source;
    const stated = reference instanceof RepositoryRef ? declaredRequirement(reference) : Computable.resolve(undefined);
    return stated.then(declared =>
      declared === undefined
        ? bound === undefined
          ? undefined
          : /* A build is declared by its target's name, renamed to the
             * alias the reference writes. */
            knownAs(
              { name: reference instanceof TargetRef ? reference.name : bound.packageName, versionConstraint: bound.version },
              reference instanceof TargetRef ? reference.renameTo : undefined
            )
        : declared.versionConstraint !== undefined || bound?.version === undefined
          ? declared
          : { ...declared, versionConstraint: bound.version }
    );
  }
  if (isPackage(source)) {
    return Computable.resolve({ name: source.packageName, versionConstraint: source.version });
  }
  if (!(source instanceof RepositoryRef)) {
    return Computable.resolve(undefined);
  }
  const repository = source.source;
  let declared: Computable<Requirement | undefined>;
  try {
    declared = isRepositoryReader(repository)
      ? Computable.resolve(requirementOf(repository.format, source))
      : (repository.declaredRequirement?.(source) ?? Computable.resolve(undefined));
  } catch (err) {
    return Computable.reject(toError(err));
  }
  return declared.then(requirement => (requirement === undefined ? undefined : knownAs(requirement, source.renameTo)));
}

/** @return true if `source` is a {@link Dependency}, as distinct from a
 * package or a reference, otherwise false. */
function isDependency(source: SourceRef | ResolvedNode | Dependency): source is Dependency {
  return !isPackage(source) && !(source instanceof RepositoryRef) && "reference" in source && !("find" in source);
}

/**
 * Get the version or range `reference` asks for, as written: what a
 * dependency asks for, as distinct from the version it is bound to.
 * Undefined where it states no version or names a build (which the
 * dependency's own name then shows).
 */
export function requestedConstraint(reference: Reference | undefined): string | undefined {
  const constraint = reference instanceof RepositoryRef ? reference.versionConstraint : undefined;
  return constraint === undefined || isBuildVersion(constraint) ? undefined : constraint;
}

/**
 * Rename a declared requirement to `name` — the local name its requirer
 * imports it under, recorded as {@link Requirement.renameTo} so a generated
 * manifest can state it (npm: `"typescript-6": "npm:typescript@6.0.0-beta"`).
 * A name matching the package's own renames nothing, and neither does none.
 */
export function knownAs(requirement: Requirement, name: string | undefined): Requirement {
  return name === undefined || name === requirement.name ? requirement : { ...requirement, renameTo: name };
}

/**
 * Make the resolved `pkg` runnable for `context`, by the format of `source`,
 * the registry it came from (for a catalog's member, the member's own
 * source). The closure `pkg` carries is kept as it is. Rejects where
 * `source` is not a registry.
 */
export function runnableFrom(context: ResolutionContext, source: RefSource, pkg: PackageFileSet): Computable<RunnableFileSet> {
  if (isRepositoryReader(source)) {
    return source.format.makeRunnable(pkg, context);
  }
  return Computable.reject(new FabrError(`'${pkg.packageName}' was delivered by a repository that cannot make it runnable`));
}

/**
 * The {@link Resolution} of one registry's batch, or of builds alone: the
 * loaded {@link MVSResolution}, with what the batch's requests add to it (how
 * its roots index the resolution, the versions they sanction, the builds
 * among its candidates, and its pins) and what every collection point it
 * answers shares: its {@link ResolutionGraph} of nodes and the selection each
 * build is, each made when first read.
 */
class DomainResolution<V, C> implements Resolution {
  private madeNodes: ResolutionGraph<V, C> | undefined;
  private madeBuildSelections: ReadonlyMap<string, Selected<V | string>> | undefined;
  /** Each answer {@link packageClosure} has given, by the requests it answered. */
  public readonly closures = new Map<string, Computable<(Package | undefined)[]>>();

  constructor(
    /** The registry resolved against; none for builds resolved alone. */
    public readonly registry: RepositoryReader<V, C> | undefined,
    public readonly roots: ResolvedRoot[],
    /** Each root's index among the resolution's roots, by its requirementKey. */
    public readonly rootIndex: ReadonlyMap<string, number>,
    /** The loaded resolution, with builds among its candidates. */
    public readonly graph: MVSResolution<V | string>,
    /**
     * The versions the collection's own references write, by package: each
     * `?` version and each exact version. The strict check judges every
     * answer taken from the resolution against all of them, whichever
     * requests it answers. Not part of the persisted resolution.
     */
    public readonly written: ReadonlyMap<string, ReadonlySet<string>>,
    /** The packages a `?` stating no version sanctions at every version:
     * judged as {@link written} is. */
    public readonly everyVersion: ReadonlySet<string>,
    /** The packages built in the project that are candidates of the resolution. */
    public readonly builds: Builds,
    /** The collection's reference whose root binding each selection is, by
     * node id: the first, where several are bound to one. */
    public readonly rootReferences: ReadonlyMap<string, RepositoryRef>,
    /** The requirement each request was read as, by its reference; one not
     * read yet is read on demand. A reference is requested one way. */
    private readonly requested: Map<RepositoryRef, Requirement>,
    /** The selections the collection took as they stand, each an exact root
     * of the resolution; see {@link resolvePackages}. */
    public readonly pins: ReadonlyArray<Pin>
  ) {}

  /** The resolution's graph of nodes, made when first read. Throws for builds
   * resolved alone. */
  public get nodes(): ResolutionGraph<V, C> {
    if (this.registry === undefined) {
      throw new FabrError("internal: builds resolved alone have no nodes to deliver");
    }
    return (this.madeNodes ??= new ResolutionGraph(this.registry, this));
  }

  /** The selection each build of the resolution is, by its content key. */
  public get buildSelections(): ReadonlyMap<string, Selected<V | string>> {
    return (this.madeBuildSelections ??= new Map(
      [...this.builds.built].flatMap(([id, node]) => {
        const selection = this.graph.node(id);
        return selection === undefined ? [] : [[contentOf(node.pkg).key, selection] as const];
      })
    ));
  }

  /**
   * Read each of `requests` as the requirement it is: the collection's own as
   * written, a build's carried reference as that build requires it. Throws a
   * {@link RequirementResolutionError} for a reference the registry's format
   * refuses.
   */
  public requirementsOf(requests: ReadonlyArray<PackageRequest>): Requirement[] {
    return requests.map(request => {
      let held = this.requested.get(request.reference);
      if (held === undefined) {
        if (this.registry === undefined) {
          throw new FabrError(`internal: '${request.reference.toString()}' was asked of builds resolved alone`);
        }
        held = requestedRequirement(this.registry.format, request, this.builds);
        this.requested.set(request.reference, held);
      }
      return held;
    });
  }
}

/** A package built in the project, as a candidate of a resolution, with
 * the requirements read off the package itself ({@link buildsOf}). */
interface BuiltNode {
  readonly pkg: Package;
  /** Its build key ({@link buildKey}), its version among builds. */
  readonly build: string;
  readonly requirements: Requirement[];
}

/** The requirement one of the references a build carries makes, from the build's node. */
interface CarriedEdge {
  /** The node id of the package carrying the reference. */
  readonly from: string;
  /** The name it is required under. */
  readonly name: string;
  readonly requirement: Requirement;
}

/** The packages built in the project, as candidates of one resolution. */
class Builds {
  /** Each, by its key. */
  public readonly byBuild: ReadonlyMap<string, BuiltNode>;
  /** The root each of the collection's own builds makes, by its key: the
   * first, where two of `roots` name one. */
  public readonly rootsByBuild: ReadonlyMap<string, Requirement>;
  /** The reference each build carries under each name: node id → name → reference. */
  public readonly carriedFrom: ReadonlyMap<string, ReadonlyMap<string, RepositoryRef>>;

  constructor(
    /** Each, by node id. */
    public readonly built: ReadonlyMap<string, BuiltNode>,
    /** The requirement each reference a build carries makes, from the
     * build's node. Such a reference is no root. */
    public readonly carried: ReadonlyMap<RepositoryRef, CarriedEdge>,
    /** The roots the collection's own builds make, each naming its build, with
     * the marker its reference was written with. */
    public readonly roots: ReadonlyArray<Requirement>
  ) {
    this.byBuild = new Map([...built.values()].map(node => [node.build, node]));
    const rootsByBuild = new Map<string, Requirement>();
    for (const root of roots) {
      if (root.versionConstraint !== undefined && !rootsByBuild.has(root.versionConstraint)) {
        rootsByBuild.set(root.versionConstraint, root);
      }
    }
    this.rootsByBuild = rootsByBuild;
    const carriedFrom = new Map<string, Map<string, RepositoryRef>>();
    for (const [reference, edge] of carried) {
      const from = carriedFrom.get(edge.from) ?? new Map<string, RepositoryRef>();
      if (!from.has(edge.name)) {
        from.set(edge.name, reference);
      }
      carriedFrom.set(edge.from, from);
    }
    this.carriedFrom = carriedFrom;
  }
}

/** Get the build key of `pkg` as a candidate: its configuration and a
 * digest of its content key. */
function buildOf(pkg: Package): string {
  const content = contentOf(pkg);
  const configuration = pkg instanceof ResolvedNode ? (pkg.content.configuration ?? "") : "";
  return buildKey(configuration, hashString(content.key).slice(0, 8));
}

/** @return true if `pkg` may be a candidate of a resolution in `format`, otherwise false: a package built in the project declared in another format may not. */
function inFormat(pkg: Package, format: object): boolean {
  const declared = pkg instanceof ResolvedNode ? pkg.content.declared : undefined;
  return declared === undefined || declared === "files" || declared.format === undefined || declared.format === format;
}

/**
 * Read the packages built in the project (`locals`) as candidates of a
 * resolution of `registry`'s references, or of builds alone where `registry`
 * is undefined. Each build requires, for each of its dependencies:
 *
 * - one bound to a selection of `registry`: exactly that selection, unless
 *   it is a provided requirement, which requires nothing here;
 * - one whose reference is no repository's (a target's): the build it is
 *   bound to, named by its key (nothing for a target that builds no
 *   package);
 * - one whose reference is addressed to one of `sources` (by default
 *   `registry` alone): what the reference states, without its marker, which
 *   was the build's own collection point's. These make the result's
 *   `carried`.
 *
 * Any other dependency requires nothing here: a reference addressed
 * elsewhere, one with projections, or a `?`. `own` lists the collection's
 * own builds with the markers written on them, which make the result's
 * `roots`. Throws a {@link RequirementResolutionError} for a carried
 * reference the format refuses.
 */
function buildsOf<V, C>(
  registry: RepositoryReader<V, C> | undefined,
  locals: ReadonlyArray<Package>,
  own: ReadonlyMap<Package, Requirement["override"]>,
  sources: ReadonlySet<RefSource> = new Set(registry === undefined ? [] : [registry])
): Builds {
  const domain = registry === undefined ? BUILDS_ALONE : allowingBuilds(registry.format);
  const built = new Map<string, BuiltNode>();
  const carried = new Map<RepositoryRef, CarriedEdge>();
  for (const pkg of locals) {
    const build = buildOf(pkg);
    const id = nodeId(domain, pkg.packageName, build);
    if (built.has(id)) {
      continue;
    }
    const requirements: Requirement[] = [];
    for (const dep of pkg.dependencies) {
      const provided = pkg.provided.get(dependencyName(dep));
      const role = provided === undefined ? {} : { provided };
      const required = dep.package;
      const reference = dep.reference instanceof RepositoryRef ? dep.reference : undefined;
      const bound = required instanceof ResolvedNode ? required.content.selection : undefined;
      if (bound !== undefined && registry !== undefined && bound.registry === registry.identity) {
        /* Bound to a selection of this registry by whatever resolved the
         * package: require exactly that selection. A bound provided
         * requirement is only an offer its consumer may replace, so it
         * requires nothing. */
        if (provided === undefined) {
          requirements.push(pinRequirement({ selection: bound, via: pkg }, registry.format));
        }
      } else if (reference === undefined) {
        if (required !== undefined && !isPlainNode(required)) {
          requirements.push({ name: dependencyName(dep), versionConstraint: buildOf(required), ...role });
        }
      } else if (
        registry !== undefined &&
        sources.has(reference.source) &&
        reference.projections.length === 0 &&
        reference.override !== "alternate"
      ) {
        let stated: Requirement;
        try {
          stated = requirementOf(registry.format, reference);
        } catch (err) {
          throw new RequirementResolutionError([reference], toError(err));
        }
        const requirement: Requirement = { ...stated, override: undefined, ...role };
        requirements.push(requirement);
        carried.set(reference, { from: id, name: dependencyNameOf(requirement), requirement });
      }
    }
    built.set(id, { pkg, build, requirements });
  }
  const roots = [...own].map(([pkg, override]): Requirement => ({
    name: pkg.packageName,
    versionConstraint: buildOf(pkg),
    ...(override === undefined ? {} : { override }),
  }));
  return new Builds(built, carried, roots);
}

/** @return true if `pkg` is a target known to build no package (it holds no
 * name), otherwise false. */
export function isPlainNode(pkg: Package): boolean {
  return pkg instanceof ResolvedNode && pkg.content.plain === true;
}

/** Make a requirement source over `registry` in which each build answers
 * with its own requirements, and every other package with what it requires
 * for `operation`. */
function withBuilds<V, C>(
  registry: RepositoryReader<V, C> | undefined,
  builds: Builds,
  operation?: string
): RequirementSource<V | string> {
  const lowestAvailable = registry?.lowestAvailable?.bind(registry);
  return {
    getRequirements: (name, version) => {
      if (isBuildVersion(version)) {
        const node = builds.byBuild.get(version);
        return node === undefined
          ? Computable.reject(new FabrError(`internal: ${name} ${version} is no build of this collection`))
          : Computable.resolve(node.requirements);
      }
      return registry!.getRequirements(name, version, operation);
    },
    ...(lowestAvailable === undefined ? {} : { lowestAvailable }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Resolving one registry's batch.
 *
 * A collection point groups its references by repository and hands each
 * registry's (each {@link RepositoryReader}'s) batch to the functions below,
 * which resolve it by one minimal version selection over every root and
 * answer with the resolved nodes. They ask every question, for transitive
 * requirements too, of the one registry they were given, so a reference's
 * whole closure comes from the repository it was written against; a
 * `repository_group` routes behind its own `RepositoryReader` face.
 * ---------------------------------------------------------------------------
 */

/**
 * Read the requirement `reference` states, once `format` accepts it (throws
 * where it does not): the package, version constraint, override marker,
 * rename and variant.
 */
function requirementOf<V, C>(format: PackageFormat<V, C>, reference: Requirement): Requirement {
  format.validateRequirement(reference);
  return {
    name: reference.name,
    versionConstraint: reference.versionConstraint,
    ...(reference.override === undefined ? {} : { override: reference.override }),
    ...(reference.renameTo === undefined || reference.renameTo === reference.name ? {} : { renameTo: reference.renameTo }),
    ...(reference.variant === undefined ? {} : { variant: reference.variant }),
  };
}

/** Make the reference to `registry` that states `requirement`. */
function requirementReference<V, C>(registry: RepositoryReader<V, C>, requirement: Requirement): RepositoryRef {
  return new RepositoryRef(registry, {
    name: requirement.name,
    versionConstraint: requirement.versionConstraint,
    override: requirement.override,
    renameTo: requirement.renameTo === requirement.name ? undefined : requirement.renameTo,
    variant: requirement.variant,
  });
}

/** Make the {@link RegistrySelection} a node of `registry` is, for `selection`. */
function selectionOf<V, C>(registry: RepositoryReader<V, C>, selection: Selected<V | string>): RegistrySelection {
  const name = selection.publishedName ?? selection.name;
  return {
    registry: registry.identity,
    format: registry.format,
    name,
    ...(name === selection.name ? {} : { renameTo: selection.name }),
    version: registry.format.versionToString(selection.version as V),
  };
}

/**
 * Make the requirement a pin adds to its batch: the pinned package at exactly
 * its version, renamed as it is required.
 */
export function pinRequirement<V, C>(pin: Pin, format: PackageFormat<V, C>): Requirement {
  const { selection } = pin;
  return {
    name: selection.name,
    versionConstraint: exactConstraintOf(format, format.parseVersion(selection.version)),
    ...(selection.renameTo === undefined ? {} : { renameTo: selection.renameTo }),
  };
}

/** Make the reference to `registry` that pins `selection` exactly (a build
 * by its key): of the name it is published under, renamed to the one it is
 * required as. */
function pinnedReference<V, C>(
  registry: RepositoryReader<V, C>,
  versionToString: (version: V | string) => string,
  selection: Selected<V | string>
): RepositoryRef {
  const name = selection.publishedName ?? selection.name;
  return new RepositoryRef(registry, {
    name,
    versionConstraint: isBuildVersion(selection.version)
      ? versionToString(selection.version)
      : exactConstraintOf(registry.format, selection.version as V),
    renameTo: name === selection.name ? undefined : selection.name,
  });
}

/**
 * Read `request` as the requirement it is: the collection's own as written,
 * a build's carried reference as that build requires it. Throws a
 * {@link RequirementResolutionError} for a reference `format` refuses.
 */
function requestedRequirement<V, C>(format: PackageFormat<V, C>, request: PackageRequest, builds: Builds): Requirement {
  const edge = request.as === "package" ? undefined : builds.carried.get(request.reference);
  if (edge !== undefined) {
    return edge.requirement;
  }
  try {
    return requirementOf(format, request.reference);
  } catch (err) {
    throw new RequirementResolutionError([request.reference], toError(err));
  }
}

/**
 * Resolve `requests` to `registry` jointly, by one minimal version selection
 * over all of them, fetching no package. The packages built in the project
 * (`locals`) in `registry`'s format are candidates beside the versions the
 * registry publishes. {@link packageClosure} answers any subset of the
 * requests with their nodes from the result.
 *
 * The selection's roots are:
 *
 * - each request, with the marker written on it, except a request other
 *   than `"package"` for a reference one of `locals` carries, which is that
 *   build's requirement instead;
 * - each of `own`, naming its build exactly. One with no marker that is the
 *   collection's only direct requirement on its name is forced, so it
 *   answers every requirement on that name;
 * - each of `pins`, its package at exactly the pinned version.
 *
 * The result's `roots` list every request but a `?`, which demands nothing,
 * each named as it is installed: by its rename, else its package's name. The
 * versions the `"package"` requests write (each `?` and each exact version)
 * are kept for the strict check. The resolution is memoized in the build
 * cache ({@link getJointResolution}).
 *
 * Rejects where a reference is one the format refuses, markers contradict (a
 * package both forced and `?`, or forced at two versions), the registry fails
 * to answer, the walk reports errors, or the registry's `validateSelections`
 * refuses a selection. A failure is a {@link RequirementResolutionError}
 * naming the written references that brought it in, where they can be found.
 */
export function resolvePackages<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  requests: ReadonlyArray<PackageRequest>,
  locals: ReadonlyArray<Package> = [],
  /** Those of `locals` the collection requires itself, each with the marker
   * written on it. */
  own: ReadonlyMap<Package, Requirement["override"]> = new Map(),
  /** The instances of `registry` the requests are addressed to: one
   * registry, under configurations that resolve it alike. */
  sources: ReadonlySet<RefSource> = new Set([registry]),
  /** The selections of `registry` the collection takes as they stand (a
   * catalog's, reached through a bound dependency), each an exact root of the
   * resolution that no request wrote. */
  pins: ReadonlyArray<Pin> = []
): Computable<Resolution> {
  const { format } = registry;
  const domain = allowingBuilds(format);
  const references = requests.map(request => request.reference);
  const pinned = pins.map(pin => pinRequirement(pin, format));
  return Computable.resolve(undefined).then(() => {
    /* A package built in the project in another format is no candidate here. */
    const listed = buildsOf(
      registry,
      locals.filter(pkg => inFormat(pkg, format)),
      own,
      sources
    );
    const requested = new Map<RepositoryRef, Requirement>();
    for (const request of requests) {
      if (!requested.has(request.reference)) {
        requested.set(request.reference, requestedRequirement(format, request, listed));
      }
    }
    const requirements = requests.map(request => requested.get(request.reference)!);
    const builds = directBuilds(
      listed,
      requirements.filter((_, index) => requests[index].as === "package")
    );
    /* Collect the `?` sanctions for the strict check, refusing contradictory
     * markers, attributed to the written references that carry them. */
    const sanctions = collectSanctions(domain, [...requirements, ...builds.roots], (pkg, message): never => {
      const culpable = references.filter((_, index) => requiredAs(requirements[index]) === pkg);
      throw culpable.length > 0 ? new RequirementResolutionError(culpable, new FabrError(message)) : new FabrError(message);
    });
    /* A root is named as it is installed: by the rename its reference writes,
     * else by its package's name. Keep this in step with
     * RepositoryRef.applyTo: a catalog keys its members by these names. What
     * is resolved and fetched is the package the requirement names. A `?` is
     * no root. */
    const roots: ResolvedRoot[] = references.flatMap((reference, index) =>
      requirements[index].override === "alternate" ? [] : [{ reference, name: reference.localName }]
    );
    /* The selection's roots: the collection's own requirements, its own
     * builds and the pins, canonically ordered so that the resolution, its
     * memo key and the `reachableFrom` indices do not depend on request
     * order. A reference a build carries is that build's requirement, not a
     * root. A `?` is a root here: it can give its version to a package
     * required only without a lower bound, so it is part of the key. */
    const { roots: rootReqs, keys: rootKeys } = canonicalRequirements([
      ...requirements.filter((_, index) => requests[index].as === "package" || !builds.carried.has(references[index])),
      ...builds.roots,
      ...pinned,
    ]);
    const rootIndex = new Map<string, number>(rootKeys.map((key, index) => [key, index]));
    /* Only the collection's own requests write versions, not what a package
     * requires. The builds' roots write none (only a `?` sanctions a build),
     * so two builds of one name ship only where a marker settles them. */
    const written = writtenVersions(
      domain,
      sanctions.versions,
      requirements.filter((req, index) => requests[index].as === "package" && req.override !== "alternate")
    );
    /* A pin the collection also wrote is its requirement, named as such. */
    const writtenKeys = new Set(requirements.filter((_, index) => requests[index].as === "package").map(requirementKey));
    const pinnedKeys = new Set(pinned.map(requirementKey).filter(key => !writtenKeys.has(key)));
    return getJointResolution(context, registry, repositoryNameOf(references), rootReqs, rootKeys, builds, pinnedKeys)
      .then(graph => {
        const rootReferences = new Map<string, RepositoryRef>();
        requirements.forEach((req, index) => {
          const at = requests[index].as === "package" && req.override !== "alternate" ? rootIndex.get(requirementKey(req)) : undefined;
          const bound = at === undefined ? undefined : graph.rootBinding(at);
          if (bound !== undefined && !rootReferences.has(graph.id(bound))) {
            rootReferences.set(graph.id(bound), references[index]);
          }
        });
        return new DomainResolution(
          registry,
          roots,
          rootIndex,
          graph,
          written,
          sanctions.everyVersion,
          builds,
          rootReferences,
          requested,
          pins
        );
      })
      .catch(err => attributeResolutionFailure(err, references, requirements));
  });
}

/**
 * Resolve the packages built in the project that a collection with no
 * reference to a registry holds or reaches (`locals`, of which `own` are the
 * collection's own, with their markers), with no published version among
 * the candidates. Rejects with a ResolutionWalkError where the walk reports
 * errors, or with the error for contradictory markers.
 */
export function resolveBuilds(
  locals: ReadonlyArray<Package>,
  own: ReadonlyMap<Package, Requirement["override"]>
): Computable<Resolution> {
  const domain = BUILDS_ALONE;
  return Computable.resolve(undefined).then(() => {
    const builds = directBuilds(buildsOf(undefined, locals, own), []);
    const sanctions = collectSanctions(domain, builds.roots, (_, message): never => {
      throw new FabrError(message);
    });
    const { roots, keys } = canonicalRequirements(builds.roots);
    /* A reference to a target writes no version: only a `?` does. */
    const written = writtenVersions(domain, sanctions.versions, []);
    return resolveMVS(roots, domain, withBuilds(undefined, builds)).then(result => {
      if (result.errors.length > 0) {
        throw new ResolutionWalkError(result.errors);
      }
      return new DomainResolution<never, never>(
        undefined,
        [],
        new Map(keys.map((key, index) => [key, index])),
        result,
        written,
        sanctions.everyVersion,
        builds,
        new Map(),
        new Map(),
        []
      );
    });
  });
}

/**
 * Force each root of `builds` with no marker that is the collection's only
 * direct requirement on its name, among those roots and `direct` (the
 * collection's other direct requirements), so that it answers every
 * requirement on that name. A name written more than once, or with a
 * marker, is left as written.
 */
function directBuilds(builds: Builds, direct: ReadonlyArray<Requirement>): Builds {
  const named = new Map<string, number>();
  for (const req of [...direct, ...builds.roots]) {
    named.set(requiredAs(req), (named.get(requiredAs(req)) ?? 0) + 1);
  }
  const roots = builds.roots.map((root): Requirement =>
    root.override === undefined && named.get(requiredAs(root)) === 1 ? { ...root, override: "force" } : root
  );
  return new Builds(builds.built, builds.carried, roots);
}

/** The package a dependency is bound to, and the reference the dependency
 * then carries where binding changed it: an exact pin of the selection that
 * stands where a build was required. */
export interface Bound {
  readonly package: Package;
  readonly reference?: RepositoryRef;
}

/**
 * Get what the build `dep` is bound to in `resolution`, as one of the
 * collection's own (`requirer` undefined) or as a dependency of the build
 * `requirer`. That is `dep` itself, unless a `!` gave its name to another
 * candidate: another build, as it stands, or a version `registry` publishes,
 * as its node with the reference pinning it exactly. Where the resolution
 * binds nothing for it, it is `dep`.
 */
export function bindBuild<V, C>(
  registry: RepositoryReader<V, C> | undefined,
  resolution: Resolution,
  requirer: Package | undefined,
  dep: Package
): Bound {
  const resolved = resolution as DomainResolution<V, C>;
  const { rootIndex, graph, builds } = resolved;
  const domain = (registry === undefined ? BUILDS_ALONE : allowingBuilds(registry.format)) as VersionDomain<V | string, C | string>;
  const build = buildOf(dep);
  let bound: Selected<V | string> | undefined;
  let req: Requirement | undefined;
  if (requirer === undefined) {
    req = builds.rootsByBuild.get(build);
    const index = req === undefined ? undefined : rootIndex.get(requirementKey(req));
    bound = index === undefined ? undefined : graph.rootBinding(index);
  } else {
    const to = graph.edgesOf(nodeId(domain, requirer.packageName, buildOf(requirer))).get(dep.packageName);
    bound = to === undefined ? undefined : graph.node(to);
    req = { name: dep.packageName, versionConstraint: build };
  }
  if (bound === undefined || bound.version === build) {
    return { package: dep };
  }
  const version = bound.version;
  if (isBuildVersion(version)) {
    return { package: builds.byBuild.get(version)?.pkg ?? dep };
  }
  if (registry === undefined || req === undefined) {
    return { package: dep };
  }
  /* A published package stands where a build was required: the dependency
   * on it carries an exact pin of the selection. */
  return { package: resolved.nodes.node(bound), reference: pinnedReference(registry, graph.versionToString, bound) };
}

/**
 * Make the {@link CheckedResolution} the strict check of the collection that
 * asked for `batch` reads: what the collection required of it (its requests,
 * its pins, and its builds' roots where `batch.builds`), the versions it
 * wrote, and which of the resolution's selections a package is.
 */
export function checkedResolution(context: ResolutionContext, batch: ResolvedBatch): CheckedResolution {
  const { registry, requests, catalog } = batch;
  const resolved = batch.resolution as DomainResolution<unknown, unknown>;
  const { graph, written, everyVersion, builds, pins } = resolved;
  const domain = (registry === undefined ? BUILDS_ALONE : allowingBuilds(registry.format)) as VersionDomain<unknown, unknown>;
  const references = requests.map(request => request.reference);
  let asked: Requirement[] = [];
  if (registry !== undefined) {
    try {
      asked = resolved.requirementsOf(requests);
    } catch {
      /* A request its format refuses failed its resolution: nothing ships for it. */
    }
  }
  const built = resolved.buildSelections;
  const buildText: RefRenderer = (pkg, versionText, marker) => buildReference(pkg.name, versionText, marker);
  return {
    domain,
    format: registry === undefined ? BUILDS_ALONE : registry.format,
    graph,
    requested: [
      ...asked,
      ...(registry === undefined ? [] : pins.map(pin => pinRequirement(pin, registry.format))),
      ...(batch.builds ? builds.roots : []),
    ],
    pins,
    catalog: catalog === true,
    written,
    everyVersion,
    refText: registry === undefined ? buildText : refTextFor(references, registry),
    /* A build is a selection only where it is a candidate; a registry's
     * node is one by its id. A build that keeps a registry's version (a
     * patched package) is no selection of that registry. */
    selectionOf: pkg =>
      built.get(contentOf(pkg).key) ??
      (pkg instanceof ResolvedNode && pkg.content.builds !== undefined
        ? undefined
        : pkg.version === undefined
          ? undefined
          : graph.node(`${pkg.packageName}@${pkg.version}`)),
    buildOrigin: selection => builds.built.get(graph.id(selection))?.pkg.origin,
    sources: () =>
      registry === undefined
        ? {
            domain,
            refText: buildText,
            availableVersions: () => Computable.resolve(undefined),
            resolve: () => Computable.reject(new FabrError("internal: builds alone are not resolved again")),
          }
        : (suggestSourcesFor(context, registry, repositoryNameOf(references), builds) as SuggestSources<unknown, unknown>),
  };
}

/**
 * Answer `requests`, any subset of those `resolution` was made for, with
 * their nodes in the resolution's {@link ResolutionGraph}, fetching nothing.
 * Each answer, aligned with its request, is:
 *
 * - the node of the selection the request is bound to: for a root, the
 *   binding the resolution made for it; for a reference a build carries, the
 *   binding of that build's requirement. A request naming a variant is
 *   answered with the variant's node;
 * - a build, as it stands, where the request is bound to one;
 * - undefined for a `?`, and for a provided requirement or a build's carried
 *   reference that the resolution selected nothing for.
 *
 * A node's files are fetched when it is materialized. The answer to a list of
 * requests asked again is the one given the first time.
 *
 * Rejects, in every mode, where a requirement in scope is unsatisfied and no
 * selection of its package satisfies it ({@link unrepairableError}). In scope
 * are the requested roots, the requested references builds carry, and the
 * requirements of every node the answers reach; a requirement a `!`
 * overrides and a raised lower bound are not judged. Whether answers with
 * forks are acceptable is the strict check's question. Rejects too where a
 * reference is one the format refuses. A failure is attributed to the
 * written references as {@link resolvePackages}' are.
 */
export function packageClosure<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  requests: ReadonlyArray<PackageRequest>,
  resolution: Resolution
): Computable<(Package | undefined)[]> {
  const { format } = registry;
  const domain = allowingBuilds(format);
  const references = requests.map(request => request.reference);
  const resolved = resolution as DomainResolution<V, C>;
  const { rootIndex, graph, builds } = resolved;
  const { built, carried } = builds;
  /* A reference a build carries was resolved as that build's requirement;
   * any other is a root. */
  const edgeOf = (index: number): CarriedEdge | undefined =>
    requests[index].as === "package" ? undefined : carried.get(references[index]);
  let requirements: Requirement[];
  try {
    requirements = resolved.requirementsOf(requests);
  } catch (err) {
    return Computable.reject(toError(err));
  }
  /* Memoized on the resolution by the requirements asked, as asked, so a list
   * asked again (a build's carried references, asked by each of its
   * consumers) is answered from the first time. Each asker attributes a
   * failure to its own written references. */
  const key = requirements.map((req, index) => `${requests[index].as}\0${requirementKey(req)}`).join("\n");
  const answered = resolved.closures.get(key) ?? closureOf();
  resolved.closures.set(key, answered);
  return answered.catch(err => attributeResolutionFailure(err, references, requirements));

  function closureOf(): Computable<(Package | undefined)[]> {
    /* A `?` demands nothing and is answered with nothing: the fork it
     * sanctions is reached within another answer's closure. */
    const rooted = requirements.filter((req, index) => edgeOf(index) === undefined && req.override !== "alternate");
    const requested = requirements.filter(req => req.override !== "alternate");
    const violable = violationKeys(rooted);
    /* The selection each requirement is bound to, as the resolution bound it:
     * for a root, among the selections that root reaches (so another root's
     * fork never answers it); for a build's carried reference, the binding of
     * the build's requirement. */
    const bindings = requirements.map((req, index): Selected<V | string> | undefined => {
      const edge = edgeOf(index);
      if (edge !== undefined) {
        const to = graph.edgesOf(edge.from).get(edge.name);
        return to === undefined ? undefined : graph.node(to);
      }
      return req.override === "alternate" ? undefined : graph.rootBinding(rootIndex.get(requirementKey(req))!);
    });
    /* The selections reachable from the answers, over the resolution's own
     * bindings. A fork is reached only through an unsatisfied requirement
     * bound to it. */
    const seeds = new Set(bindings.filter((sel): sel is Selected<V | string> => sel !== undefined).map(sel => graph.id(sel)));
    const reachableIds = graph.reachable(seeds);
    /* The unsatisfied requirements in scope: a requirement is in scope where
     * its requirer is a requested root or a node reached. Raised lower bounds
     * and requirements a `!` overrides (`coerced`) are not judged. */
    const scopedViolations = [
      /* A violation carries no marker, so its key matches only a requested
       * root with none: a forced root's shows in `coerced`, and a `?`
       * demands nothing. */
      ...graph.violationsOf(ROOT_REQUIRER).filter(violation => violable.has(violationKey(violation))),
      /* A build's requirement, where its carried reference is requested. */
      ...requirements.flatMap((req, index) => {
        const edge = edgeOf(index);
        const own = edge && violationKeys([req]);
        return edge === undefined ? [] : graph.violationsOf(edge.from).filter(violation => own!.has(violationKey(violation)));
      }),
      ...[...reachableIds].flatMap(id => graph.violationsOf(id)),
    ];
    const root = [...new Set(requested.map(requirementKey))].sort().join(", ");
    const refText = refTextFor(references, registry);
    /* Judged from the resolution alone, before anything is fetched. Return a
     * rejection, never throw: this may run synchronously, outside any chain
     * that would capture a throw. */
    const judgeRepairs = (): Computable<void> => {
      /* Only the selections of the unsatisfied requirement's package can
       * satisfy it. */
      const unrepaired = scopedViolations.filter(
        violation => !satisfiedByAnySelection(domain, graph.selectionsOf(violation.name), violation)
      );
      return unrepaired.length > 0
        ? Computable.reject(unrepairableError(root, unrepaired, graph, refText))
        : Computable.resolve(undefined);
    };
    return judgeRepairs().then(() => {
      return requirements.map((req, index) => {
        if (req.override === "alternate") {
          return undefined;
        }
        const bound = bindings[index];
        if (!bound && (req.provided !== undefined || edgeOf(index) !== undefined)) {
          /* Nothing this resolution selects answers it. */
          return undefined;
        }
        if (!bound) {
          /* Can't happen: a root is always bound to a selection. */
          throw new FabrError(`Resolution of ${requirementKey(req)} does not contain its own root package`);
        }
        /* The one node the selection is, whichever request reached it: a
         * build as it stands (the collection point merges it into its own
         * graph), or the registry's node. */
        return (
          built.get(graph.id(bound))?.pkg ??
          (req.variant === undefined ? resolved.nodes.node(bound) : resolved.nodes.variantNode(bound, req.variant))
        );
      });
    });
  }
}

/** Make the renderer of a reference into `registry` as the user would write
 * it, for suggestions: under the repository name `references` were written
 * against, else the registry's identity (its url). */
function refTextFor(references: RepositoryRef[], registry: { identity: string }): RefRenderer {
  const name = repositoryNameOf(references) ?? registry.identity;
  return (pkg, versionText, marker) => writtenReference(name, pkg, versionText, marker);
}

/** Write a selected package at a version as a reference to it would be
 * written against the repository named `repository`, renamed where it is. */
function writtenReference(repository: string, pkg: PackageIdentity, versionText: string, marker?: "?" | "!"): string {
  if (isBuildVersion(versionText)) {
    return buildReference(pkg.name, versionText, marker);
  }
  const written = `${repository}:${pkg.publishedName ?? pkg.name}:${versionText}${marker ?? ""}`;
  return pkg.publishedName === undefined ? written : `${written} -> ${pkg.name}`;
}

/** Find the repository name the batch's references were written against:
 * the first one that carries one (they share a source). */
function repositoryNameOf(references: RepositoryRef[]): string | undefined {
  return references.find(reference => reference.repositoryName !== undefined)?.repositoryName;
}

/**
 * Rethrow a batch's resolution failure as a {@link RequirementResolutionError}
 * naming the written references whose requirements brought it in, matched by
 * the root package each failure names: a MetadataFetchError's, or each
 * failure of a ResolutionWalkError's (rethrown as a MultiError of them, or
 * the one). A failure no written reference matches, and any other error, is
 * rethrown as it is.
 */
function attributeResolutionFailure(err: unknown, references: RepositoryRef[], requirements: Requirement[]): never {
  const culpableFor = (rootPkg: string): RepositoryRef[] =>
    references.filter((_, index) => requiredAs(requirements[index]) === rootPkg);
  if (err instanceof MetadataFetchError) {
    const culpable = culpableFor(err.rootName);
    if (culpable.length > 0) {
      throw new RequirementResolutionError(culpable, err);
    }
  }
  if (err instanceof ResolutionWalkError) {
    /* Attribute each walk failure on its own: they may sit under different
     * roots. Each keeps its suggested remedy as its help. */
    throw MultiError.of(
      err.failures.map(failure => {
        const culpable = culpableFor(failure.rootName);
        const cause = new ResolutionWalkError([failure]).withHelp(failure.help ?? []);
        return culpable.length > 0 ? new RequirementResolutionError(culpable, cause) : cause;
      })
    );
  }
  throw toError(err);
}

/**
 * The nodes of one resolution: one {@link ResolvedNode} per selection, made
 * the first time something reaches it, with every dependency the selection
 * has bound to the node the resolution binds it to (`MVSResolution.edgesOf`).
 * A node's files are fetched once, when first demanded. It decides no layout:
 * the consumer's assembler does.
 *
 * A node's provenance is the reference that reached it, with that
 * reference's steps: the collection's reference bound to it as a root, else
 * the root or the build's carried reference its `reachedVia` chain leads back
 * to. A dependency on a build holds the build as it stands; the collection
 * point merges it into its own graph. The graph may be cyclic, so each walk
 * wires through a {@link PackageGraphBuilder}, every node held before its
 * dependencies are wired. A renamed package is a selection of its own, under
 * the name it is installed as.
 */
class ResolutionGraph<V, C> {
  private readonly nodes = new Map<string, ResolvedNode>();

  constructor(
    private readonly registry: RepositoryReader<V, C>,
    private readonly resolution: DomainResolution<V, C>
  ) {}

  /** Get the node of `selection`, made with everything it reaches the first
   * time it is asked for. */
  public node(selection: Selected<V | string>): ResolvedNode {
    const { graph } = this.resolution;
    const id = graph.id(selection);
    const held = this.nodes.get(id);
    if (held !== undefined) {
      return held;
    }
    const builder = new PackageGraphBuilder();
    const pending: Array<[string, ResolvedNode]> = [];
    const made = this.instance(id, builder, pending);
    while (pending.length > 0) {
      const [at, node] = pending.pop()!;
      this.wire(at, node, builder, pending);
    }
    builder.seal();
    return made;
  }

  /** Make the node of `id`, or get the one already made; a new one is queued
   * in `pending` for its dependencies to be wired. */
  private instance(id: string, builder: PackageGraphBuilder, pending: Array<[string, ResolvedNode]>): ResolvedNode {
    let node = this.nodes.get(id);
    if (node === undefined) {
      const { registry } = this;
      const selected = this.resolution.graph.node(id)!;
      const version = selected.version as V;
      /* Named as it is installed, which for a renamed package is not the name
       * its content is fetched under. */
      const reference = this.resolution.rootReferences.get(id);
      const published = selected.publishedName ?? selected.name;
      node = builder.resolved(
        {
          key: `${registry.identity} ${id}`,
          selection: selectionOf(registry, selected),
          files: fetchedOnce(() =>
            registry
              .fetch(published, version)
              .then(pkg => (pkg.packageName === selected.name ? pkg : pkg.withPackageName(selected.name)))
          ),
          ...(registry.getVersionMetadata === undefined ? {} : { metadata: () => registry.getVersionMetadata!(published, version) }),
        },
        selected.name,
        registry.format.versionToString(version),
        namedFrom(
          registry,
          selected.publishedName ?? selected.name,
          version,
          reference === undefined ? this.originOf(selected) : this.rootOrigin(reference)
        )
      );
      this.nodes.set(id, node);
      pending.push([id, node]);
    }
    return node;
  }

  /**
   * Get the node of the variant `variant` of `selection`: the version's
   * variant, requiring the version's own node, made the first time it is
   * asked for.
   */
  public variantNode(selection: Selected<V | string>, variant: string): ResolvedNode {
    const id = this.resolution.graph.id(selection);
    const held = this.nodes.get(variantName(id, variant));
    if (held !== undefined) {
      return held;
    }
    const base = this.node(selection);
    const builder = new PackageGraphBuilder();
    const made = this.variantInstance(id, variant, base, builder);
    builder.seal();
    return made;
  }

  /** Make the node of the variant `variant` of `id`, whose own node is `base`, or get the one already made. */
  private variantInstance(id: string, variant: string, base: ResolvedNode, builder: PackageGraphBuilder): ResolvedNode {
    const key = variantName(id, variant);
    let node = this.nodes.get(key);
    if (node === undefined) {
      const { registry } = this;
      const { graph } = this.resolution;
      const selected = graph.node(id)!;
      const version = selected.version as V;
      const name = variantName(selected.name, variant);
      const versionText = registry.format.versionToString(version);
      node = builder.resolved(
        {
          key: `${registry.identity} ${key}`,
          /* A variant is of its package's one selection. */
          selection: selectionOf(registry, selected),
          files: fetchedOnce(() =>
            fetchVariantOf(registry, selected.publishedName ?? selected.name, version, variant).then(
              files => new PackageFileSet(files, name, versionText)
            )
          ),
        },
        name,
        versionText,
        base.origin
      );
      builder.wire(node, [{ reference: pinnedReference(registry, graph.versionToString, selected), package: base }], new Map());
      this.nodes.set(key, node);
    }
    return node;
  }

  /** Wire `node`'s dependencies, each to the node this resolution binds it
   * to; one bound to a build holds the build as it stands. One bound to no
   * selection in the result (an optional dependency left out of the walk)
   * is left out, unless it is a provided requirement, which is kept as a
   * reference for its consumer to bind: an exact pin of what this resolution
   * selected for it, else what the package declared. An optional provided
   * requirement is never wired to a published selection. */
  private wire(id: string, node: ResolvedNode, builder: PackageGraphBuilder, pending: Array<[string, ResolvedNode]>): void {
    const { registry } = this;
    const { graph, builds } = this.resolution;
    const published = (toId: string): boolean => graph.node(toId) !== undefined && !builds.built.has(toId);
    const edges = graph.edgesOf(id);
    const providedNames = graph.providedNames(id);
    const optional = graph.optionalProvidedNames(id);
    /* The node's requirement under each name, and that requirement as a
     * reference to this registry. */
    const declaredAs = (name: string): Requirement | undefined =>
      graph.requirements.get(id)?.find(req => dependencyNameOf(req) === name);
    const asked = (name: string): RepositoryRef =>
      requirementReference(registry, declaredAs(name) ?? { name, versionConstraint: undefined });
    /* The reference a provided requirement is offered: an exact pin of the
     * selection this resolution bound it to, else what the node declared. */
    const offered = (name: string, toId: string | undefined): RepositoryRef => {
      const selected = toId === undefined ? undefined : graph.node(toId);
      if (selected !== undefined) {
        return pinnedReference(registry, graph.versionToString, selected);
      }
      const declared = graph.requirements.get(id)?.find(req => req.provided !== undefined && requiredAs(req) === name);
      return requirementReference(registry, declared ?? { name, versionConstraint: undefined });
    };
    const dependencies = [...new Set([...edges.keys(), ...[...providedNames].sort()])].flatMap((name): Dependency[] => {
      const toId = edges.get(name);
      if (optional?.has(name) !== true && toId !== undefined && published(toId)) {
        const variant = declaredAs(name)?.variant;
        const target = this.instance(toId, builder, pending);
        return [
          { reference: asked(name), package: variant === undefined ? target : this.variantInstance(toId, variant, target, builder) },
        ];
      }
      /* A dependency bound to a build holds the build as it stands. */
      const local = toId === undefined ? undefined : builds.built.get(toId);
      if (local !== undefined) {
        return [{ reference: asked(name), package: local.pkg }];
      }
      return providedNames.has(name) ? [{ reference: offered(name, toId) }] : [];
    });
    const provided = new Map(
      [...providedNames].map((name): [string, Provided] => [name, optional?.has(name) === true ? "optional" : "expected"])
    );
    builder.wire(node, dependencies, provided);
  }

  /** Get the provenance of what `reference` resolved to: the reference, with
   * its steps. */
  private rootOrigin(reference: RepositoryRef): IProvenanceStep | undefined {
    const format = allowingBuilds(this.registry.format);
    return chainSteps(
      reference.steps,
      resolutionOrigin(
        format,
        this.registry.format,
        { name: reference.name, versionConstraint: reference.versionConstraint },
        this.resolution.graph.selections
      )
    );
  }

  /** Get the provenance of `selection`: the reference its `reachedVia` chain
   * leads back to, with that reference's steps. */
  private originOf(selection: Selected<V | string>): IProvenanceStep | undefined {
    const { graph, builds, roots } = this.resolution;
    const format = allowingBuilds(this.registry.format);
    const seen = new Set<string>();
    let at = selection;
    for (let edge = at.reachedVia; edge !== undefined && !seen.has(edge.requiredBy); edge = at.reachedVia) {
      const requirement: Requirement = { name: at.name, versionConstraint: edge.versionConstraint };
      if (edge.requiredBy === ROOT_REQUIRER) {
        const root =
          roots.find(each => each.name === at.name && each.reference.versionConstraint === edge!.versionConstraint) ??
          roots.find(each => each.name === at.name);
        return root === undefined
          ? resolutionOrigin(format, this.registry.format, requirement, graph.selections)
          : this.rootOrigin(root.reference);
      }
      const from = edge.requiredBy;
      if (builds.built.has(from)) {
        const carried = builds.carriedFrom.get(from)?.get(at.name);
        return chainSteps(carried?.steps ?? [], resolutionOrigin(format, this.registry.format, requirement, graph.selections));
      }
      seen.add(from);
      const up = graph.node(from);
      if (up === undefined) {
        break;
      }
      at = up;
    }
    return resolutionOrigin(
      format,
      this.registry.format,
      { name: at.name, versionConstraint: at.selectedBy?.versionConstraint },
      graph.selections
    );
  }
}

/** Make the provenance step of a resolved package: the root requirement, the
 * selections that explain why the package and its version are there, and the
 * registry's `format`. It names no registry: the steps before it lead to the
 * written reference. */
function resolutionOrigin<V, C>(
  domain: VersionDomain<V, C>,
  format: PackageFormat<unknown, unknown>,
  req: Requirement,
  selections: Selected<V>[]
): IResolutionOrigin<V> {
  return {
    kind: PACKAGE_RESOLUTION_PROVENANCE,
    root: req,
    selections,
    versionToString: domain.versionToString,
    format,
  };
}

/**
 * Fetch the files of the package `reference` names, at the lower bound of its
 * constraint, with no dependencies and no joint resolution: what a file
 * request asks for (the `files` operation, or a projection's files), and what
 * a registry's `fetchFiles` calls. That lower bound is the version a
 * resolution selects for the reference where nothing else requires its
 * package. A projection on the reference is not
 * applied here (RepositoryRef.applyTo applies it). The files carry the
 * provenance of that selection.
 *
 * Throws where the reference states no lower bound. Rejects where that
 * version was never published, with help naming the lowest published
 * version that satisfies the constraint, where the registry can say.
 */
export function resolveBarePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<FileSet> {
  return barePackage(registry, reference, () => Computable.resolve({ dependencies: [], provided: new Map() }));
}

/**
 * Fetch what the package `reference` names publishes for `operation` (see
 * {@link RepositoryReader.fetchFor}), at the reference's lower bound, with no
 * dependencies and no joint resolution: the files a file request under that
 * operation asks for. Rejects where the reference names a variant, or the
 * registry publishes nothing beside its packages; otherwise fails as
 * {@link resolveBarePackage} does.
 */
export function resolvePublishedFor<V, C>(
  registry: RepositoryReader<V, C>,
  reference: RepositoryRef,
  operation: string
): Computable<FileSet> {
  const { req, version, origin, unpublished } = lowerBound(registry, reference);
  if (req.variant !== undefined) {
    return Computable.reject(variantPublishesNothingFor(registry, req.name, req.variant, operation));
  }
  return publishedFor(registry, req.name, version, operation, origin).catch(unpublished);
}

/** Make the error refusing `operation` on the variant `variant` of `name`, which is published as a variant of its own where it is published at all. */
function variantPublishesNothingFor<V, C>(
  registry: RepositoryReader<V, C>,
  name: string,
  variant: string,
  operation: string
): FabrError {
  return new FabrError(
    `${registry.name ?? "its repository"} publishes nothing for '${operation}' beside the variant ${variantName(name, variant)}`
  ).withHelp(
    `name the variant of ${name} that holds what you want instead: a variant's '${operation}' is published, where it is, as a variant of its own`
  );
}

/** Fetch the content of the variant `variant` of `name` at `version`, refusing where its registry publishes no variants. */
export function fetchVariantOf<V, C>(
  registry: RepositoryReader<V, C>,
  name: string,
  version: V,
  variant: string
): Computable<FileSet> {
  if (registry.fetchVariant === undefined) {
    return Computable.reject(
      new FabrError(
        `'${variantName(name, variant)}' names a variant of ${name}, and ${registry.name ?? "its repository"} publishes none`
      )
    );
  }
  return registry.fetchVariant(name, version, variant);
}

/**
 * Fetch what `name` at `version` publishes for `operation`, refusing where its
 * registry publishes nothing beside its packages.
 */
function publishedFor<V, C>(
  registry: RepositoryReader<V, C>,
  name: string,
  version: V,
  operation: string,
  origin: IProvenanceStep | undefined
): Computable<FileSet> {
  if (registry.fetchFor === undefined) {
    return Computable.reject(publishesNothingFor(registry, name, operation));
  }
  return registry.fetchFor(name, version, operation).then(files => new FileSet(files, origin));
}

/** Make the error refusing `name` under `operation`, for a registry that publishes nothing beside its packages. */
export function publishesNothingFor<V, C>(registry: RepositoryReader<V, C>, name: string, operation: string): FabrError {
  return new FabrError(`${registry.name ?? "its repository"} publishes nothing for '${operation}' beside ${name}`);
}

/**
 * Resolve the package `reference` names as an instance: the package at the
 * reference's lower bound, carrying each requirement that version declares
 * as an unbound reference to `registry`, its provided requirements named in
 * `provided`. Nothing it requires is resolved: the collection point that
 * takes the instance resolves what it carries, as it does for a build. Its
 * files are fetched once, when first demanded.
 *
 * Throws where the reference states no lower bound. Rejects where the
 * registry fails to answer, or the version was never published (with help
 * as {@link resolveBarePackage} gives).
 */
export function instantiatePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<ResolvedNode> {
  const { format } = registry;
  const { req, version, origin, unpublished } = lowerBound(registry, reference);
  return registry
    .getRequirements(req.name, version)
    .then(requirements => {
      const dependencies = requirements.map((each): Dependency => ({ reference: requirementReference(registry, each) }));
      const provided = new Map(
        requirements.flatMap((each): Array<[string, Provided]> =>
          each.provided === undefined ? [] : [[requiredAs(each), each.provided]]
        )
      );
      const shown = format.versionToString(version);
      return new ResolvedNode(
        {
          key: `${registry.identity} ${req.name}@${shown}`,
          selection: { registry: registry.identity, format: registry.format, name: req.name, version: shown },
          files: fetchedOnce(() => registry.fetch(req.name, version).catch(unpublished)),
        },
        req.name,
        shown,
        dependencies,
        namedFrom(registry, req.name, version, origin),
        provided
      );
    })
    .catch(unpublished);
}

/** The dependencies and provided requirements a fetched package carries. */
interface DeclaredRequirements {
  readonly dependencies: ReadonlyArray<Dependency<PackageFileSet>>;
  readonly provided: ReadonlyMap<string, Provided>;
}

/** Fetch the package `reference` names at its lower bound, carrying what
 * `declared` gives for that published name and version. */
function barePackage<V, C>(
  registry: RepositoryReader<V, C>,
  reference: RepositoryRef,
  declared: (name: string, version: V) => Computable<DeclaredRequirements>
): Computable<PackageFileSet> {
  const { req, version, origin, unpublished } = lowerBound(registry, reference);
  const content: Computable<PackageFileSet> =
    req.variant === undefined
      ? registry.fetch(req.name, version)
      : fetchVariantOf(registry, req.name, version, req.variant).then(
          files => new PackageFileSet(files, variantName(req.name, req.variant!), registry.format.versionToString(version))
        );
  return Computable.forAll(
    [content, declared(req.name, version)],
    (pkg, { dependencies, provided }) => new PackageFileSet(pkg, pkg.packageName, pkg.version, dependencies, origin, provided)
  ).catch(unpublished);
}

/**
 * Find the one version `reference` names without a resolution: the lower
 * bound of its constraint. Also gives the requirement it states, the
 * provenance of that selection, and `unpublished`, a handler that rethrows a
 * failure; a VersionNotFoundError gains help naming the lowest published
 * version that satisfies the constraint, where the registry offers
 * `lowestAvailable`. Throws where the reference states no lower bound, or is
 * one the format refuses.
 */
function lowerBound<V, C>(
  registry: RepositoryReader<V, C>,
  reference: RepositoryRef
): { req: Requirement; version: V; origin: IResolutionOrigin<V>; unpublished: (err: Error) => never | Computable<never> } {
  const { format } = registry;
  const req = requirementOf(format, reference);
  const stated = req.versionConstraint;
  const constraint = constraintOf(format, stated);
  if (stated === undefined || format.isFloorless(constraint)) {
    throw new FabrError(
      `Cannot resolve the files of '${req.name}' without a version lower bound (${versionConstraintText(stated)}): ` +
        "pin a version or range to project into a package"
    );
  }
  const version = format.minimumOf(constraint);
  const edge: IRequirementEdge = { requiredBy: ROOT_REQUIRER, versionConstraint: req.versionConstraint };
  const selection: Selected<V> = {
    name: requiredAs(req),
    ...(requiredAs(req) === req.name ? {} : { publishedName: req.name }),
    version,
    selectedBy: edge,
    reachedVia: edge,
    reachableFrom: [0],
  };
  const origin = resolutionOrigin(format, format, req, [selection]);
  /* The written lower bound was never published. A joint resolution would
   * raise it; this path does not, but its error names the version a raise
   * would take. */
  const unpublished = (err: Error): never | Computable<never> => {
    if (!(err instanceof VersionNotFoundError)) {
      throw err;
    }
    const raise = registry.lowestAvailable ? registry.lowestAvailable(req.name, stated) : Computable.resolve<V | undefined>(undefined);
    return raise.then(raised => {
      throw raised
        ? err.withHelp(
            `the lowest published version satisfying '${stated}' is ${format.versionToString(raised)} — ` +
              `pin '${req.name}:${format.versionToString(raised)}' (a build resolves this automatically via a floor raise)`
          )
        : err;
    });
  };
  return { req, version, origin, unpublished };
}

/**
 * Fetch the files of the version `resolution` bound the root `reference` to,
 * with no dependencies, or, given `operation`, what that version publishes
 * for it: {@link resolveBarePackage} and {@link resolvePublishedFor} for a
 * holder of a resolution (a catalog). Throws where `reference` is no root of
 * the resolution or is bound to a build.
 */
export function fetchPinnedPackage<V, C>(
  registry: RepositoryReader<V, C>,
  reference: RepositoryRef,
  resolution: Resolution,
  operation?: string
): Computable<FileSet> {
  const { format } = registry;
  const { rootIndex, graph } = resolution as DomainResolution<V, C>;
  const req = requirementOf(format, reference);
  const index = rootIndex.get(requirementKey(req));
  const bound = index === undefined ? undefined : graph.rootBinding(index);
  if (!bound) {
    throw new FabrError(`Resolution does not contain ${requirementKey(req)}`);
  }
  const version = bound.version;
  if (isBuildVersion(version)) {
    throw new FabrError(`${requirementKey(req)} is a package built in this project, which its repository does not hold`);
  }
  const origin = resolutionOrigin(allowingBuilds(format), format, req, graph.selections);
  if (operation !== undefined) {
    return req.variant === undefined
      ? publishedFor(registry, bound.publishedName ?? bound.name, version, operation, origin)
      : Computable.reject(variantPublishesNothingFor(registry, bound.name, req.variant, operation));
  }
  if (req.variant !== undefined) {
    const name = variantName(bound.name, req.variant);
    return fetchVariantOf(registry, bound.publishedName ?? bound.name, version, req.variant).then(
      files => new PackageFileSet(files, name, format.versionToString(version), [], origin)
    );
  }
  return registry
    .fetch(bound.publishedName ?? bound.name, version)
    .then(pkg => new PackageFileSet(pkg, bound.name, pkg.version, [], origin));
}

/**
 * Make the {@link SuggestSources} the repair suggester (ResolutionReport)
 * reads for `registry`: the written form of a reference, the registry's
 * version list, and a memoized re-resolve whose errors carry no suggested
 * remedies.
 */
function suggestSourcesFor<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  repositoryName: string | undefined,
  builds: Builds
): SuggestSources<V | string, C | string> {
  return {
    domain: allowingBuilds(registry.format),
    refText: (pkg, versionText, marker) => writtenReference(repositoryName ?? registry.identity, pkg, versionText, marker),
    availableVersions: pkg => registry.availableVersions?.(pkg.publishedName ?? pkg.name) ?? Computable.resolve(undefined),
    resolve: roots =>
      getJointResolution(
        context,
        registry,
        repositoryName,
        roots,
        roots.map(req => requirementKey(req)),
        builds,
        new Set(),
        false
      ),
  };
}

/**
 * Resolve `roots` (canonically ordered, keyed by `rootKeys`) jointly against
 * `registry`, with `builds` among the candidates, memoized in the build
 * cache.
 *
 * The memo key is the registry's identity (a registry's url, a
 * `repository_group`'s whole route table), its environment key for the
 * collection's operation (npm: the target platform), the roots, and what each
 * build requires. A miss runs the resolution as a `repository-resolve` task
 * naming the consumer and the roots it wrote (all but `pinnedKeys`).
 * Unsatisfied requirements, raised lower bounds and forks are recorded in the
 * result, not refused.
 *
 * Rejects, caching nothing, where the walk reports errors (a
 * ResolutionWalkError, each failure given a suggested remedy unless `enrich`
 * is false), the registry fails to answer, or the registry's
 * `validateSelections` refuses a selection.
 */
function getJointResolution<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  repositoryName: string | undefined,
  roots: Requirement[],
  rootKeys: string[],
  builds: Builds,
  /** The keys of those of `roots` that are pins the consumer did not write:
   * in the memo key, but not named by the task. */
  pinnedKeys: ReadonlySet<string> = new Set(),
  enrich = true
): Computable<MVSResolution<V | string>> {
  const { format } = registry;
  /* The registry's versions and the builds, as candidates. */
  const domain = allowingBuilds(format);
  /* What each build requires is part of the memo key. */
  const builtKeys = [...builds.built]
    .map(([id, node]) => `built ${id}: ${node.requirements.map(requirementKey).sort().join(", ")}`)
    .sort();
  return registry.environmentKey(context.operation).then(environment => {
    return (
      context
        /* Join the roots with newlines: a version constraint may contain
         * spaces (`1.2.3 - 2.3.4`), and neither a package name nor a
         * constraint contains a newline. */
        .memoize(format.resolutionTag, `${registry.identity} ${environment}\n${[...rootKeys, ...builtKeys].join("\n")}`, () =>
          /* A miss is resolution work for the consumer: run as a task, so the
           * metadata reads it makes are shown under it. */
          context.runTask(
            {
              kind: "repository-resolve",
              repository: repositoryName ?? registry.identity,
              consumer: context.name,
              requirements: rootKeys.filter(key => !pinnedKeys.has(key)),
            },
            () =>
              resolveMVS(roots, domain, withBuilds(registry, builds, context.operation)).then(result => {
                /* Errors of the walk (an unparseable constraint, a package
                 * required only without a lower bound) are refused in every
                 * mode. Each failure keeps its root package, by which
                 * attributeResolutionFailure names the written references
                 * that brought it in, and, unless `enrich` is false, gets a
                 * suggested pin. */
                if (result.errors.length > 0) {
                  if (!enrich) {
                    throw new ResolutionWalkError(result.errors);
                  }
                  return completeRepairSet(result.errors, roots, suggestSourcesFor(context, registry, repositoryName, builds)).then(
                    failures => {
                      throw new ResolutionWalkError(failures);
                    }
                  );
                }
                return validatedResolutionDoc(registry, roots, result);
              })
          )
        )
        .then(files => files.readFile(RESOLUTION_FILE))
        .then(data => deserializeResolutionDoc(parseJson(data, `the resolution memo ${RESOLUTION_FILE}`, toResolutionDoc), domain))
    );
  });
}

/**
 * Run the registry's check of the final selections (`validateSelections`:
 * npm's platform check; a group's per route) over every published selection,
 * forks included, then serialize the resolution as its memo's files. A
 * refusal rejects, in every mode.
 */
function validatedResolutionDoc<V, C>(
  registry: RepositoryReader<V, C>,
  roots: Requirement[],
  result: MVSResolution<V | string>
): Computable<FileSet> {
  /* The registry's policy is over what it publishes. */
  const domain = allowingBuilds(registry.format);
  const published = result.selections.filter((sel): sel is Selected<V> => !isBuildVersion(sel.version));
  return (registry.validateSelections?.(published) ?? Computable.resolve(undefined)).then(() => {
    const doc = serializeResolutionDoc(roots, result, domain.versionToString);
    return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
  });
}

/** Make a request for the package `reference` names. */
export function packageRequest(reference: RepositoryRef): PackageRequest {
  return { reference, as: "package" };
}

/** Make the origin of the package `name` that `registry` publishes at
 *  `version`, made with `origin`: under a step naming it by the reference that
 *  resolves to it (`@npm:react:18.2.0`), where the registry has a name. */
function namedFrom<V, C>(
  registry: RepositoryReader<V, C>,
  name: string,
  version: V,
  origin: IProvenanceStep | undefined
): IProvenanceStep | undefined {
  const declared = registry.name;
  if (declared === undefined) {
    return origin;
  }
  const step: ISourcePathStep = {
    kind: SOURCE_PATH_PROVENANCE,
    sourcePath: `${declared}:${name}:${registry.format.versionToString(version)}`,
    parent: origin,
  };
  return step;
}
