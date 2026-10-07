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
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { dependencyName, PackageFileSet, PackageGraphBuilder, Provided } from "../core/PackageFileSet";
import {
  isRepositoryReader,
  PackageRequest,
  RefSource,
  RepositoryReader,
  ResolutionContext,
  RepositoryRef,
  Resolution,
  ResolvedRoot,
  SourceRef,
} from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { PackageFormat } from "./PackageFormat";
import { resolveMVS } from "./MVSResolver";
import { collectSanctions, satisfiedByAnySelection, writtenVersions } from "./Overrides";
import {
  allowingUnversioned,
  canonicalRequirements,
  constraintOf,
  requiredAs,
  requirementKey,
  versionConstraintText,
  violationKey,
  violationKeys,
} from "./Requirement";
import { deserializeResolutionDoc, IResolutionDoc, serializeResolutionDoc } from "./ResolutionDoc";
import { nodeId, ResolutionGraph } from "./ResolutionGraph";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./ResolutionProvenance";
import type { IDeliveryFacts } from "./StrictCollection";
import { completeRepairSet, RefRenderer, SuggestSources, unrepairableError } from "./ResolutionReport";
import { IRequirementEdge, MVSResolution, PackageIdentity, Requirement, RequirementSource, ROOT_REQUIRER, Selected, VersionDomain } from "./Types";

const RESOLUTION_FILE = "resolution.json";

/**
 * Vend the read reference for a written package name: the format claims the
 * identity portion and anything left over rides the ref as a projection into
 * the resolved content — so the caller holds one deferred ref with nothing of
 * the name left to interpret. The repository is the ref's source: at the
 * consumer's collection point references group by that source, so everything
 * written against one repository resolves in one joint batch.
 */
export function vendPackageRef<V, C>(source: RefSource, format: PackageFormat<V, C>, name: Name): RepositoryRef {
  const { projection, ...identity } = format.splitReference(name);
  /* A rename written on the identity is the package's; one written after a
   * projection rides the projection, and renames the files it selects. */
  return projection
    ? new RepositoryRef(source, identity).find(projection.pattern, projection.prefix)
    : new RepositoryRef(source, { ...identity, renameTo: name.getRenameTo()?.toString() });
}

/**
 * The requirement that depending on `source` declares — what a generated
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
export function declaredRequirement(source: SourceRef): Computable<Requirement | undefined> {
  if (source instanceof PackageFileSet) {
    /* A package a repository delivered declares what the reference it was
     * delivered for states, not the version that happened to be selected. */
    return source.reference === undefined
      ? Computable.resolve({ name: source.packageName, versionConstraint: source.version })
      : declaredRequirement(source.reference);
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

/**
 * A declared requirement as known by `name` — the local name its requirer
 * imports it under, recorded as {@link Requirement.renameTo} so a generated
 * manifest can state it (npm: `"typescript-6": "npm:typescript@6.0.0-beta"`).
 * A name matching the package's own renames nothing, and neither does none.
 */
export function knownAs(requirement: Requirement, name: string | undefined): Requirement {
  return name === undefined || name === requirement.name ? requirement : { ...requirement, renameTo: name };
}

/**
 * An already-resolved package made runnable by whatever delivered it: pure
 * format convention, keyed off the registry the package came from (a catalog
 * passes its member's own source). The closure the package carries is kept —
 * never re-resolved.
 */
export function runnableFrom(source: RefSource, pkg: PackageFileSet): Computable<RunnableFileSet> {
  if (isRepositoryReader(source)) {
    return source.format.makeRunnable(pkg);
  }
  return Computable.reject(new FabrError(`'${pkg.packageName}' was delivered by a repository that cannot make it runnable`));
}

/**
 * The domain's private {@link Resolution}: how the request maps onto the
 * loaded resolution — the {@link ResolutionGraph} (the joint selection tree,
 * its repairs, and every index a delivery reads), plus the root bookkeeping
 * and sanctions that belong to the *request* rather than the resolution.
 */
interface DomainResolution<V> extends Resolution {
  readonly roots: ResolvedRoot[];
  /** requirementKey → index into the resolution's roots (the space `reachableFrom` indexes). */
  readonly rootIndex: Map<string, number>;
  /** The loaded resolution itself. A node has no version where it is a built
   * package that has none. */
  readonly graph: ResolutionGraph<V | undefined>;
  /**
   * The versions written as sanctioned in this collection's references — a
   * `?`, or an exact pin: pkg → versions. Every delivery cut from the
   * resolution is judged against all of them, whichever members it names.
   * Judgment-time data carried OUTSIDE the persisted doc (the resolution
   * outcome does not depend on it, so neither does the memo key).
   */
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  /** The packages built in the project that are nodes of the resolution, by
   * node id (see {@link builtNodes}). */
  readonly built: ReadonlyMap<string, BuiltNode<V>>;
  /** Where each reference a built package carries sits in the graph: the edge
   * of that package's node it is. Such a reference is no root. */
  readonly carried: ReadonlyMap<RepositoryRef, CarriedEdge>;
}

/**
 * A package built in the project, as a node of a registry's resolution: a
 * package like any the registry publishes, except that what it requires is
 * read off the package in hand, and that it is the only version of its name.
 * A requirement on that name, from anywhere, binds to it.
 */
interface BuiltNode<V> {
  readonly pkg: PackageFileSet;
  /** The version it has, if any. */
  readonly version: V | undefined;
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

/**
 * The packages built in the project, as nodes for `registry`'s resolution:
 * what each requires of this registry — the references it carries that are
 * addressed to it, as they are written but without their markers, which were
 * its own collection point's — and of the other built packages. A reference
 * that resolves nothing here is left out, as a collection point leaves it out:
 * one addressed elsewhere, one with projections, a `?`.
 */
function builtNodes<V, C>(
  registry: RepositoryReader<V, C>,
  locals: ReadonlyArray<PackageFileSet>
): { built: Map<string, BuiltNode<V>>; carried: Map<RepositoryRef, CarriedEdge> } {
  const { format } = registry;
  const domain = allowingUnversioned(format);
  const built = new Map<string, BuiltNode<V>>();
  const carried = new Map<RepositoryRef, CarriedEdge>();
  const names = new Set<string>();
  for (const pkg of locals) {
    if (names.has(pkg.packageName)) {
      continue;
    }
    names.add(pkg.packageName);
    const version = versionIn(format, pkg.version);
    const id = nodeId(domain, pkg.packageName, version);
    const requirements: Requirement[] = [];
    for (const dep of pkg.dependencies) {
      const provided = pkg.provided.get(dependencyName(dep));
      const role = provided === undefined ? {} : { provided };
      const reference = dep instanceof RepositoryRef ? dep : dep.reference;
      if (reference === undefined) {
        requirements.push({ name: dependencyName(dep), versionConstraint: undefined, ...role });
      } else if (reference.source === registry && reference.projections.length === 0 && reference.override !== "alternate") {
        let stated: Requirement;
        try {
          stated = requirementOf(format, reference);
        } catch (err) {
          throw new RequirementResolutionError([reference], toError(err));
        }
        const requirement: Requirement = { ...stated, override: undefined, ...role };
        requirements.push(requirement);
        carried.set(reference, { from: id, name: requiredAs(requirement), requirement });
      }
    }
    built.set(id, { pkg, version, requirements });
  }
  return { built, carried };
}

/** A built package's version as `format` reads it: none where it has none,
 * or where what it has is another ecosystem's and means nothing to this one. */
function versionIn<V, C>(format: PackageFormat<V, C>, version: string | undefined): V | undefined {
  if (version === undefined) {
    return undefined;
  }
  try {
    return format.parseVersion(version);
  } catch {
    return undefined;
  }
}

/** `registry`, with the built packages answering for themselves. */
function withBuiltNodes<V, C>(registry: RepositoryReader<V, C>, built: ReadonlyMap<string, BuiltNode<V>>): RequirementSource<V | undefined> {
  const domain = allowingUnversioned(registry.format);
  const lowestAvailable = registry.lowestAvailable?.bind(registry);
  return {
    getRequirements: (name, version) => {
      const node = built.get(nodeId(domain, name, version));
      if (node !== undefined) {
        return Computable.resolve(node.requirements);
      }
      /* Only a built package has no version. */
      return registry.getRequirements(name, version as V);
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
 * hands each batch to this driver, which yields the materialized graph back
 * to it.
 *
 * The driver only ever asks per-name questions of the one registry it was
 * handed — including for every transitive requirement discovered mid-walk —
 * so the whole closure of a reference comes from the origin it was written
 * against; a group's routing is invisible here.
 * ---------------------------------------------------------------------------
 */

/**
 * The requirement a reference states, once its repository's format accepts
 * it: the package, the version constraint, any override marker, and the name
 * it is to be delivered under — a renamed package being one of its own.
 */
export function requirementOf<V, C>(format: PackageFormat<V, C>, reference: Requirement): Requirement {
  format.validateRequirement(reference);
  return {
    name: reference.name,
    versionConstraint: reference.versionConstraint,
    ...(reference.override === undefined ? {} : { override: reference.override }),
    ...(reference.renameTo === undefined || reference.renameTo === reference.name ? {} : { renameTo: reference.renameTo }),
  };
}

/**
 * Phase 1 — resolve a batch of references jointly (one minimal-version-selection
 * over all root requirements, so shared packages agree on a version and user
 * overrides dominate per max-of-minimums) WITHOUT fetching. Returns the
 * selection tree; {@link materializePackages} fetches a subset of it on demand.
 *
 * Under `files` the consumer wants each package's own files standalone — no
 * closure, no joint resolution — so resolution is a no-op that just records the
 * root names (fetch happens per-reference in materialize). This is what lets
 * `fabr cat @npm:pkg:ver:file` succeed when the closure is unresolvable here.
 */
export function resolvePackages<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  requests: ReadonlyArray<PackageRequest>,
  locals: ReadonlyArray<PackageFileSet> = [],
  /** Those of `locals` the collection requires outright. */
  own: ReadonlySet<PackageFileSet> = new Set()
): Computable<Resolution> {
  const { format } = registry;
  const references = requests.map(request => request.reference);
  /* No operation here: a resolution is a function of the requirements alone
   * (build and run share one), and what varies by operation is the SHAPE of
   * the delivery, decided by the repository in its own `deliver`. */
  return Computable.resolve(undefined).then(() => {
    const { built, carried } = builtNodes(registry, locals);
    /* Each request as the requirement it is: the collection's own as written,
     * a built package's as that package's node states it. */
    const requirements = requests.map(request => {
      const edge = request.as === "package" ? undefined : carried.get(request.reference);
      if (edge !== undefined) {
        return edge.requirement;
      }
      try {
        return requirementOf(format, request.reference);
      } catch (err) {
        throw new RequirementResolutionError([request.reference], toError(err));
      }
    });
    /* Alternates (`?`) are judgment-time sanctions, not demands: they join
     * neither the roots (a catalog's member table must not see them) nor the
     * resolution memo (the outcome is unchanged by them) — they ride the
     * in-memory resolution to the strict gate. Contradictory markers are
     * attributed to the written references that carry them. */
    const alternates = collectSanctions(format, requirements, (pkg, message): never => {
      throw new RequirementResolutionError(
        references.filter((_, index) => requiredAs(requirements[index]) === pkg),
        new FabrError(message)
      );
    });
    /* A root is named as it is DELIVERED — the written rename when the reference
     * carries one, the resolved package name otherwise — so a caller addressing
     * the resolution's roots (a catalog keying its members) and the delivery
     * itself (RepositoryRef.deliveredAs) agree by construction. Only the
     * addressing name is renamed: what is resolved and fetched is the package
     * the requirement names. */
    const roots: ResolvedRoot[] = references.flatMap((reference, index) =>
      requirements[index].override === "alternate"
        ? []
        : [{ reference, name: reference.deliveredName }]
    );
    /* Canonicalize the roots so the resolution (and its memo key, and the
     * reachableFrom indices) are independent of reference order. Alternates
     * ARE included: attach-last means a `?` can supply a floorless-only
     * package's version, so it is part of the resolution's identity (its
     * key carries the marker). It still joins neither `roots` above (a
     * catalog's member table must not see it) nor a delivery (it mounts
     * nothing of its own). */
    /* The roots are the collection's own requirements: on what its references
     * name, and on the built packages it holds outright. What a built package
     * carries — a reference, or another built package — is an edge of its
     * node, not a root. */
    const { roots: rootReqs, keys: rootKeys } = canonicalRequirements([
      ...requirements.filter((_, index) => requests[index].as === "package" || !carried.has(references[index])),
      ...[...built.values()].filter(node => own.has(node.pkg)).map((node): Requirement => ({ name: node.pkg.packageName, versionConstraint: undefined })),
    ]);
    const rootIndex = new Map<string, number>(rootKeys.map((key, index) => [key, index]));
    /* Only the collection's own requirements are written by it: a package's
     * exact requirement is a transitive one, which vouches for nothing. */
    const written = writtenVersions(
      format,
      alternates,
      requirements.filter((req, index) => requests[index].as === "package" && req.override !== "alternate")
    );
    return getJointResolution(context, registry, repositoryNameOf(references), rootReqs, rootKeys, built)
      .then(graph => ({ roots, rootIndex, written, graph, built, carried }) satisfies DomainResolution<V>)
      .catch(err => attributeResolutionFailure(err, references, requirements));
  });
}

/**
 * Phase 2 — fetch + assemble the requested references (a subset of `resolution`).
 * Only the closure reachable from the requested roots is fetched, from the
 * pre-resolved tree — so a subset materialization keeps the joint pin. What is
 * delivered is the assembled packages; the shape an operation wants (a
 * runnable, bare files) is the repository's `deliver`'s business.
 *
 * A violation nothing in the resolution satisfies has no repairing fork and
 * fails here, in EVERY mode — no delivery can honor the constraint. Whether a
 * repaired closure is ACCEPTABLE is not this delivery's question: a strict
 * (linked) consumer is judged over everything it uses together, at its
 * collection point (StrictCollection), from the facts each delivery
 * records on its packages' provenance; a permissive one (a sealed install)
 * nests the repairs privately.
 */
export function materializePackages<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  requests: ReadonlyArray<PackageRequest>,
  resolution: Resolution
): Computable<(PackageFileSet | undefined)[]> {
  const { format } = registry;
  const references = requests.map(request => request.reference);
  const resolved = resolution as DomainResolution<V>;
  const { rootIndex, written, graph, built, carried } = resolved;
  /* A reference a built package carries is the edge of that package's node it
   * was resolved as; any other is a root. */
  const edgeOf = (index: number): CarriedEdge | undefined => (requests[index].as === "package" ? undefined : carried.get(references[index]));
  const requirements = requests.map((request, index) => edgeOf(index)?.requirement ?? requirementOf(format, request.reference));
  /* An alternate (`?`) reference demands nothing and delivers nothing of its
   * own — the sanctioned fork arrives nested inside the canonical closure. */
  const rooted = requirements.filter((req, index) => edgeOf(index) === undefined && req.override !== "alternate");
  const requestedKeys = new Set(requirements.filter(req => req.override !== "alternate").map(requirementKey));
  const violable = violationKeys(rooted);
  /* What a requirement BINDS to — normally the principal, but a violated one
   * is answered by its fork. The resolution decided this when it was computed:
   * for a root scoped to what that root reaches, so another root's fork cannot
   * answer here, and for a built package's requirement as its node's edge. */
  const bindings = requirements.map((req, index): Selected<V | undefined> | undefined => {
    const edge = edgeOf(index);
    if (edge !== undefined) {
      const to = graph.edgesOf(edge.from).get(edge.name);
      return to === undefined ? undefined : graph.node(to);
    }
    return req.override === "alternate" ? undefined : graph.rootBinding(rootIndex.get(requirementKey(req))!);
  });
  /* The selections reachable from the requested roots — the fetch set.
   * Forks are reachable exactly through the violated edges bound to them,
   * so a strict subset whose closure has no violations carries no forks.
   * Walked forward over the resolution's own edges (O(the subset)). */
  const seeds = new Set(bindings.filter((sel): sel is Selected<V | undefined> => sel !== undefined).map(sel => graph.id(sel)));
  const reachableIds = graph.reachable(seeds);
  /* Back to the resolution's canonical order — the walk reaches nodes in edge
   * order, and everything downstream that reports on the delivery must read
   * the same way whichever root led to a node first. */
  /* The delivery's nodes: what the requests reach, and the built packages
   * whose requirements they are — each as much a part of what is delivered,
   * and as answerable for what it requires, as a package the registry holds. */
  const carriers = requests.flatMap((_, index) => edgeOf(index)?.from ?? []);
  const needed = graph.nodesOf(new Set([...reachableIds, ...carriers]));
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
  const root = [...requestedKeys].sort().join(", ");
  const refText = refTextFor(references, registry);
  const facts: IDeliveryFacts<V | undefined, C> = {
    domain: allowingUnversioned(format),
    graph,
    needed,
    requested: requirements,
    written,
    refText,
    sources: () => suggestSourcesFor(context, registry, repositoryNameOf(references), built),
  };
  /* Judged before anything is downloaded: the verdict is decided by the
   * resolution alone. Rejects rather than throws — materialize may be entered
   * synchronously, outside any chain that would capture a throw. */
  const judgeRepairs = (): Computable<void> => {
    /* Only selections of the violated package can satisfy it, so the question
     * is asked of that package's candidates rather than of every selection. */
    const unrepaired = scopedViolations.filter(
      violation => !satisfiedByAnySelection(format, graph.selectionsOf(violation.name), violation)
    );
    return unrepaired.length > 0 ? Computable.reject(unrepairableError(root, unrepaired, graph, refText)) : Computable.resolve(undefined);
  };
  return judgeRepairs()
    .then(() => {
      /* The forks repairing the reachable violations are already in `needed`,
       * nested by the layout plan where the consumer accepts them. One
       * fetch per member — ids are distinct by construction. */
      /* A built package is in hand: only the others are the registry's to fetch. */
      const toFetch = new Map(needed.filter(sel => !built.has(graph.id(sel))).map(sel => [graph.id(sel), sel] as const));
      const fetchIds = [...toFetch.keys()];
      return Computable.forAll(
        fetchIds.map(id => {
          const sel = toFetch.get(id)!;
          /* What is fetched is published, so it has a version. */
          return registry.fetch(sel.publishedName ?? sel.name, sel.version as V);
        }),
        (...fetched: PackageFileSet[]) => {
          const packages = new Map<string, PackageFileSet>(fetchIds.map((id, k) => [id, fetched[k]]));
          const assembled = requirements.map((req, index) => {
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
            /* A requirement a built package answers is that package, as it
             * stands: the collection point delivers it in its own right. */
            return built.get(graph.id(bound))?.pkg ?? buildClosure(registry, req, bound, graph, packages, facts as IDeliveryFacts, built);
          });
          /* Assembled, not shaped: what a package BECOMES on delivery (mounted
           * as-is, launched as a runnable, or reduced to its own files) is the
           * repository's call, made in its `deliver`. */
          return Computable.resolve(assembled);
        }
      );
    })
    .catch(err => attributeResolutionFailure(err, references, requirements));
}

/** The written form of a reference into this domain, for pasteable
 * suggestions — rendered with the repository name the references were written against
 * (a suggestion must read exactly as the user would write it here; the
 * registry's own identity — a url — is the fallback when no reference
 * carries one, e.g. programmatic use). */
function refTextFor(references: RepositoryRef[], registry: { identity: string }): RefRenderer {
  const name = repositoryNameOf(references) ?? registry.identity;
  return (pkg, versionText, marker) => writtenReference(name, pkg, versionText, marker);
}

/** A selected package at a version as a reference to it would be written
 * against the repository named `repository`, renamed where it is. */
function writtenReference(repository: string, pkg: PackageIdentity, versionText: string, marker?: "?" | "!"): string {
  const written = `${repository}:${pkg.publishedName ?? pkg.name}:${versionText}${marker ?? ""}`;
  return pkg.publishedName === undefined ? written : `${written} -> ${pkg.name}`;
}

/** The declared repository name the batch's references were written against (they share
 * a source, so the first stamped one speaks for the batch). */
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
 * Deliver one root requirement's package: the graph of every reachable,
 * fetched selection, each node carrying **all** of its dependency edges
 * bound to the instance the resolution chose — the resolver's own edge rule
 * ({@link edgeBinding} via the precomputed edge map), a fact identical in
 * every delivery. NO layout is decided here: hoisting and private nesting
 * are the consuming assembler's business (assembleNodeModules), computed
 * from these complete facts at the merge that needs them.
 *
 * The graph may be cyclic (mutual same-version deps are ordinary npm), so
 * it is constructed through a {@link PackageGraphBuilder}, each instance
 * memoized before its edges wire. An instance exists per selection, and a
 * renamed package is a selection of its own — `wrap-ansi` delivered as
 * `wrap-ansi-cjs` IS a package of that name as far as any install is
 * concerned, content shared.
 */
function buildClosure<V, C>(
  registry: RepositoryReader<V, C>,
  req: Requirement,
  root: Selected<V | undefined>,
  graph: ResolutionGraph<V | undefined>,
  packages: Map<string, PackageFileSet>,
  delivery: IDeliveryFacts,
  built: ReadonlyMap<string, BuiltNode<V>>
): PackageFileSet {
  const rootId = graph.id(root);
  const origin = resolutionOrigin(allowingUnversioned(registry.format), req, graph.selections, delivery);
  /* A worklist over the graph, in the builder's own two-phase shape: discover
   * each delivered (name, id) instance from the root, then wire its edges once
   * its targets exist. Discovery IS the membership walk — everything reached
   * from the root is delivered, and an edge leading outside the fetched batch
   * (a gated optional pruned from the walk, hence not in `packages`) is simply
   * not carried. Every provided requirement is recorded on the instance with
   * what this resolution offers for it, for the collection point to bind; an
   * expected one's offer is also wired here as the default, an optional one's
   * never — whether it is present is the installation's fact. */
  const builder = new PackageGraphBuilder();
  const instances = new Map<string, PackageFileSet>();
  const pending: Array<[string, PackageFileSet]> = [];
  /* A selection is delivered under the name it is installed as, which for a
   * renamed one is not the name its content was fetched under. */
  const instance = (id: string): PackageFileSet => {
    let node = instances.get(id);
    if (!node) {
      const files = packages.get(id)!;
      node = builder.node(files, graph.node(id)!.name, files.version, origin);
      instances.set(id, node);
      pending.push([id, node]);
    }
    return node;
  };
  /* A provided requirement this delivery does not wire — an optional one, or
   * one whose answer is outside the fetched batch — as a reference: to what
   * this resolution selected for it, or, where it selected nothing, to what
   * the package declared. */
  const offered = (id: string, name: string, toId: string | undefined): RepositoryRef => {
    const selected = toId === undefined ? undefined : graph.node(toId);
    const declared = graph.requirements.get(id)?.find(req => req.provided !== undefined && requiredAs(req) === name);
    const pkg = selected === undefined ? (declared?.name ?? name) : (selected.publishedName ?? selected.name);
    return new RepositoryRef(registry, {
      name: pkg,
      versionConstraint: selected === undefined ? declared?.versionConstraint : graph.versionToString(selected.version),
      renameTo: name === pkg ? undefined : name,
    });
  };
  const delivered = instance(rootId);
  while (pending.length > 0) {
    const [id, node] = pending.pop()!;
    const edges = graph.edgesOf(id);
    const providedNames = graph.providedNames(id);
    const optional = graph.optionalProvidedNames(id);
    /* Each edge bound to the instance this delivery wires for it. One leading
     * outside the fetched batch is not carried, unless it is a provided
     * requirement, which stays — as a reference — for its consumer to answer. */
    const dependencies = [...new Set([...edges.keys(), ...[...providedNames].sort()])].flatMap((name): Array<PackageFileSet | RepositoryRef> => {
      const toId = edges.get(name);
      if (optional?.has(name) !== true && toId !== undefined && packages.has(toId)) {
        return [instance(toId)];
      }
      /* An edge to a package built in the project holds that package as it
       * stands; the collection point puts its delivered form in its place. */
      const local = toId === undefined ? undefined : built.get(toId);
      if (local !== undefined) {
        return [local.pkg];
      }
      return providedNames.has(name) ? [offered(id, name, toId)] : [];
    });
    const provided = new Map([...providedNames].map((name): [string, Provided] => [name, optional?.has(name) === true ? "optional" : "expected"]));
    builder.wire(node, dependencies, provided);
  }
  builder.seal();
  return delivered;
}

/** The provenance origin of a delivered closure: the root requirement and the
 * selections that answer "why is this package here / why this version". It
 * carries no registry identity — "who provided this" is answered by following
 * the chain to the written reference and the declaration it names. */
function resolutionOrigin<V, C>(
  format: VersionDomain<V, C>,
  req: Requirement,
  selections: Selected<V>[],
  delivery?: IDeliveryFacts
): IResolutionOrigin<V> {
  return {
    kind: PACKAGE_RESOLUTION_PROVENANCE,
    root: req,
    selections,
    versionToString: format.versionToString,
    ...(delivery === undefined ? {} : { delivery }),
  };
}

/**
 * A package's own files, with no dependency closure and no joint resolution —
 * what BUILD_OPERATION=files asks for. A top-level root's minimal-version
 * selection is simply its constraint's lower bound (nothing else constrains
 * it), so this is exactly the version the joint path would give the root,
 * reached without walking — or fetching — the closure; any projection stays
 * pending on the delivered ref (RepositoryRef.deliveredAs), finished by the
 * driving context. For a repository's `deliver` to call: it mints the
 * `Selected` and the resolution provenance a delivered package carries.
 */
export function resolveBarePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<FileSet> {
  return barePackage(registry, reference, () => Computable.resolve({ dependencies: [], provided: new Map() }));
}

/**
 * The package `reference` names as an **instance**: its own files at the
 * reference's lower bound, carrying each requirement that version declares as
 * a reference to `registry`, the provided ones marked. Nothing is resolved:
 * the collection point the instance reaches resolves what it carries, as it
 * does a built package's.
 */
export function instantiatePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<PackageFileSet> {
  return barePackage(registry, reference, (name, version) =>
    registry.getRequirements(name, version).then(requirements => ({
      dependencies: requirements.map(
        req => new RepositoryRef(registry, { name: req.name, versionConstraint: req.versionConstraint, override: req.override, renameTo: req.renameTo })
      ),
      provided: new Map(requirements.flatMap((req): Array<[string, Provided]> => (req.provided === undefined ? [] : [[requiredAs(req), req.provided]]))),
    }))
  );
}

/** What a package declares, as a delivered package carries it. */
interface DeclaredRequirements {
  readonly dependencies: ReadonlyArray<RepositoryRef>;
  readonly provided: ReadonlyMap<string, Provided>;
}

/** The package `reference` names at its lower bound, carrying what `declared`
 * gives for that published name and version. */
function barePackage<V, C>(
  registry: RepositoryReader<V, C>,
  reference: RepositoryRef,
  declared: (name: string, version: V) => Computable<DeclaredRequirements>
): Computable<PackageFileSet> {
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
  return Computable.forAll(
    [registry.fetch(req.name, version), declared(req.name, version)],
    (pkg, { dependencies, provided }) => new PackageFileSet(pkg, pkg.packageName, pkg.version, dependencies, origin, provided)
  ).catch(err => {
      /* The written minimum was never published. The joint (build/test) path
       * would floor-raise here; the standalone files path stays exact by
       * design, but the error should name the raise the build would take. */
      if (err instanceof VersionNotFoundError) {
        const raise = registry.lowestAvailable
          ? registry.lowestAvailable(req.name, stated)
          : Computable.resolve<V | undefined>(undefined);
        return raise.then(raised => {
          throw raised
            ? err.withHelp(
                `the lowest published version satisfying '${stated}' is ${format.versionToString(raised)} — ` +
                  `pin '${req.name}:${format.versionToString(raised)}' (a build resolves this automatically via a floor raise)`
              )
            : err;
        });
      }
      throw err;
    });
}

/**
 * The files of the package a resolution's root is pinned to, with no
 * dependency closure: the version `resolution` bound `reference` to, fetched
 * alone. The pinned counterpart of {@link resolveBarePackage}, for a holder of
 * a stored resolution (a catalog).
 */
export function fetchPinnedPackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef, resolution: Resolution): Computable<FileSet> {
  const { format } = registry;
  const { rootIndex, graph } = resolution as DomainResolution<V>;
  const req = requirementOf(format, reference);
  const index = rootIndex.get(requirementKey(req));
  const bound = index === undefined ? undefined : graph.rootBinding(index);
  if (!bound) {
    throw new FabrError(`Resolution does not contain ${requirementKey(req)}`);
  }
  const version = bound.version;
  if (version === undefined) {
    throw new FabrError(`${requirementKey(req)} is a package built in this project, which its repository does not hold`);
  }
  const origin = resolutionOrigin(allowingUnversioned(format), req, graph.selections);
  return registry.fetch(bound.publishedName ?? bound.name, version).then(pkg => new PackageFileSet(pkg, pkg.packageName, pkg.version, [], origin));
}

/**
 * What the generic repair suggester needs from the domain (see
 * resolver/ResolutionReport): the written reference form, the registry's
 * version list, and a memoized enrichment-free re-resolve.
 */
function suggestSourcesFor<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  repositoryName: string | undefined,
  built: ReadonlyMap<string, BuiltNode<V>>
): SuggestSources<V | undefined, C> {
  return {
    domain: allowingUnversioned(registry.format),
    refText: (pkg, versionText, marker) => writtenReference(repositoryName ?? registry.identity, pkg, versionText, marker),
    availableVersions: pkg => registry.availableVersions?.(pkg.publishedName ?? pkg.name) ?? Computable.resolve(undefined),
    resolve: roots =>
      getJointResolution(
        context,
        registry,
        repositoryName,
        roots,
        roots.map(req => requirementKey(req)),
        built,
        false
      ),
  };
}

/**
 * Resolutions are persisted in the build cache: under minimal version selection
 * the result is a pure function of the (canonically ordered) root requirements
 * and the (immutable) declared metadata of the packages they reach, so a cached
 * resolution can only become wrong if a requirement itself changes — which
 * changes the cache key. (The one exception is a floor raise, which consults
 * the mutable version list — deterministic modulo registry append, and only on
 * the repair path.) Failed resolutions are not cached (the error propagates
 * before anything is written), so transient repository problems don't poison
 * the cache. Repairs (violations, raises, forks) are recorded in the doc as
 * data — enforcement is per delivery, at materialize.
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
  built: ReadonlyMap<string, BuiltNode<V>> = new Map(),
  enrich = true
): Computable<ResolutionGraph<V | undefined>> {
  const { format } = registry;
  /* A built package may have no version, which the registry's own domain
   * cannot say. */
  const domain = allowingUnversioned(format);
  /* What each built package requires is as much an input as the roots are. */
  const builtKeys = [...built]
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
            resolveMVS(
              roots,
              domain,
              withBuiltNodes(registry, built),
              new Map([...built.values()].map(node => [node.pkg.packageName, node.version]))
            ).then(result => {
              /* Hard errors (unparseable constraints, unconstrained-only
               * requirements) are not repairable in any mode. Grouped and
               * enriched with pin suggestions before throwing — typed + per-error
               * root attribution, so the resolve catch can map each failure to
               * the written reference(s) that pulled its subtree in, instead of
               * blaming the whole collection point. */
              if (result.errors.length > 0) {
                if (!enrich) {
                  throw new ResolutionWalkError(result.errors);
                }
                return completeRepairSet(result.errors, roots, suggestSourcesFor(context, registry, repositoryName, built)).then(failures => {
                  throw new ResolutionWalkError(failures);
                });
              }
              return validatedResolutionDoc(registry, roots, result, built);
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
  result: MVSResolution<V | undefined>,
  built: ReadonlyMap<string, BuiltNode<V>>
): Computable<FileSet> {
  /* The registry's policy is over what it publishes. */
  const domain = allowingUnversioned(registry.format);
  const published = result.selections.filter((sel): sel is Selected<V> => !built.has(nodeId(domain, sel.name, sel.version)));
  return (registry.validateSelections?.(published) ?? Computable.resolve(undefined)).then(() => {
    const doc = serializeResolutionDoc(roots, result, domain.versionToString);
    return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
  });
}
