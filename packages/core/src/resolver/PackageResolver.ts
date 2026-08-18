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
  attachHelp,
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
import { PackageFileSet, PackageGraphBuilder } from "../core/PackageFileSet";
import {
  isRepositoryReader,
  MaterializeOptions,
  RefSource,
  RepositoryReader,
  ResolutionContext,
  RepositoryRef,
  Resolution,
  ResolvedRoot,
} from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { PackageFormat } from "./PackageFormat";
import { resolveMVS } from "./MVSResolver";
import {
  allSanctioned,
  canonicalRequirements,
  collectSanctions,
  requirementKey,
  satisfiedByAnySelection,
  writtenVersions,
} from "./Overrides";
import { deserializeResolutionDoc, IResolutionDoc, serializeResolutionDoc } from "./ResolutionDoc";
import { coexistingVersions, ResolutionGraph } from "./ResolutionGraph";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./ResolutionProvenance";
import { completeRepairSet, conflictError, RefRenderer, suggestSanctions, SuggestSources, unrepairableError } from "./ResolutionReport";
import { IRequirementEdge, MVSResolution, Requirement, ROOT_REQUIRER, Selected } from "./Types";

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
  const { requirement, projection } = format.splitReference(name);
  const ref = new RepositoryRef(source, requirement);
  return projection ? ref.find(projection.pattern, projection.prefix) : ref;
}

/** The requirement a reference declares, read straight off its own `name:version`
 *  — the full requirement parse, so a manifest records the declared constraint
 *  with any override marker stripped (a marker is resolution advice, never part
 *  of the constraint), and a versionless or malformed reference rejects with
 *  the same message resolution gives it. */
export function declaredRequirementOf<V, C>(format: PackageFormat<V, C>, ref: RepositoryRef): Computable<Requirement | undefined> {
  try {
    return Computable.resolve(format.parseRequirement(ref.name));
  } catch (err) {
    return Computable.reject(toError(err));
  }
}

/**
 * The declared requirement of `ref` as its SOURCE answers it — the dispatch
 * behind RepositoryLookup's optional `declaredRequirement`: a package
 * registry's answer is pure written-form parsing, taken from its format; a
 * repository with its own member table (a catalog) implements the method; a
 * repository with nothing to record implements neither, which IS the answer.
 */
export function declaredRequirementFrom(source: RefSource, ref: RepositoryRef): Computable<Requirement | undefined> {
  const declared = isRepositoryReader(source)
    ? declaredRequirementOf(source.format, ref)
    : (source.declaredRequirement?.(ref) ?? Computable.resolve(undefined));
  /* A rename written HERE is the name this requirer knows the package by (its
   * own code imports it under that name), so it is recorded as the requirement's
   * alias — the fact belongs to the written reference, which is why it is read
   * here rather than inside a format's identity parse. A source answering for
   * itself (a catalog, whose member address is a name of its own) has already
   * said what it is known by; only a rename at the use site outranks that. */
  return declared.then(requirement => (requirement === undefined ? undefined : aliasedAs(requirement, ref.name.getRenameTo()?.toString())));
}

/**
 * A declared requirement as known by `name` — the local name its requirer
 * imports it under, recorded as {@link Requirement.alias} so a generated
 * manifest can state it (npm: `"typescript-6": "npm:typescript@6.0.0-beta"`).
 * A name matching the package's own renames nothing, and neither does none.
 */
export function aliasedAs(requirement: Requirement, name: string | undefined): Requirement {
  return name === undefined || name === requirement.pkg ? requirement : { ...requirement, alias: name };
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
  return Computable.reject(new Error(`'${pkg.packageName}' was delivered by a repository that cannot make it runnable`));
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
  /** The loaded resolution itself. */
  readonly graph: ResolutionGraph<V>;
  /**
   * The `?` sanctions written in this collection's references: pkg → the exact
   * versions whose forks a strict delivery may accept (nested). Judgment-time
   * data carried OUTSIDE the persisted doc (the resolution outcome does not
   * depend on it, so neither does the memo key).
   */
  readonly alternates: ReadonlyMap<string, ReadonlySet<string>>;
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
  references: RepositoryRef[]
): Computable<Resolution> {
  const { format } = registry;
  /* No operation here, by construction: a resolution is a function of the
   * requirements alone, and what varies by operation is the SHAPE of the
   * delivery, decided by the repository in its own `deliver`. That is also why
   * the memo key has never carried the operation — build and run always shared
   * one resolution, and the field only existed to be carried back out to
   * materialize. */
  return Computable.resolve(undefined).then(() => {
    const requirements = references.map(reference => {
      try {
        return format.parseRequirement(reference.name);
      } catch (err) {
        throw new RequirementResolutionError([reference], toError(err));
      }
    });
    /* Alternates (`?`) are judgment-time sanctions, not demands: they join
     * neither the roots (a catalog's member table must not see them) nor the
     * resolution memo (the outcome is unchanged by them) — they ride the
     * in-memory resolution to the strict gate. Contradictory markers are
     * attributed to the written references that carry them. */
    const alternates = collectSanctions(format, requirements, (pkg, message): never => {
      throw new RequirementResolutionError(
        references.filter((_, index) => requirements[index].pkg === pkg),
        new Error(message)
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
        : [{ reference, name: reference.name.getRenameTo()?.toString() ?? requirements[index].pkg }]
    );
    /* Canonicalize the roots so the resolution (and its memo key, and the
     * reachableFrom indices) are independent of reference order. Alternates
     * ARE included: attach-last means a `?` can supply a floorless-only
     * package's version, so it is part of the resolution's identity (its
     * key carries the marker). It still joins neither `roots` above (a
     * catalog's member table must not see it) nor a delivery (it mounts
     * nothing of its own). */
    const { roots: rootReqs, keys: rootKeys } = canonicalRequirements(requirements);
    const rootIndex = new Map<string, number>(rootKeys.map((key, index) => [key, index]));
    return getJointResolution(context, registry, repositoryAlias(references), rootReqs, rootKeys)
      .then(graph => ({ roots, rootIndex, alternates, graph }) satisfies DomainResolution<V>)
      .catch(err => attributeResolutionFailure(err, references, requirements));
  });
}

/**
 * Phase 2 — fetch + assemble the requested references (a subset of `resolution`).
 * Only the closure reachable from the requested roots is fetched, from the
 * pre-resolved tree — so a subset materialization keeps the joint pin. The
 * operation (captured in the resolution) decides the shape: run → each root
 * becomes a runnable, otherwise the plain packages.
 *
 * Enforcement of resolution repairs happens here, per delivery: a
 * **permissive** delivery (`options.resolutionMode`, or run — a runnable is
 * a sealed install by invariant) accepts the repaired closure, whose fork
 * selections the layout nests privately under their requirers; a strict
 * (linked) delivery with any repair in its reachable closure fails with the
 * repairs and their remedies. A violation nothing in the resolution
 * satisfies has no repairing fork and fails in EVERY mode — no delivery can
 * honor the constraint.
 */
export function materializePackages<V, C>(
  context: ResolutionContext,
  registry: RepositoryReader<V, C>,
  references: RepositoryRef[],
  resolution: Resolution,
  options?: MaterializeOptions
): Computable<(PackageFileSet | undefined)[]> {
  const { format } = registry;
  const resolved = resolution as DomainResolution<V>;
  const { rootIndex, alternates, graph } = resolved;
  /* Permissiveness is the CONSUMER's judgment, passed in: a sealed install (every
   * run-op rule, a catalog's run delivery) says so explicitly. */
  const permissive = options?.resolutionMode === "permissive";
  const requirements = references.map(reference => format.parseRequirement(reference.name));
  /* An alternate (`?`) reference demands nothing and delivers nothing of its
   * own — the sanctioned fork arrives nested inside the canonical closure. */
  const demanded = requirements.filter(req => req.override !== "alternate");
  const requestedKeys = new Set(demanded.map(requirementKey));
  /* What a root requirement BINDS to — normally the principal, but a violated
   * root requirement is answered by its fork. The resolution decided this when
   * it was computed, scoped to what that root reaches, so another root's fork
   * cannot answer here. */
  const bindingOf = (req: Requirement): Selected<V> | undefined => graph.rootBinding(rootIndex.get(requirementKey(req))!);
  /* The selections reachable from the requested roots — the fetch set.
   * Forks are reachable exactly through the violated edges bound to them,
   * so a strict subset whose closure has no violations carries no forks.
   *
   * Walked forward over the resolution's own edges, so this costs the SUBSET
   * rather than the whole resolution: `reachableFrom` indexes the other way
   * (which roots reach a node), and consulting it would scan every selection
   * on every delivery, however few packages the delivery names. */
  const seeds = new Set(
    demanded
      .map(bindingOf)
      .filter((sel): sel is Selected<V> => sel !== undefined)
      .map(sel => graph.id(sel))
  );
  const reachableIds = graph.reachable(seeds);
  /* Back to the resolution's canonical order — the walk reaches nodes in edge
   * order, and everything downstream that reports on the delivery must read
   * the same way whichever root led to a node first. */
  const needed = graph.nodesOf(reachableIds);
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
    ...graph.violationsOf(ROOT_REQUIRER).filter(violation => requestedKeys.has(requirementKey(violation))),
    ...[...reachableIds].flatMap(id => graph.violationsOf(id)),
  ];
  const root = [...requestedKeys].sort().join(", ");
  /* The sanction rule is a set comparison: every version of a package this
   * delivery ships must be explicitly written — as a `?`, or as an exact
   * unmarked pin (the catalog form). See resolver/Overrides. */
  const written = writtenVersions(format, alternates, demanded);
  const refText = refTextFor(references, registry);
  /* Judge the repairs first: the verdict is decided by the resolution alone
   * (no content, and — since the resolution carries its own edges — no
   * metadata), so a closure that cannot be delivered says so before anything
   * is downloaded. Rejects rather than throws — materialize may be entered
   * synchronously, outside any chain that would capture a throw. A failing
   * strict delivery computes its fix suggestions (registry reads) before
   * rejecting. */
  const judgeRepairs = (): Computable<void> => {
    /* A violated edge with NO repairing fork — nothing published
     * satisfies it — cannot be accepted in ANY mode, so it is judged
     * first: the strict error's remedies would be false advice for it. */
    /* Only selections of the violated package can satisfy it, so the question
     * is asked of that package's candidates rather than of every selection. */
    const unrepaired = scopedViolations.filter(
      violation => !satisfiedByAnySelection(format, graph.selectionsOf(violation.pkg), violation)
    );
    if (unrepaired.length > 0) {
      return Computable.reject(unrepairableError(root, unrepaired, graph, refText));
    }
    if (!permissive) {
      const outstanding = scopedViolations.filter(violation => !allSanctioned(format, needed, written, violation.pkg));
      const duplicates = coexistingVersions(needed).filter(([pkg]) => !allSanctioned(format, needed, written, pkg));
      if (outstanding.length > 0 || duplicates.length > 0) {
        return suggestSanctions(outstanding, graph, needed, requirements, suggestSourcesFor(context, registry, repositoryAlias(references))).then(suggestion => {
          throw conflictError(root, outstanding, duplicates, needed, graph, refText, written, suggestion);
        });
      }
    }
    return Computable.resolve(undefined);
  };
  return judgeRepairs()
    .then(() => {
      /* Sealed (or fully sanctioned): the forks repairing the reachable
       * violations are already in `needed`, nested by the layout plan. One
       * fetch per member — ids are distinct by construction, and an alias
       * binding two edges to one version is one id (one tarball, shared). */
      const toFetch = new Map(needed.map(sel => [graph.id(sel), sel] as const));
      const fetchIds = [...toFetch.keys()];
      /* Judged over the whole batch, since the consumer merges its
       * deliveries into one layout. */
      graph.assertNoAliasCollisions(toFetch);
      return Computable.forAll(
        fetchIds.map(id => registry.fetch(toFetch.get(id)!.pkg, toFetch.get(id)!.version)),
        (...fetched: PackageFileSet[]) => {
          const packages = new Map<string, PackageFileSet>(fetchIds.map((id, k) => [id, fetched[k]]));
          const assembled = requirements.map(req => {
            if (req.override === "alternate") {
              return undefined;
            }
            const bound = bindingOf(req);
            if (!bound) {
              /* Can't happen: a root requirement is always reachable from itself */
              throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
            }
            return buildClosure(registry, req, bound, graph, packages);
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
 * suggestions — rendered with the alias the references were written against
 * (a suggestion must read exactly as the user would write it here; the
 * registry's own identity — a url — is the fallback when no reference
 * carries one, e.g. programmatic use). */
function refTextFor(references: RepositoryRef[], registry: { identity: string }): RefRenderer {
  const name = repositoryAlias(references) ?? registry.identity;
  return (pkg, versionText, marker) => `${name}:${pkg}:${versionText}${marker ?? ""}`;
}

/** The declared alias the batch's references were written against (they share
 * a source, so the first stamped one speaks for the batch). */
function repositoryAlias(references: RepositoryRef[]): string | undefined {
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
  const culpableFor = (rootPkg: string): RepositoryRef[] => references.filter((_, index) => requirements[index].pkg === rootPkg);
  if (err instanceof MetadataFetchError) {
    const culpable = culpableFor(err.rootPkg);
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
        const culpable = culpableFor(failure.rootPkg);
        const cause = new Error(failure.message);
        const wrapped = culpable.length > 0 ? new RequirementResolutionError(culpable, cause) : cause;
        return failure.help ? attachHelp(wrapped, failure.help) : wrapped;
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
 * from these complete facts at the merge that needs them — which is what
 * lets one delivery's member survive a merge with a sibling delivery
 * unharmed (see DESIGN-package-placement.md).
 *
 * The graph may be cyclic (mutual same-version deps are ordinary npm), so
 * it is constructed through a {@link PackageGraphBuilder}, each instance
 * memoized before its edges wire. An instance exists per (name, selection):
 * an aliased edge binds a restamped instance carrying the requirer's name
 * for the package — `wrap-ansi` delivered as `wrap-ansi-cjs` IS a package
 * of that name as far as any install is concerned, content shared. A fork
 * selection's instances are flagged {@link PackageFileSet.isNestedOverride}
 * wherever they appear — including as a delivered root, since a root
 * answered by a fork must not claim a flat slot in a merged store (only the
 * resolution can say so; position cannot).
 */
function buildClosure<V, C>(
  registry: RepositoryReader<V, C>,
  req: Requirement,
  root: Selected<V>,
  graph: ResolutionGraph<V>,
  packages: Map<string, PackageFileSet>
): PackageFileSet {
  const rootId = graph.id(root);
  const origin = resolutionOrigin(registry.format, req, graph.selections);
  /* A worklist over the graph, in the builder's own two-phase shape: discover
   * each delivered (name, id) instance from the root, then wire its edges once
   * its targets exist. Discovery IS the membership walk — everything reached
   * from the root is delivered, and an edge leading outside the fetched batch
   * (a gated optional pruned from the walk, hence not in `packages`) is simply
   * not carried. An instance exists per (name, id): an aliased edge binds a
   * restamped instance carrying the requirer's name for the package. */
  const builder = new PackageGraphBuilder();
  const instances = new Map<string, PackageFileSet>();
  const pending: Array<[string, PackageFileSet]> = [];
  const instance = (name: string, id: string): PackageFileSet => {
    const key = `${name}\n${id}`;
    let node = instances.get(key);
    if (!node) {
      const files = packages.get(id)!;
      node = builder.node(files, name, files.version, origin, graph.isFork(id));
      instances.set(key, node);
      pending.push([id, node]);
    }
    return node;
  };
  const delivered = instance(root.pkg, rootId);
  while (pending.length > 0) {
    const [id, node] = pending.pop()!;
    builder.wire(
      node,
      [...graph.edgesOf(id)].filter(([, toId]) => packages.has(toId)).map(([depName, toId]) => instance(depName, toId))
    );
  }
  builder.seal();
  return delivered;
}

/** The provenance origin of a delivered closure: the root requirement and the
 * selections that answer "why is this package here / why this version". It
 * carries no registry identity — "who provided this" is answered by following
 * the chain to the written reference and the declaration it names. */
function resolutionOrigin<V, C>(format: PackageFormat<V, C>, req: Requirement, selections: Selected<V>[]): IResolutionOrigin<V> {
  return {
    kind: PACKAGE_RESOLUTION_PROVENANCE,
    root: req,
    selections,
    versionToString: format.versionToString,
  };
}

/**
 * A package's own files, with no dependency closure and no joint resolution —
 * what BUILD_OPERATION=files asks for. A top-level root's minimal-version
 * selection is simply its constraint's lower bound (nothing else constrains
 * it), so this is exactly the version the joint path would give the root,
 * reached without walking — or fetching — the closure; any projection stays
 * pending on the delivered ref (RepositoryRef.deliveredAs), finished by the
 * driving context. Exported because a repository decides its own delivery
 * shapes but this is resolver machinery: it mints the `Selected` and the
 * resolution provenance a delivered package carries.
 */
export function resolveBarePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<FileSet> {
  const { format } = registry;
  const req = format.parseRequirement(reference.name);
  const constraint = format.parseConstraint(req.constraint);
  if (format.isFloorless(constraint)) {
    throw new Error(
      `Cannot resolve the files of '${req.pkg}' without a version lower bound ('${req.constraint}'): ` +
        "pin a version or range to project into a package"
    );
  }
  const version = format.minimumOf(constraint);
  const edge: IRequirementEdge = { requiredBy: ROOT_REQUIRER, constraint: req.constraint };
  const selection: Selected<V> = { pkg: req.pkg, version, selectedBy: edge, reachedVia: edge, reachableFrom: [0] };
  const origin = resolutionOrigin(format, req, [selection]);
  return registry
    .fetch(req.pkg, version)
    .then(pkg => new PackageFileSet(pkg, pkg.packageName, pkg.version, [], origin))
    .catch(err => {
      /* The written minimum was never published. The joint (build/test) path
       * would floor-raise here; the standalone files path stays exact by
       * design, but the error should name the raise the build would take. */
      if (err instanceof VersionNotFoundError) {
        const raise = registry.lowestAvailable
          ? registry.lowestAvailable(req.pkg, req.constraint)
          : Computable.resolve<V | undefined>(undefined);
        return raise.then(raised => {
          throw raised
            ? attachHelp(
                err,
                `the lowest published version satisfying '${req.constraint}' is ${format.versionToString(raised)} — ` +
                  `pin '${req.pkg}:${format.versionToString(raised)}' (a build resolves this automatically via a floor raise)`
              )
            : err;
        });
      }
      throw err;
    });
}

/**
 * What the generic repair suggester needs from the domain (see
 * resolver/ResolutionReport): the written reference form, the registry's
 * version list, and a memoized enrichment-free re-resolve.
 */
function suggestSourcesFor<V, C>(context: ResolutionContext, registry: RepositoryReader<V, C>, alias: string | undefined): SuggestSources<V, C> {
  return {
    domain: registry.format,
    refText: (pkg, versionText, marker) => `${alias ?? registry.identity}:${pkg}:${versionText}${marker ?? ""}`,
    availableVersions: pkg => registry.availableVersions?.(pkg) ?? Computable.resolve(undefined),
    resolve: roots =>
      getJointResolution(
        context,
        registry,
        alias,
        roots,
        roots.map(req => requirementKey(req)),
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
  alias: string | undefined,
  roots: Requirement[],
  rootKeys: string[],
  enrich = true
): Computable<ResolutionGraph<V>> {
  const { format } = registry;
  return registry.environmentKey().then(environment => {
    return context
      /* Newline-join the roots: a version constraint may contain spaces (a
       * quoted hyphen range, `1.2.3 - 2.3.4`), so a space delimiter isn't
       * obviously injective — a newline can appear in neither a package name
       * nor a constraint, matching how file deps are already newline-separated. */
      .memoize(format.resolutionTag, `${registry.identity} ${environment}\n${rootKeys.join("\n")}`, () =>
        /* A memo miss means real resolution work on behalf of the consumer —
         * tracked, so the metadata reads it fans out are attributable to a
         * resolution still in flight rather than appearing on their own. */
        context.runTask(
          { kind: "repository-resolve", repository: alias ?? registry.identity, consumer: context.name, requirements: rootKeys },
          () =>
            resolveMVS(roots, format, registry).then(result => {
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
                return completeRepairSet(result.errors, roots, suggestSourcesFor(context, registry, alias)).then(failures => {
                  throw new ResolutionWalkError(failures);
                });
              }
              return validatedResolutionDoc(registry, roots, result);
            })
        )
      )
      .then(files => files.readFile(RESOLUTION_FILE))
      .then(data => deserializeResolutionDoc(JSON.parse(data) as IResolutionDoc, format));
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
  result: MVSResolution<V>
): Computable<FileSet> {
  return (registry.validateSelections?.(result.selections) ?? Computable.resolve(undefined)).then(() => {
    const doc = serializeResolutionDoc(roots, result, registry.format.versionToString);
    return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
  });
}
