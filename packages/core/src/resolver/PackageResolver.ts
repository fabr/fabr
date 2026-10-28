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
import { contentOf, Dependency, dependencyName, isPackage, Package, PackageFileSet, PackageGraphBuilder, ResolvedNode, Provided } from "../core/PackageFileSet";
import { isRepositoryReader, RefSource, Repository, RepositoryReader, RepositoryRef, SourceRef } from "../core/Repository";
import { NamespaceRef } from "../core/NamespaceRef";
import { TargetRef } from "../core/TargetRef";
import { PackageRequest, ResolutionContext, Resolution, ResolvedRoot } from "./Types";
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
  requiredAs,
  requirementKey,
  versionConstraintText,
  violationKey,
  violationKeys,
} from "./Requirement";
import { deserializeResolutionDoc, IResolutionDoc, serializeResolutionDoc } from "./ResolutionDoc";
import { nodeId, MVSResolution } from "./MVSResolution";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./ResolutionProvenance";
import type { CheckedResolution, ResolvedBatch } from "./StrictCollection";
import { completeRepairSet, RefRenderer, SuggestSources, unrepairableError } from "./ResolutionReport";
import { IRequirementEdge, PackageIdentity, Requirement, RequirementSource, ROOT_REQUIRER, Selected, VersionDomain } from "./Types";

const RESOLUTION_FILE = "resolution.json";

/**
 * Vend the read reference for a written package name: the format claims the
 * identity portion and anything left over rides the ref as a projection into
 * the resolved content — so the caller holds one deferred ref with nothing of
 * the name left to interpret. A `?` or `!` marker on the name is the
 * requirement's override, and is refused on a reference that selects files.
 * The repository is the ref's source: at the consumer's collection point
 * references group by that source, so everything written against one
 * repository resolves in one joint batch. A name that is not yet a complete
 * reference (`glob`, where the format's references must state a version) is
 * vended as a {@link NamespaceRef}, for the rest of the name to complete.
 */
export function vendPackageRef<V, C>(source: RefSource & Repository, format: PackageFormat<V, C>, name: Name): RepositoryRef | NamespaceRef {
  /* A `?` or `!` ending the reference is a marker only where the identity runs
   * to its end; after a projection it is the last character of the pattern. A
   * rename written on the identity is the package's; one written after a
   * projection rides the projection, and renames the files it selects. */
  const { projection, ...written } = format.splitReference(name);
  if (projection !== undefined) {
    return new RepositoryRef(source, written).find(projection.pattern, projection.prefix);
  }
  const override = name.getMarker();
  if (override === undefined && name.getRenameTo() === undefined && !name.hasGlob() && isIncomplete(format, written)) {
    return new NamespaceRef(source, written.name);
  }
  const split = override === undefined ? written : format.splitReference(name.withoutMarker());
  const identity = override === undefined ? split : { ...split, override };
  return new RepositoryRef(source, { ...identity, renameTo: name.getRenameTo()?.toString() });
}

/** @return true if `written` is not yet a complete reference, otherwise
 *  false: it states only a name, which `format` refuses as a requirement
 *  without a version. A reference stating a version is complete, and a
 *  malformed one is refused as written. */
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
 * a package's files, which are no package and have nothing to override. */
export function markerOnProjection(name: Name): Error {
  return new FabrError(`'${name.toString()}' selects files, so an override marker means nothing on it`).withHelp(
    "write the marker on a reference to the package itself (`@npm:pkg:1.2.3!`)"
  );
}

/**
 * Get the requirement that depending on `source` declares — what a generated
 * manifest records, as opposed to what a joint resolution pinned:
 *
 * - a built package is versionless until it is published, so it declares its
 *   own version, or none;
 * - a reference into a registry declares what it states, validated by the
 *   registry's format — so a versionless or malformed one rejects with the
 *   message resolution gives it;
 * - a reference into a repository with its own member table (a catalog) is
 *   answered by that repository, and one with nothing to record declares
 *   nothing;
 * - anything else — plain content, a compile input — has no package identity
 *   to record.
 *
 * A rename written on the reference is the name its requirer knows the package
 * by, and outranks what the repository says it is known as.
 */
export function declaredRequirement(source: SourceRef | ResolvedNode | Dependency): Computable<Requirement | undefined> {
  if (isDependency(source)) {
    /* An edge declares what its reference states; where that states no
     * version (a target's, a catalog member's built in the project), the
     * package it is bound to has the one it was built with. */
    const { reference, package: bound } = source;
    const stated = reference instanceof RepositoryRef ? declaredRequirement(reference) : Computable.resolve(undefined);
    return stated.then(declared =>
      declared === undefined
        ? bound === undefined
          ? undefined
          : /* A built package is named as its target is; delivered under a
             * written rename it is declared by the target's name under the
             * alias, as a registry's package is. */
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
    /* A package on its own declares itself, at the version it has. */
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

/** @return true if `source` is an edge, as distinct from a package or a
 * reference, otherwise false. */
function isDependency(source: SourceRef | ResolvedNode | Dependency): source is Dependency {
  return !isPackage(source) && !(source instanceof RepositoryRef) && "reference" in source && !("find" in source);
}

/**
 * Get the version or range `reference` asks for, as written: what an edge
 * asks for, as distinct from the version it is bound to. Undefined where it
 * states no version or names a build (which the dependency's own name then
 * shows).
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
 * Make an already-resolved package runnable for `context`'s consumer: pure
 * format convention, keyed off the registry the package came from (a catalog
 * passes its member's own source). The closure the package carries is kept —
 * never re-resolved.
 */
export function runnableFrom(context: ResolutionContext, source: RefSource, pkg: PackageFileSet): Computable<RunnableFileSet> {
  if (isRepositoryReader(source)) {
    return source.format.makeRunnable(pkg, context);
  }
  return Computable.reject(new FabrError(`'${pkg.packageName}' was delivered by a repository that cannot make it runnable`));
}

/**
 * The domain's private {@link Resolution}: how the request maps onto the
 * loaded resolution — the {@link MVSResolution} (the joint selection tree,
 * its repairs, and every index a delivery reads), plus the root bookkeeping
 * and sanctions that belong to the *request* rather than the resolution, and
 * what every collection point it answers shares: its graph of resolved nodes
 * and the selection each build is, each made the first time it is read.
 */
class DomainResolution<V, C> implements Resolution {
  private madeNodes: ResolutionGraph<V, C> | undefined;
  private madeBuildSelections: ReadonlyMap<string, Selected<V | string>> | undefined;

  constructor(
    /** The registry resolved against; none for builds resolved alone. */
    public readonly registry: RepositoryReader<V, C> | undefined,
    public readonly roots: ResolvedRoot[],
    /** requirementKey → index into the resolution's roots (the space `reachableFrom` indexes). */
    public readonly rootIndex: ReadonlyMap<string, number>,
    /** The loaded resolution itself, builds among its candidates. */
    public readonly graph: MVSResolution<V | string>,
    /**
     * The versions written as sanctioned in this collection's references — a
     * `?`, or an exact pin: pkg → versions. Every delivery cut from the
     * resolution is judged against all of them, whichever members it names.
     * Judgment-time data carried OUTSIDE the persisted doc (the resolution
     * outcome does not depend on it, so neither does the memo key).
     */
    public readonly written: ReadonlyMap<string, ReadonlySet<string>>,
    /** The packages built in the project that are candidates of the resolution. */
    public readonly builds: Builds,
    /** The reference of the collection each selection is the root binding of,
     * by node id: the first, where several bind one. */
    public readonly rootReferences: ReadonlyMap<string, RepositoryRef>,
    /** The requirement each request was read as, by its reference (a
     * reference is requested one way); one not read yet is read on demand. */
    private readonly requested: Map<RepositoryRef, Requirement>
  ) {}

  /** The graph of resolved nodes the resolution has. */
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
   * written, a built package's as that package's node states it. A reference
   * the registry's format refuses is a {@link RequirementResolutionError}.
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

/**
 * A package built in the project, as a candidate of a resolution: a package
 * like any the registry publishes, except that what it requires is read off
 * the package in hand.
 */
interface BuiltNode {
  readonly pkg: Package;
  /** Its key: its version among builds. */
  readonly build: string;
  readonly requirements: Requirement[];
}

/** The edge of a built package's node that one of its references is. */
interface CarriedEdge {
  /** The node id of the package carrying the reference. */
  readonly from: string;
  /** The name the edge is required under. */
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
    /** The edge each reference one of them carries makes from its node. Such a
     * reference is no root. */
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

/** Get the build `pkg` is, as a candidate. */
function buildOf(pkg: Package): string {
  const content = contentOf(pkg);
  const configuration = pkg instanceof ResolvedNode ? (pkg.content.configuration ?? "") : "";
  return buildKey(configuration, hashString(content.key).slice(0, 8));
}

/**
 * Read the packages built in the project as candidates for a resolution of
 * `registry`'s references, or of builds alone where `registry` is undefined.
 * Each requires the references it carries that are addressed to one of
 * `sources` (the registry's instances, by default `registry` alone), as
 * written but without their markers, which were its own collection point's.
 * It also requires each other build it depends on, naming that build exactly.
 * A reference that resolves nothing here is left out, as a collection point
 * leaves it out: one addressed elsewhere, one with projections, a `?`. So is
 * a dependency on a target that builds no package. `own` gives the roots, the
 * collection's own builds with their markers.
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
      if (reference === undefined) {
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
        carried.set(reference, { from: id, name: requiredAs(requirement), requirement });
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

/** Make `registry` a requirement source in which the builds answer for themselves. */
function withBuilds<V, C>(registry: RepositoryReader<V, C> | undefined, builds: Builds): RequirementSource<V | string> {
  const lowestAvailable = registry?.lowestAvailable?.bind(registry);
  return {
    getRequirements: (name, version) => {
      if (isBuildVersion(version)) {
        const node = builds.byBuild.get(version);
        return node === undefined
          ? Computable.reject(new FabrError(`internal: ${name} ${version} is no build of this collection`))
          : Computable.resolve(node.requirements);
      }
      return registry!.getRequirements(name, version);
    },
    ...(lowestAvailable === undefined ? {} : { lowestAvailable }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The driver of a package domain's resolution.
 *
 * A **package domain** — a namespace of package names, jointly resolved (one
 * minimal-version selection over every root at a collection point) — is what
 * these functions compute over a (declaring context, registry) pair. A
 * repository that serves packages (`npm_repository`, or a `repository_group`
 * routing to other registries) carries the {@link RepositoryReader} face, and
 * the consumer's collection point groups references by source repository and
 * hands each batch to this driver, which yields the resolved graph back to
 * it.
 *
 * The driver only ever asks per-name questions of the one registry it was
 * handed — including for every transitive requirement discovered mid-walk —
 * so the whole closure of a reference comes from the origin it was written
 * against; a group's routing is invisible here.
 * ---------------------------------------------------------------------------
 */

/**
 * Read the requirement a reference states, once its repository's format accepts
 * it: the package, the version constraint, any override marker, and the name
 * it is to be delivered under — a renamed package being one of its own.
 */
function requirementOf<V, C>(format: PackageFormat<V, C>, reference: Requirement): Requirement {
  format.validateRequirement(reference);
  return {
    name: reference.name,
    versionConstraint: reference.versionConstraint,
    ...(reference.override === undefined ? {} : { override: reference.override }),
    ...(reference.renameTo === undefined || reference.renameTo === reference.name ? {} : { renameTo: reference.renameTo }),
  };
}

/** Make the reference to `registry` that states `requirement`. */
function requirementReference<V, C>(registry: RepositoryReader<V, C>, requirement: Requirement): RepositoryRef {
  return new RepositoryRef(registry, {
    name: requirement.name,
    versionConstraint: requirement.versionConstraint,
    override: requirement.override,
    renameTo: requirement.renameTo === requirement.name ? undefined : requirement.renameTo,
  });
}

/** Make the reference to `registry` that is an exact pin of `selection`: of
 * the name it is published under, renamed to the one it is required as. */
function pinnedReference<V, C>(
  registry: RepositoryReader<V, C>,
  versionToString: (version: V | string) => string,
  selection: Selected<V | string>
): RepositoryRef {
  const name = selection.publishedName ?? selection.name;
  return new RepositoryRef(registry, {
    name,
    versionConstraint: versionToString(selection.version),
    renameTo: name === selection.name ? undefined : selection.name,
  });
}

/**
 * Read `request` as the requirement it is: the collection's own as written,
 * a built package's as that package's node states it.
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
 * Phase 1 — resolve a batch of references jointly (one minimal-version-selection
 * over all root requirements, so shared packages agree on a version and user
 * overrides dominate per max-of-minimums) WITHOUT fetching, the packages built
 * in the project among the candidates. Returns the selection tree;
 * {@link packageClosure} assembles a subset of it on demand.
 */
export function resolvePackages<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  requests: ReadonlyArray<PackageRequest>,
  locals: ReadonlyArray<Package> = [],
  /** Those of `locals` the collection requires outright, each with the marker
   * written on it. */
  own: ReadonlyMap<Package, Requirement["override"]> = new Map(),
  /** The instances of `registry` the requests are addressed to: one registry,
   * under configurations that cannot change what it resolves. */
  sources: ReadonlySet<RefSource> = new Set([registry])
): Computable<Resolution> {
  const { format } = registry;
  const domain = allowingBuilds(format);
  const references = requests.map(request => request.reference);
  /* No operation here: a resolution is a function of the requirements alone
   * (build and run share one), and what varies by operation is the SHAPE of
   * the answer, which the collection point decides from the repository's
   * `operation`. */
  return Computable.resolve(undefined).then(() => {
    const listed = buildsOf(registry, locals, own, sources);
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
    /* Alternates (`?`) are sanctions, not demands: they join neither the
     * roots (a catalog's member table must not see them) nor a delivery, and
     * ride the resolution to the strict gate. They are key material (below).
     * Contradictory markers are attributed to the written references that
     * carry them. */
    const alternates = collectSanctions(domain, [...requirements, ...builds.roots], (pkg, message): never => {
      const culpable = references.filter((_, index) => requiredAs(requirements[index]) === pkg);
      throw culpable.length > 0 ? new RequirementResolutionError(culpable, new FabrError(message)) : new FabrError(message);
    });
    /* A root is named as it is DELIVERED — the written rename when the reference
     * carries one, the resolved package name otherwise — so a caller addressing
     * the resolution's roots (a catalog keying its members) and the delivery
     * itself (RepositoryRef.applyTo) agree by construction. Only the
     * addressing name is renamed: what is resolved and fetched is the package
     * the requirement names. */
    const roots: ResolvedRoot[] = references.flatMap((reference, index) =>
      requirements[index].override === "alternate"
        ? []
        : [{ reference, name: reference.localName }]
    );
    /* The roots are the collection's own requirements: on what its references
     * name, and on the builds it holds outright, canonically ordered so the
     * resolution (and its memo key, and the reachableFrom indices) are
     * independent of reference order. What a built package carries — a
     * reference, or another build — is an edge of its node, not a root.
     * Alternates ARE included: attach-last means a `?` can supply a
     * floorless-only package's version, so it is part of the resolution's
     * identity (its key carries the marker); it still joins neither `roots`
     * above nor a delivery. */
    const { roots: rootReqs, keys: rootKeys } = canonicalRequirements([
      ...requirements.filter((_, index) => requests[index].as === "package" || !builds.carried.has(references[index])),
      ...builds.roots,
    ]);
    const rootIndex = new Map<string, number>(rootKeys.map((key, index) => [key, index]));
    /* Only the collection's own requirements are written by it: a package's
     * exact requirement is a transitive one, which vouches for nothing. A
     * reference to a target asks for its build and sanctions nothing (only a
     * `?` does), so two builds of one name ship only where a marker settles
     * them. */
    const written = writtenVersions(
      domain,
      alternates,
      requirements.filter((req, index) => requests[index].as === "package" && req.override !== "alternate")
    );
    return getJointResolution(context, registry, repositoryNameOf(references), rootReqs, rootKeys, builds)
      .then(graph => {
        const rootReferences = new Map<string, RepositoryRef>();
        requirements.forEach((req, index) => {
          const at = requests[index].as === "package" && req.override !== "alternate" ? rootIndex.get(requirementKey(req)) : undefined;
          const bound = at === undefined ? undefined : graph.rootBinding(at);
          if (bound !== undefined && !rootReferences.has(graph.id(bound))) {
            rootReferences.set(graph.id(bound), references[index]);
          }
        });
        return new DomainResolution(registry, roots, rootIndex, graph, written, builds, rootReferences, requested);
      })
      .catch(err => attributeResolutionFailure(err, references, requirements));
  });
}

/**
 * Resolve the packages built in the project that a collection holding no
 * reference to a registry holds or reaches: the builds alone, judged as any
 * candidates are, with nothing published in reach.
 */
export function resolveBuilds(
  locals: ReadonlyArray<Package>,
  own: ReadonlyMap<Package, Requirement["override"]>
): Computable<Resolution> {
  const domain = BUILDS_ALONE;
  return Computable.resolve(undefined).then(() => {
    const builds = directBuilds(buildsOf(undefined, locals, own), []);
    const alternates = collectSanctions(domain, builds.roots, (_, message): never => {
      throw new FabrError(message);
    });
    const { roots, keys } = canonicalRequirements(builds.roots);
    /* A reference to a target sanctions nothing: only the `?` alternates are written. */
    const written = writtenVersions(domain, alternates, []);
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
        builds,
        new Map(),
        new Map()
      );
    });
  });
}

/**
 * Force each unmarked root of `builds` that is the collection's only direct
 * requirement on its name, so that a build of that name another package
 * requires is answered by it. `direct` holds the collection's other direct
 * requirements. Where the name is written more than once, or with a marker,
 * what is written settles it.
 */
function directBuilds(builds: Builds, direct: ReadonlyArray<Requirement>): Builds {
  const named = new Map<string, number>();
  for (const req of [...direct, ...builds.roots]) {
    named.set(requiredAs(req), (named.get(requiredAs(req)) ?? 0) + 1);
  }
  const roots = builds.roots.map((root): Requirement => (root.override === undefined && named.get(requiredAs(root)) === 1 ? { ...root, override: "force" } : root));
  return new Builds(builds.built, builds.carried, roots);
}

/** What an edge is bound to: the package, and the reference the edge then
 * carries where binding changed it (an exact pin of the selection that stands
 * where a build was required). */
export interface Bound {
  readonly package: Package;
  readonly reference?: RepositoryRef;
}

/**
 * Get what the build `dep` is bound to in `resolution`: as one of the
 * collection's own (`requirer` undefined), or as the edge of the build
 * `requirer` that requires it. That is the build itself unless a `!` gave its
 * name to another candidate: another build, or a package `registry`
 * publishes, with its closure.
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
  /* The package stands where a build was required: the edge to it is what an
   * exact pin of the selection asks for. */
  return { package: resolved.nodes.node(bound), reference: pinnedReference(registry, graph.versionToString, bound) };
}

/**
 * Read the resolution `batch` holds as the strict check of the collection that
 * asked it reads it: what the collection required of it, and which of its
 * selections a package is.
 */
export function checkedResolution(context: ResolutionContext, batch: ResolvedBatch): CheckedResolution {
  const { registry, requests } = batch;
  const resolved = batch.resolution as DomainResolution<unknown, unknown>;
  const { graph, written, builds } = resolved;
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
    requested: [...asked, ...(batch.builds ? builds.roots : [])],
    written,
    refText: registry === undefined ? buildText : refTextFor(references, registry),
    selectionOf: pkg => built.get(contentOf(pkg).key) ?? (pkg.version === undefined ? undefined : graph.node(`${pkg.packageName}@${pkg.version}`)),
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
 * Phase 2 — answer the requested references (a subset of `resolution`) with
 * their nodes in the resolution's {@link ResolutionGraph}, nothing fetched, so
 * a subset keeps the joint pin. A requirement a build answers is that build,
 * as it stands. Each node's files are fetched when it is materialized.
 *
 * A violation nothing in the resolution satisfies has no repairing fork and
 * fails here, in EVERY mode — nothing can honor the constraint. Whether a
 * repaired graph is ACCEPTABLE is not this function's question: a strict
 * (linked) consumer is judged over everything it uses together, at its
 * collection point (StrictCollection), from what it binds and the
 * resolutions it was answered from; a permissive one (a sealed install) nests
 * the repairs privately.
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
  /* A reference a built package carries is the edge of that package's node it
   * was resolved as; any other is a root. */
  const edgeOf = (index: number): CarriedEdge | undefined => (requests[index].as === "package" ? undefined : carried.get(references[index]));
  let requirements: Requirement[];
  try {
    requirements = resolved.requirementsOf(requests);
  } catch (err) {
    return Computable.reject(toError(err));
  }
  /* An alternate (`?`) reference demands nothing and delivers nothing of its
   * own — the sanctioned fork arrives nested inside the canonical closure. */
  const rooted = requirements.filter((req, index) => edgeOf(index) === undefined && req.override !== "alternate");
  const requested = requirements.filter(req => req.override !== "alternate");
  const violable = violationKeys(rooted);
  /* What a requirement BINDS to — normally the principal, but a violated one
   * is answered by its fork. The resolution decided this when it was computed:
   * for a root scoped to what that root reaches, so another root's fork cannot
   * answer here, and for a built package's requirement as its node's edge. */
  const bindings = requirements.map((req, index): Selected<V | string> | undefined => {
    const edge = edgeOf(index);
    if (edge !== undefined) {
      const to = graph.edgesOf(edge.from).get(edge.name);
      return to === undefined ? undefined : graph.node(to);
    }
    return req.override === "alternate" ? undefined : graph.rootBinding(rootIndex.get(requirementKey(req))!);
  });
  /* The selections reachable from the requested roots.
   * Forks are reachable exactly through the violated edges bound to them,
   * so a strict subset whose closure has no violations carries no forks.
   * Walked forward over the resolution's own edges (O(the subset)). */
  const seeds = new Set(bindings.filter((sel): sel is Selected<V | string> => sel !== undefined).map(sel => graph.id(sel)));
  const reachableIds = graph.reachable(seeds);
  /* A violation is a property of an *edge*: in scope iff its requirer is in
   * the delivered closure (a root-requirement violation: iff that root is
   * among the requested). Raises are NOT judged here in any mode: a raised
   * floor is the constraint's plain meaning when its literal minimum was
   * never published — the request was for the range, and the first published
   * version meeting it answers the request. Coerced edges are not judged
   * either — suppressing them is what their `!` said to do.
   *
   * Collected by asking the delivered nodes (and the requested roots) what they
   * violated, rather than by passing over every violation the resolution
   * recorded: in scope is a property of the requirer, so an index by requirer
   * makes this proportional to the delivery too. */
  const scopedViolations = [
    /* A violation carries no marker, so its key can only match an unmarked
     * requested root — right by construction: a forced root surfaces as
     * `coerced`, and an alternate is never demanded. */
    ...graph.violationsOf(ROOT_REQUIRER).filter(violation => violable.has(violationKey(violation))),
    /* A built package's requirement: its own node's edge, where requested. */
    ...requirements.flatMap((req, index) => {
      const edge = edgeOf(index);
      const own = edge && violationKeys([req]);
      return edge === undefined ? [] : graph.violationsOf(edge.from).filter(violation => own!.has(violationKey(violation)));
    }),
    ...[...reachableIds].flatMap(id => graph.violationsOf(id)),
  ];
  const root = [...new Set(requested.map(requirementKey))].sort().join(", ");
  const refText = refTextFor(references, registry);
  /* Judged before anything is downloaded: the verdict is decided by the
   * resolution alone. Rejects rather than throws — this function may be
   * entered synchronously, outside any chain that would capture a throw. */
  const judgeRepairs = (): Computable<void> => {
    /* Only selections of the violated package can satisfy it, so the question
     * is asked of that package's candidates rather than of every selection. */
    const unrepaired = scopedViolations.filter(
      violation => !satisfiedByAnySelection(domain, graph.selectionsOf(violation.name), violation)
    );
    return unrepaired.length > 0 ? Computable.reject(unrepairableError(root, unrepaired, graph, refText)) : Computable.resolve(undefined);
  };
  return judgeRepairs()
    .then(() => {
      return requirements.map((req, index) => {
        if (req.override === "alternate") {
          return undefined;
        }
        const bound = bindings[index];
        if (!bound && (req.provided !== undefined || edgeOf(index) !== undefined)) {
          /* Nothing this resolution selects answers it: it offers nothing. */
          return undefined;
        }
        if (!bound) {
          /* Can't happen: a root requirement is always reachable from itself */
          throw new FabrError(`Resolution of ${requirementKey(req)} does not contain its own root package`);
        }
        /* The one node the selection is, whichever requirement reached it: a
         * build as it stands, which the collection point delivers in its own
         * right, or the registry's. */
        return built.get(graph.id(bound))?.pkg ?? resolved.nodes.node(bound);
      });
    })
    .catch(err => attributeResolutionFailure(err, references, requirements));
}

/** Make the renderer of the written form of a reference into this domain,
 * for pasteable suggestions — rendered with the repository name the
 * references were written against (a suggestion must read exactly as the user
 * would write it here; the registry's own identity — a url — is the fallback
 * when no reference carries one, e.g. programmatic use). */
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

/** Find the declared repository name the batch's references were written
 * against (they share a source, so the first stamped one speaks for the
 * batch). */
function repositoryNameOf(references: RepositoryRef[]): string | undefined {
  return references.find(reference => reference.repositoryName !== undefined)?.repositoryName;
}

/**
 * Attribute a batch resolution failure to the written reference(s) whose
 * requirement pulled it in, via the root package each failure names — a
 * MetadataFetchError's first-reacher chain, or each of a ResolutionWalkError's
 * per-error roots. The refs' carried provenance lets the driver point at the
 * requirement as written.
 */
function attributeResolutionFailure(err: unknown, references: RepositoryRef[], requirements: Requirement[]): never {
  const culpableFor = (rootPkg: string): RepositoryRef[] => references.filter((_, index) => requiredAs(requirements[index]) === rootPkg);
  if (err instanceof MetadataFetchError) {
    const culpable = culpableFor(err.rootName);
    if (culpable.length > 0) {
      throw new RequirementResolutionError(culpable, err);
    }
  }
  if (err instanceof ResolutionWalkError) {
    /* Each walk failure attributes independently (they may sit under
     * different roots); one without a matching written reference reports
     * plain. A failure's remedy (a pin suggestion) rides as its help.
     * MultiError unwraps a sole failure. */
    throw MultiError.of(
      err.failures.map(failure => {
        const culpable = culpableFor(failure.rootName);
        const cause = new FabrError(failure.message).withHelp(failure.help ?? []);
        return culpable.length > 0 ? new RequirementResolutionError(culpable, cause) : cause;
      })
    );
  }
  throw toError(err);
}

/**
 * A resolution's graph of resolved nodes: one node per selection, made the
 * first time something reaches it, each carrying **all** of its dependency
 * edges, bound to the node the resolution chose (`edgeBinding`'s
 * answer, read off the precomputed edge map). NO layout is decided here:
 * hoisting and private nesting are the consuming assembler's business
 * (assembleNodeModules).
 *
 * A node's provenance is the reference that reached it: the root requirement
 * its `reachedVia` chain leads back to (or the reference a build carries,
 * where the chain leads to a build), with that reference's own steps. A
 * build reached through an edge is the build in hand; the collection point
 * merges it into its own graph. The graph may be cyclic (mutual same-version
 * deps are ordinary npm), so each walk wires through a
 * {@link PackageGraphBuilder}, every node memoized before its edges are
 * wired. A renamed package is a selection of its own, under the name it is
 * installed as.
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
   * in `pending` for its edges. */
  private instance(id: string, builder: PackageGraphBuilder, pending: Array<[string, ResolvedNode]>): ResolvedNode {
    let node = this.nodes.get(id);
    if (node === undefined) {
      const { registry } = this;
      const selected = this.resolution.graph.node(id)!;
      const version = selected.version as V;
      /* Delivered under the name it is installed as, which for a renamed
       * package is not the name its content is fetched under. */
      const reference = this.resolution.rootReferences.get(id);
      node = builder.resolved(
        {
          key: `${registry.identity} ${id}`,
          files: () => registry.fetch(selected.publishedName ?? selected.name, version),
        },
        selected.name,
        registry.format.versionToString(version),
        namedFrom(registry, selected.publishedName ?? selected.name, version, reference === undefined ? this.originOf(selected) : this.rootOrigin(reference))
      );
      this.nodes.set(id, node);
      pending.push([id, node]);
    }
    return node;
  }

  /** Wire `node`'s edges: each to the node this resolution binds it to. One
   * leading to a selection outside the result (a gated optional pruned from
   * the walk) is not carried, unless it is a provided requirement, which stays
   * as a reference for its consumer to answer: to what this resolution
   * selected for it, or where it selected nothing, to what the package
   * declared. An expected provided requirement's offer is wired as the
   * default, an optional one's never. */
  private wire(id: string, node: ResolvedNode, builder: PackageGraphBuilder, pending: Array<[string, ResolvedNode]>): void {
    const { registry } = this;
    const { graph, builds } = this.resolution;
    const published = (toId: string): boolean => graph.node(toId) !== undefined && !builds.built.has(toId);
    const edges = graph.edgesOf(id);
    const providedNames = graph.providedNames(id);
    const optional = graph.optionalProvidedNames(id);
    /* What the node asked for under each name: its requirement, as a
     * reference to this registry. */
    const asked = (name: string): RepositoryRef => {
      const declared = graph.requirements.get(id)?.find(req => requiredAs(req) === name);
      return requirementReference(registry, declared ?? { name, versionConstraint: undefined });
    };
    /* What a provided requirement is offered: a pin of the selection this
     * resolution bound it to, or, where it bound none, what the node declared. */
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
        return [{ reference: asked(name), package: this.instance(toId, builder, pending) }];
      }
      /* An edge to a package built in the project holds that package as it
       * stands; the collection point merges it into its own graph. */
      const local = toId === undefined ? undefined : builds.built.get(toId);
      if (local !== undefined) {
        return [{ reference: asked(name), package: local.pkg }];
      }
      return providedNames.has(name) ? [{ reference: offered(name, toId) }] : [];
    });
    const provided = new Map([...providedNames].map((name): [string, Provided] => [name, optional?.has(name) === true ? "optional" : "expected"]));
    builder.wire(node, dependencies, provided);
  }

  /** Get the provenance of what `reference` resolved to: the reference, with
   * its steps. */
  private rootOrigin(reference: RepositoryRef): IProvenanceStep | undefined {
    const format = allowingBuilds(this.registry.format);
    return chainSteps(reference.steps, resolutionOrigin(format, { name: reference.name, versionConstraint: reference.versionConstraint }, this.resolution.graph.selections));
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
        return root === undefined ? resolutionOrigin(format, requirement, graph.selections) : this.rootOrigin(root.reference);
      }
      const from = edge.requiredBy;
      if (builds.built.has(from)) {
        const carried = builds.carriedFrom.get(from)?.get(at.name);
        return chainSteps(carried?.steps ?? [], resolutionOrigin(format, requirement, graph.selections));
      }
      seen.add(from);
      const up = graph.node(from);
      if (up === undefined) {
        break;
      }
      at = up;
    }
    return resolutionOrigin(format, { name: at.name, versionConstraint: at.selectedBy?.versionConstraint }, graph.selections);
  }
}

/** Make the provenance origin of a resolved closure: the root requirement and
 * the selections that answer "why is this package here / why this version". It
 * carries no registry identity — "who provided this" is answered by following
 * the chain to the written reference and the declaration it names. */
function resolutionOrigin<V, C>(
  format: VersionDomain<V, C>,
  req: Requirement,
  selections: Selected<V>[]
): IResolutionOrigin<V> {
  return {
    kind: PACKAGE_RESOLUTION_PROVENANCE,
    root: req,
    selections,
    versionToString: format.versionToString,
  };
}

/**
 * Resolve a package's own files, with no dependency closure and no joint
 * resolution — what a file request asks for (BUILD_OPERATION=files, or a
 * projection's files). A top-level root's minimal-version
 * selection is simply its constraint's lower bound (nothing else constrains
 * it), so this is exactly the version the joint path would give the root,
 * reached without walking — or fetching — the closure; any projection stays
 * pending on the delivered ref (RepositoryRef.applyTo), finished by the
 * driving context. For a repository's `fetchFiles` to call: it mints the
 * `Selected` and the resolution provenance a delivered package carries.
 */
export function resolveBarePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<FileSet> {
  return barePackage(registry, reference, () => Computable.resolve({ dependencies: [], provided: new Map() }));
}

/**
 * Fetch what the package `reference` names publishes for `operation` (see
 * {@link RepositoryReader.fetchFor}), at the reference's lower bound, with no
 * closure and no joint resolution: the files a file request under that
 * operation asks for.
 */
export function resolvePublishedFor<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef, operation: string): Computable<FileSet> {
  const { req, version, origin, unpublished } = lowerBound(registry, reference);
  return publishedFor(registry, req.name, version, operation, origin).catch(unpublished);
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
 * Resolve the package `reference` names as an **instance**: the package at the
 * reference's lower bound, carrying each requirement that version declares as
 * a reference to `registry`, the provided ones marked. Its files are fetched
 * when it is materialized. Nothing it requires is resolved: the collection
 * point the instance reaches resolves what it carries, as it does a built
 * package's.
 */
export function instantiatePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<ResolvedNode> {
  const { format } = registry;
  const { req, version, origin, unpublished } = lowerBound(registry, reference);
  return registry
    .getRequirements(req.name, version)
    .then(requirements => {
      const dependencies = requirements.map((each): Dependency => ({ reference: requirementReference(registry, each) }));
      const provided = new Map(
        requirements.flatMap((each): Array<[string, Provided]> => (each.provided === undefined ? [] : [[requiredAs(each), each.provided]]))
      );
      const shown = format.versionToString(version);
      return new ResolvedNode(
        { key: `${registry.identity} ${req.name}@${shown}`, files: () => registry.fetch(req.name, version).catch(unpublished) },
        req.name,
        shown,
        dependencies,
        namedFrom(registry, req.name, version, origin),
        provided
      );
    })
    .catch(unpublished);
}

/** What a package declares, as a delivered package carries it. */
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
  return Computable.forAll(
    [registry.fetch(req.name, version), declared(req.name, version)],
    (pkg, { dependencies, provided }) => new PackageFileSet(pkg, pkg.packageName, pkg.version, dependencies, origin, provided)
  ).catch(unpublished);
}

/**
 * Find the one version `reference` names without a resolution: its lower
 * bound. `unpublished` rethrows a failure to find that version, saying which
 * version a build would have raised it to.
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
  const origin = resolutionOrigin(format, req, [selection]);
  /* The written minimum was never published. The joint (build/test) path
   * would floor-raise here; the standalone path stays exact by design, but
   * the error should name the raise the build would take. */
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
 * The files of the package a resolution's root is pinned to, with no
 * dependency closure: the version `resolution` bound `reference` to, fetched
 * alone, or given `operation`, what that version publishes for it. The pinned
 * counterpart of {@link resolveBarePackage} and {@link resolvePublishedFor},
 * for a holder of a stored resolution (a catalog).
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
  const origin = resolutionOrigin(allowingBuilds(format), req, graph.selections);
  if (operation !== undefined) {
    return publishedFor(registry, bound.publishedName ?? bound.name, version, operation, origin);
  }
  return registry.fetch(bound.publishedName ?? bound.name, version).then(pkg => new PackageFileSet(pkg, pkg.packageName, pkg.version, [], origin));
}

/**
 * Make what the generic repair suggester needs from the domain (see
 * resolver/ResolutionReport): the written reference form, the registry's
 * version list, and a memoized enrichment-free re-resolve.
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
        false
      ),
  };
}

/**
 * Resolve `roots` jointly against `registry`, memoized in the build cache.
 *
 * Resolutions are persisted in the build cache: under minimal version selection
 * the result is a pure function of the (canonically ordered) root requirements
 * and the (immutable) declared metadata of the packages they reach, so a cached
 * resolution can only become wrong if a requirement itself changes — which
 * changes the cache key. (The one exception is a floor raise, which consults
 * the mutable version list — deterministic modulo registry append, and only on
 * the repair path.) Failed resolutions are not cached (the error propagates
 * before anything is written), so transient repository problems don't poison
 * the cache. Repairs (violations, raises, forks) are recorded in the doc as
 * data — enforcement is per delivery.
 *
 * The memo key carries the registry's identity (a plain registry: its url;
 * a group: its whole serialized route table) and its environment key: what a
 * name resolves to depends on where each name routes, and on what the
 * resolution was computed for (npm: the target platform, which gates optional
 * deps) — a resolution computed under one table or target must never be
 * served for another.
 */
function getJointResolution<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  repositoryName: string | undefined,
  roots: Requirement[],
  rootKeys: string[],
  builds: Builds,
  enrich = true
): Computable<MVSResolution<V | string>> {
  const { format } = registry;
  /* Builds are candidates, which the registry's own domain cannot say. */
  const domain = allowingBuilds(format);
  /* What each build requires is as much an input as the roots are. */
  const builtKeys = [...builds.built]
    .map(([id, node]) => `built ${id}: ${node.requirements.map(requirementKey).sort().join(", ")}`)
    .sort();
  return registry.environmentKey().then(environment => {
    return context
      /* Newline-join the roots: a version constraint may contain spaces (a
       * quoted hyphen range, `1.2.3 - 2.3.4`), so a space delimiter isn't
       * obviously injective — a newline can appear in neither a package name
       * nor a constraint, matching how file deps are already newline-separated. */
      .memoize(format.resolutionTag, `${registry.identity} ${environment}\n${[...rootKeys, ...builtKeys].join("\n")}`, () =>
        /* A memo miss means real resolution work on behalf of the consumer —
         * tracked, so the metadata reads it fans out are attributable to a
         * resolution still in flight rather than appearing on their own. */
        context.runTask(
          { kind: "repository-resolve", repository: repositoryName ?? registry.identity, consumer: context.name, requirements: rootKeys },
          () =>
            resolveMVS(roots, domain, withBuilds(registry, builds)).then(result => {
              /* Hard errors (unparseable constraints, floorless-only
               * requirements) are not repairable in any mode. Grouped and
               * enriched with pin suggestions before throwing — typed + per-error
               * root attribution, so the resolve catch can map each failure to
               * the written reference(s) that pulled its subtree in, instead of
               * blaming the whole collection point. */
              if (result.errors.length > 0) {
                if (!enrich) {
                  throw new ResolutionWalkError(result.errors);
                }
                return completeRepairSet(result.errors, roots, suggestSourcesFor(context, registry, repositoryName, builds)).then(failures => {
                  throw new ResolutionWalkError(failures);
                });
              }
              return validatedResolutionDoc(registry, roots, result);
            })
        )
      )
      .then(files => files.readFile(RESOLUTION_FILE))
      .then(data => deserializeResolutionDoc(JSON.parse(data) as IResolutionDoc, domain));
  });
}

/**
 * Run the registry's post-resolution policy over the final selections
 * (npm: the EBADPLATFORM check; a group partitions by route), then serialize.
 * Policy is judged over the finished graph — fork selections included, they
 * are ordinary selections of the one tree — and stays hard in every mode.
 */
function validatedResolutionDoc<V, C>(
  registry: RepositoryReader<V, C>,
  roots: Requirement[],
  result: MVSResolution<V | string>
): Computable<FileSet> {
  /* The registry's policy is over what it publishes. */
  const domain = allowingBuilds(registry.format);
  const published = result.selections.filter((sel): sel is Selected<V> => !(isBuildVersion(sel.version)));
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
function namedFrom<V, C>(registry: RepositoryReader<V, C>, name: string, version: V, origin: IProvenanceStep | undefined): IProvenanceStep | undefined {
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

