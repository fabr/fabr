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
  ConflictError,
  MetadataFetchError,
  MultiError,
  RequirementResolutionError,
  ResolutionWalkError,
  toError,
  VersionNotFoundError,
} from "../core/Errors";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { PackageFileSet, PackageGraphBuilder } from "../core/PackageFileSet";
import {
  attributedTo,
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
import { BUILD_OPERATION, FILES_OPERATION } from "../model/Constraints";
import { PackageFormat } from "./PackageFormat";
import { resolveMVS } from "./MVSResolver";
import { allSanctioned, canonicalRequirements, requirementKey, satisfiedByAnySelection, writtenVersions } from "./Overrides";
import { deserializeResolutionDoc, IResolutionDoc, ResolvedRepairs, serializeResolutionDoc } from "./ResolutionDoc";
import { coexistingVersions, edgeBinding, nodeId } from "./ResolutionGraph";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./ResolutionProvenance";
import { completeRepairSet, conflictError, RefRenderer, suggestSanctions, SuggestSources, unrepairableError } from "./ResolutionReport";
import {
  IRequirementEdge,
  MVSResolution,
  Requirement,
  ROOT_REQUIRER,
  Selected,
  VersionDomain,
} from "./Types";

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
  if (isRepositoryReader(source)) {
    return declaredRequirementOf(source.format, ref);
  }
  return source.declaredRequirement?.(ref) ?? Computable.resolve(undefined);
}

/**
 * An already-resolved package made runnable by whatever delivered it — the
 * dispatch behind RepositoryLookup's optional `makeRunnable`: a package
 * registry's answer is pure format convention; a catalog looks its member up
 * and delegates (its own method). The closure the package carries is kept
 * either way — never re-resolved.
 */
export function runnableFrom(source: RefSource, pkg: PackageFileSet): Computable<RunnableFileSet> {
  if (isRepositoryReader(source)) {
    return source.format.makeRunnable(pkg);
  }
  if (source.makeRunnable) {
    return source.makeRunnable(pkg);
  }
  return Computable.reject(new Error(`'${pkg.packageName}' was delivered by a repository that cannot make it runnable`));
}

/** A selection's `pkg@version` node id — the resolver's node-id form, also the
 * id space of the transient edge map a permissive delivery is planned from. */
function selectionId<V, C>(domain: VersionDomain<V, C>, sel: Selected<V>): string {
  return nodeId(domain, sel.pkg, sel.version);
}

/**
 * The resolved dependency edges of a delivery batch: node id → (dependency
 * name → the id of the selection that edge binds to). The name is the one the
 * *requirer* uses — an alias for an aliased dependency.
 */
export type EdgeMap = Map<string, Map<string, string>>;

/**
 * An alias binding one dependency name to two *different packages* cannot
 * install both under that name anywhere the two co-mount, and one of them
 * would silently lose its imports — a conflict, never a pick. Judged over the
 * whole batch's edges, since the consumer's collection point merges the
 * batch's deliveries into one layout. It takes an alias to reach: ordinary
 * edges name their own package.
 */
export function assertNoAliasCollisions<V, C>(
  domain: VersionDomain<V, C>,
  members: Map<string, Selected<V>>,
  edges: EdgeMap
): void {
  const held = new Map<string, Selected<V>>();
  for (const [fromId, deps] of edges) {
    if (!members.has(fromId)) {
      continue;
    }
    for (const [name, toId] of deps) {
      const selection = members.get(toId);
      if (!selection) {
        continue;
      }
      const current = held.get(name);
      if (current === undefined) {
        held.set(name, selection);
      } else if (current.pkg !== selection.pkg) {
        throw attachHelp(
          new ConflictError(
            "packages",
            name,
            { detail: nodeId(domain, current.pkg, current.version) },
            { detail: nodeId(domain, selection.pkg, selection.version) }
          ),
          `'${name}' is a dependency alias (npm:…) for two different packages in one closure, which cannot both be installed ` +
            "under that name — pin one of the requirers to a version that does not alias it"
        );
      }
    }
  }
}

/**
 * The domain's private {@link Resolution}: the joint version selection +
 * reachable tree, the repairs recorded while resolving it (violations, raises,
 * and the fork selections repairing the violations — judged per delivery at
 * materialize), plus the operation it was resolved under (so materialize
 * delivers the same package-vs-runnable shape without a second context read).
 * `selections`/`rootIndex` are empty under the `files` operation, where
 * materialize fetches per-reference.
 */
interface DomainResolution<V> extends Resolution, ResolvedRepairs<V> {
  readonly roots: ResolvedRoot[];
  readonly operation: string;
  /** requirementKey → index into the resolution's roots (the space `reachableFrom` indexes). */
  readonly rootIndex: Map<string, number>;
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
  /* The operation is a property of this collection point, read from the context
   * (the repository is interned per BuildContext, so it reflects the config
   * these references were consumed under). */
  return context.getGlobalString(BUILD_OPERATION).then(operation => {
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
     * in-memory resolution to the strict gate. A package both forced and
     * alternated is contradictory. */
    const alternates = new Map<string, Set<string>>();
    for (const req of requirements) {
      if (req.override === "alternate") {
        const versions = alternates.get(req.pkg) ?? new Set();
        alternates.set(req.pkg, versions.add(req.constraint));
      }
    }
    const contradicted = requirements.find(req => req.override === "force" && alternates.has(req.pkg));
    if (contradicted) {
      const culpable = references.filter((_, index) => requirements[index].pkg === contradicted.pkg);
      throw new RequirementResolutionError(
        culpable,
        new Error(`'${contradicted.pkg}' is both forced ('!') and permitted as an alternate ('?') — pick one`)
      );
    }
    /* Two forces at different versions are equally contradictory — the
     * resolver would have to pick one silently. */
    const forcedAt = new Map<string, string>();
    for (const req of requirements) {
      if (req.override !== "force") {
        continue;
      }
      const existing = forcedAt.get(req.pkg);
      if (existing !== undefined && existing !== req.constraint) {
        const culpable = references.filter((_, index) => requirements[index].pkg === req.pkg);
        throw new RequirementResolutionError(
          culpable,
          new Error(`'${req.pkg}' is forced ('!') at two different versions (${existing}, ${req.constraint}) — pick one`)
        );
      }
      forcedAt.set(req.pkg, req.constraint);
    }
    const roots: ResolvedRoot[] = references.flatMap((reference, index) =>
      requirements[index].override === "alternate" ? [] : [{ reference, name: requirements[index].pkg }]
    );
    if (operation === FILES_OPERATION) {
      return Computable.resolve<DomainResolution<V>>({
        roots,
        operation,
        selections: [],
        rootIndex: new Map(),
        violations: [],
        coerced: [],
        raises: [],
        requirements: new Map(),
        alternates,
      });
    }
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
      .then(repairs => ({ roots, operation, rootIndex, alternates, ...repairs }) satisfies DomainResolution<V>)
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
): Computable<FileSet[]> {
  const { format } = registry;
  const domain = format;
  const resolved = resolution as DomainResolution<V>;
  if (resolved.operation === FILES_OPERATION) {
    return Computable.forAll(
      references.map(reference => attributedTo(reference, () => resolveBarePackage(registry, reference))),
      (...delivered: FileSet[]) => delivered
    );
  }
  const { selections, rootIndex, operation, violations, alternates } = resolved;
  const permissive = options?.resolutionMode === "permissive" || operation === "run";
  const requirements = references.map(reference => format.parseRequirement(reference.name));
  /* An alternate (`?`) reference demands nothing and delivers nothing of its
   * own — the sanctioned fork arrives nested inside the canonical closure. */
  const demanded = requirements.filter(req => req.override !== "alternate");
  const requestedRoots = new Set(demanded.map(req => rootIndex.get(requirementKey(req))!));
  const requestedKeys = new Set(demanded.map(requirementKey));
  /* The selections reachable from the requested roots — the fetch set.
   * Forks are reachable exactly through the violated edges bound to them,
   * so a strict subset whose closure has no violations carries no forks. */
  const needed = selections.filter(sel => sel.reachableFrom?.some(root => requestedRoots.has(root)));
  const reachableIds = new Set(needed.map(sel => selectionId(domain, sel)));
  /* A violation is a property of an *edge*: in scope iff its requirer is in
   * the delivered closure (a root-requirement violation: iff that root is
   * among the requested). Raises are NOT judged here in any mode: a raised
   * floor is the constraint's plain meaning when its literal minimum was
   * never published — the request was for the range, and the first published
   * version meeting it answers the request. Coerced edges are not judged
   * either — suppressing them is what their `!` said to do. */
  const edgeInScope = (requiredBy: string, pkg: string, constraint: string): boolean =>
    requiredBy === ROOT_REQUIRER ? requestedKeys.has(`${pkg}:${constraint}`) : reachableIds.has(requiredBy);
  const scopedViolations = violations.filter(violation => edgeInScope(violation.requiredBy, violation.pkg, violation.constraint));
  const root = [...requestedKeys].sort().join(", ");
  /* The sanction rule is a set comparison: every version of a package this
   * delivery ships must be explicitly written — as a `?`, or as an exact
   * unmarked pin (the catalog form). See resolver/Overrides. */
  const written = writtenVersions(domain, alternates, demanded);
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
    const unrepaired = scopedViolations.filter(violation => !satisfiedByAnySelection(domain, selections, violation));
    if (unrepaired.length > 0) {
      return Computable.reject(unrepairableError(root, unrepaired, selections, domain.versionToString, refText));
    }
    if (!permissive) {
      const outstanding = scopedViolations.filter(violation => !allSanctioned(domain, needed, written, violation.pkg));
      const duplicates = coexistingVersions(needed).filter(([pkg]) => !allSanctioned(domain, needed, written, pkg));
      if (outstanding.length > 0 || duplicates.length > 0) {
        return suggestSanctions(outstanding, resolved, needed, requirements, suggestSourcesFor(context, registry, repositoryAlias(references))).then(suggestion => {
          throw conflictError(root, outstanding, duplicates, needed, domain.versionToString, refText, written, suggestion);
        });
      }
    }
    return Computable.resolve(undefined);
  };
  return judgeRepairs()
    .then(() => {
      /* Sealed (or fully sanctioned): the forks repairing the reachable
       * violations are already in `needed`, nested by the layout plan.
       * Fetch each distinct pkg@version once (an alias may bind two edges
       * to one version — same version ⇒ same tarball ⇒ same content). */
      const delivered = needed;
      const toFetch = new Map<string, Selected<V>>();
      for (const sel of delivered) {
        const id = selectionId(domain, sel);
        if (!toFetch.has(id)) {
          toFetch.set(id, sel);
        }
      }
      const fetchIds = [...toFetch.keys()];
      const fetching = new Set(fetchIds);
      const edges = resolvedEdges(domain, delivered, resolved);
      /* Judged over the whole batch, since the consumer merges its
       * deliveries into one layout. */
      assertNoAliasCollisions(domain, toFetch, edges);
      return Computable.forAll(
        fetchIds.map(id => registry.fetch(toFetch.get(id)!.pkg, toFetch.get(id)!.version)),
        (...fetched: PackageFileSet[]) => {
          const packages = new Map<string, PackageFileSet>(fetchIds.map((id, k) => [id, fetched[k]]));
          const assembled = requirements.map(req =>
            req.override === "alternate"
              ? undefined
              : buildClosure(registry, req, rootIndex.get(requirementKey(req))!, selections, fetching, edges, packages)
          );
          return operation === "run"
            ? Computable.forAll(
                assembled.map(pkg => (pkg === undefined ? Computable.resolve<FileSet>(EMPTY_FILESET) : registry.format.makeRunnable(pkg))),
                (...launched: FileSet[]) => launched
              )
            : Computable.resolve(assembled.map(pkg => pkg ?? EMPTY_FILESET));
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
 * The resolved dependency edges of the delivery — transient planning data,
 * never carried on the delivered values: for every fetched node, each
 * declared requirement resolved to the id of the selection it binds — the
 * principal when it satisfies the range, else the repairing fork (the
 * resolver's own edge rule, {@link edgeBinding}, so a layout cannot disagree
 * with the resolution it came from). Keyed by the name the *requirer* uses,
 * so an aliased dependency is an edge to the aliased package under the
 * alias.
 *
 * The requirements come from the resolution itself (the walk collected them
 * to compute reachability, and they are persisted with it), so the layout of
 * a cached resolution needs no metadata at all — the same edges the walk
 * followed, not a second reading of them.
 */
function resolvedEdges<V, C>(domain: VersionDomain<V, C>, delivered: Selected<V>[], resolved: ResolvedRepairs<V>): EdgeMap {
  const edges: EdgeMap = new Map();
  for (const node of delivered) {
    const fromId = selectionId(domain, node);
    let from = edges.get(fromId);
    if (!from) {
      from = new Map();
      edges.set(fromId, from);
    }
    for (const req of resolved.requirements.get(fromId) ?? []) {
      const name = req.alias ?? req.pkg;
      if (from.has(name)) {
        continue;
      }
      const target = edgeBinding(domain, resolved.selections, req);
      if (target) {
        from.set(name, selectionId(domain, target));
      }
    }
  }
  return edges;
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
  index: number,
  selections: Selected<V>[],
  fetching: ReadonlySet<string>,
  edges: EdgeMap,
  packages: Map<string, PackageFileSet>
): PackageFileSet {
  const domain = registry.format;
  const reachable = selections.filter(sel => sel.reachableFrom?.includes(index));
  /* The delivered root is what the root requirement BINDS to — normally the
   * principal, but a violated root requirement is answered by its fork. */
  const root = edgeBinding(domain, reachable, req);
  if (!root) {
    /* Can't happen: a root requirement is always reachable from itself */
    throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
  }
  const rootId = selectionId(domain, root);
  const origin = resolutionOrigin(registry.format, req, selections);
  const forkIds = new Set(selections.filter(sel => sel.fork !== undefined).map(sel => selectionId(domain, sel)));
  /* Delivery members: the root's reachable slice of the fetched batch — an
   * edge leading outside it (a gated optional pruned from the walk) is
   * simply not carried. */
  const members = new Set<string>();
  for (const sel of reachable) {
    const id = selectionId(domain, sel);
    if (fetching.has(id)) {
      members.add(id);
    }
  }
  const builder = new PackageGraphBuilder();
  const instances = new Map<string, PackageFileSet>();
  const instance = (name: string, id: string): PackageFileSet => {
    const key = `${name}\n${id}`;
    let node = instances.get(key);
    if (!node) {
      const files = packages.get(id)!;
      node = builder.node(files, name, files.version, origin, forkIds.has(id));
      /* Memoized BEFORE wiring, so a cycle lands on the instance under
       * construction instead of recursing forever. */
      instances.set(key, node);
      builder.wire(
        node,
        [...(edges.get(id) ?? [])].filter(([, toId]) => members.has(toId)).map(([depName, toId]) => instance(depName, toId))
      );
    }
    return node;
  };
  const delivered = instance(root.pkg, rootId);
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
 * Deliver a single package's own files, resolved standalone — the `files`
 * operation's delivery (see resolvePackages). A top-level root's minimal-version
 * selection is simply its constraint's lower bound (nothing else constrains
 * it), so this is exactly the version the joint path would give the root, but
 * reached without walking — or fetching — the dependency closure. The result
 * is a bare PackageFileSet (no carried dependencies); any projection stays
 * pending on the delivered ref (RepositoryRef.deliveredAs), finished by the
 * driving context.
 */
function resolveBarePackage<V, C>(registry: RepositoryReader<V, C>, reference: RepositoryRef): Computable<FileSet> {
  const { format } = registry;
  const domain = format;
  const req = format.parseRequirement(reference.name);
  const constraint = domain.parseConstraint(req.constraint);
  if (domain.isFloorless(constraint)) {
    throw new Error(
      `Cannot resolve the files of '${req.pkg}' without a version lower bound ('${req.constraint}'): ` +
        "pin a version or range to project into a package"
    );
  }
  const version = domain.minimumOf(constraint);
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
                `the lowest published version satisfying '${req.constraint}' is ${domain.versionToString(raised)} — ` +
                  `pin '${req.pkg}:${domain.versionToString(raised)}' (a build resolves this automatically via a floor raise)`
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
): Computable<ResolvedRepairs<V>> {
  const { format } = registry;
  return registry.environmentKey().then(environment => {
    return context
      /* Newline-join the roots: a version constraint may contain spaces (a
       * quoted hyphen range, `1.2.3 - 2.3.4`), so a space delimiter isn't
       * obviously injective — a newline can appear in neither a package name
       * nor a constraint, matching how file deps are already newline-separated. */
      .memoize(format.resolutionTag, `${registry.identity} ${environment}\n${rootKeys.join("\n")}`, () => {
        /* A memo miss means real resolution work on behalf of the consumer */
        context.notifyProgress({ kind: "repository-resolve", repository: alias ?? registry.identity, requirements: rootKeys });
        return resolveMVS(roots, format, registry).then(result => {
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
        });
      })
      .then(files => files.readFile(RESOLUTION_FILE))
      .then(data => deserializeResolutionDoc(JSON.parse(data) as IResolutionDoc, format.parseVersion));
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
