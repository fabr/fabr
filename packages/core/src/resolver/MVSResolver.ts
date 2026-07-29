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
import { MetadataFetchError, VersionNotFoundError, toError } from "../core/Errors";
import { edgeTargets, nodeId as idOf } from "./ResolutionGraph";
import {
  IRequirementEdge,
  IResolutionError,
  PackageRegistry,
  RaisedFloor,
  Requirement,
  MVSResolution,
  ROOT_REQUIRER,
  Selected,
  VersionDomain,
  Violation,
} from "./Types";

/**
 * Minimal Version Selection resolver (after Go's MVS): every constraint is
 * interpreted as a lower bound, and each resolution key is resolved to the
 * maximum over all lower bounds declared in the reachable requirement graph.
 *
 * The **requirement graph is the whole demanded closure**: every version any
 * reachable requirement demands is expanded, not merely the ones that improve
 * the current selection (Go's module graph, likewise). This is what makes the
 * result a pure function of the requirement set rather than of metadata
 * arrival order — a demanded version that loses its key still contributes its
 * own requirements' floors, whether it is reached before or after the winner.
 * (Expanding only improving versions would make a superseded package's floors
 * count or not count according to which fetch landed first — and the result is
 * persisted, so a cache flush could then change a build.) Selection is
 * consequently monotone: a max over a set, computed once the walk is quiet.
 * Superseded versions are pruned from the *result* by the post-walk
 * reachability pass, which follows the selected versions only.
 *
 * The result therefore depends only on what the packages in the graph declare,
 * never on what else the repository happens to contain, so it is deterministic
 * without a lockfile (provided published metadata is immutable). Upper bounds
 * are checked after selection; violations are reported in
 * MVSResolution.violations — data, not failure: a strict (linked) consumer
 * turns them into an error at delivery (the deterministic remedy is a
 * user-supplied override, i.e. an additional root requirement, which dominates
 * naturally by the max rule), while a sealed tool delivery repairs them by
 * private splits (see {@link resolveWithRepairs}).
 *
 * The one relaxation of pure lower-bound selection is the **floor raise**:
 * when a declared minimum was never published (the registry rejects it with
 * VersionNotFoundError) and the registry offers `lowestAvailable`, the
 * requirement's contribution is raised to the lowest *published* satisfying
 * version — recorded in MVSResolution.raises when it wins its key.
 *
 * Repairs fire only when no repair-free resolution exists: resolution runs
 * first with repairs disabled, tolerating an unpublished demanded version as
 * an unexpandable pending selection (a transient winner superseded by a higher
 * declared floor never mattered, and must not trigger — or be failed by — a
 * repair). Only if the CONVERGED tree still selects an unpublished version —
 * the proof that the tree is unresolvable without repair — is the walk rerun
 * with the raise hook active. This also makes the outcome independent of visit
 * order (an eagerly-probed transient floor whose range had no published
 * version used to hard-fail resolutions that a later declared floor would have
 * made clean). Without the hook the same tolerance applies, and a live
 * unpublished winner at convergence is the terminal failure.
 *
 * Note: if the registry rejects a metadata fetch (other than a raisable
 * version-not-found), the returned Computable rejects with a
 * MetadataFetchError identifying the failing package and the requirement chain
 * that first reached it (the requirement graph cannot be determined, which is
 * unlike a constraint violation and so is not reported via the result).
 */
export function resolveMVS<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: PackageRegistry<V>
): Computable<MVSResolution<V>> {
  return resolvePhase(roots, domain, registry, false).catch(err => {
    if (err instanceof RepairsRequired) {
      return resolvePhase(roots, domain, registry, true);
    }
    throw err;
  });
}

/** Internal phase-1 signal: the converged tree demands unpublished versions,
 * so no repair-free resolution exists — rerun with repairs enabled. Never
 * escapes resolveMVS. */
class RepairsRequired extends Error {
  constructor() {
    super("resolution requires repairs");
  }
}

/** Lexicographic order on strings, for the canonical orderings a persisted
 * resolution needs (its lists must not carry the walk's arrival order). */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** One requirement's demand for a node: the requirement itself, the resolution
 * key it offered the node under, and who declared it — everything needed to
 * re-offer the demand at a raised floor. */
interface Demand {
  key: string;
  req: Requirement;
  requiredBy: string;
}

function resolvePhase<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: PackageRegistry<V>,
  repair: boolean
): Computable<MVSResolution<V>> {
  return Computable.from((resolve, reject) => {
    /* Highest minimum seen so far, per resolution key */
    const selected = new Map<string, Selected<V>>();
    /* Declared requirements of every pkg@version visited (including superseded ones) */
    const nodeRequirements = new Map<string, Requirement[]>();
    /* First reacher of every visited node (a node id, or ROOT_REQUIRER), for
     * attributing a metadata failure back to a root requirement */
    const nodeParents = new Map<string, string>();
    /* The requirement(s) whose minimum demanded each node — the floor(s) to
     * raise if the node turns out to be unpublished */
    const nodeDemands = new Map<string, Demand[]>();
    /* Nodes the registry reported unpublished, so that a demand arriving after
     * that answer is repaired on the same terms as one that preceded it (the
     * raise must not depend on whether the 404 beat the demand) */
    const notPublished = new Map<string, VersionNotFoundError>();
    /* Raises applied during the walk; filtered to the winners at finish */
    const candidateRaises: RaisedFloor<V>[] = [];
    /* (node, demand) pairs already floor-raised, so a repair is attempted once
     * however often its demand is re-offered (see raiseFloors) */
    const raisedDemands = new Set<string>();
    /* Nodes whose demanded version turned out unpublished, tolerated as
     * unexpandable pending selections outside repair mode: a transient winner
     * a higher declared floor later supersedes never mattered. Judged at
     * convergence — only a still-live winner proves repair is required. */
    const unpublished = new Map<string, { pkg: string; version: V; err: VersionNotFoundError }>();
    /* Soft (peer) requirements deferred to quiescence: each is primarily a
     * constraint on whatever the tree selects; one whose package the converged
     * tree doesn't select at all fires as an ordinary demand (auto-install as
     * last resort). */
    const softReqs: Array<{ req: Requirement; requiredBy: string }> = [];
    const softFired = new Set<{ req: Requirement; requiredBy: string }>();
    const errors = new Map<string, IResolutionError>();

    /** The root package whose subtree contains `requirer` (for attributing an
     * error on one of its requirements): walk the first-reacher parents to the
     * root, as `annotate` does for fetch failures. A ROOT_REQUIRER requirer
     * means the erring requirement is itself a root — it is its own root. */
    const rootPkgOf = (requirer: string, ownPkg: string): string => {
      if (requirer === ROOT_REQUIRER) {
        return ownPkg;
      }
      let rootId = requirer;
      for (let parent = nodeParents.get(rootId); parent && parent !== ROOT_REQUIRER; parent = nodeParents.get(parent)) {
        rootId = parent;
      }
      return rootId.substring(0, rootId.lastIndexOf("@"));
    };
    const violations: Violation<V>[] = [];
    /* Outstanding metadata fetches, plus one guard token held while seeding */
    let pending = 1;
    let failed = false;

    const fail = (err: Error): void => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    };

    const nodeId = (pkg: string, version: V): string => idOf(domain, pkg, version);

    const enqueue = (req: Requirement, requiredBy: string): void => {
      let constraint: C;
      try {
        constraint = domain.parseConstraint(req.constraint);
      } catch {
        /* An unparseable constraint is reported at the reachability walk
         * (followEdge), not here: the fixpoint walk visits superseded/pruned
         * requirements too, and a bad constraint in one that doesn't survive
         * pruning must not fail the whole resolution. followEdge reparses the
         * constraint anyway (deterministically the same error) on exactly the
         * edges that are in effect, so reporting there is both truthful and free. */
        return;
      }
      if (domain.isUnconstrained(constraint)) {
        /* No version preference: contributes no selection of its own, and is
         * satisfied by whatever the constrained requirements select (resolved
         * during finish; an unconstrained-only package is an error there) */
        return;
      }
      if (req.soft) {
        softReqs.push({ req, requiredBy });
        return;
      }
      attempt(domain.resolutionKey(req.pkg, constraint), req, domain.minimumOf(constraint), requiredBy);
    };

    /** Canonical order on requirement edges, for breaking a tie between two
     * requirements demanding the same winning floor: `selectedBy` must be a
     * function of the requirement set, not of which fetch landed first. */
    const edgeOrder = (edge: IRequirementEdge): string => `${edge.requiredBy}\n${edge.constraint}`;

    /** Offer `version` as a lower bound for `key` (a requirement's declared
     * minimum, or its raised floor): it is selected iff it beats the current
     * selection, and expanded either way — a demanded version contributes its
     * own requirements to the graph even when it loses its key (see the Go MVS
     * note above; `visit` dedups, so each pkg@version is fetched once). */
    const attempt = (key: string, req: Requirement, version: V, requiredBy: string): void => {
      const current = selected.get(key);
      const edge: IRequirementEdge = { requiredBy, constraint: req.constraint };
      const order = current === undefined ? 1 : domain.compare(version, current.version);
      if (order > 0 || (order === 0 && current!.selectedBy !== undefined && edgeOrder(edge) < edgeOrder(current!.selectedBy))) {
        selected.set(key, { pkg: req.pkg, version, selectedBy: edge });
      }
      visit(req.pkg, version, requiredBy, { key, req });
    };

    /**
     * The demanded version was never published: raise each of `demands`'
     * contribution to the lowest published version satisfying its constraint
     * (re-offered through the normal max-of-minimums rule). A requirement
     * nothing published satisfies raises nothing, so the node keeps its
     * unpublished declared version unless another demand lifts the key —
     * tolerated here and judged at convergence exactly as in phase 1, since the
     * walk expands superseded versions too and an unrepairable floor on one of
     * those never mattered. A live one at convergence is the terminal failure.
     *
     * Takes the demands to repair rather than reading them off the node,
     * because they arrive on both sides of the registry's answer: the demands
     * known when it lands are repaired together, and each later one is repaired
     * as it arrives. The caller holds a `pending` token for the duration.
     */
    const raiseFloors = (pkg: string, version: V, err: VersionNotFoundError, demands: Demand[]): void => {
      /* Each (node, demand) is raised once. Since the raise is a pure function
       * of the two, re-raising could only repeat itself — and would not
       * terminate if the hook offers a version the registry then rejects in
       * turn (the offer is re-demanded, found already demanded, and repaired
       * again). Termination is otherwise by the finite demand set. */
      const id = nodeId(pkg, version);
      const fresh = demands.filter(demand => {
        const signature = `${id}\n${demand.requiredBy}\n${demand.req.constraint}`;
        if (raisedDemands.has(signature)) {
          return false;
        }
        raisedDemands.add(signature);
        return true;
      });
      Computable.forAll(
        fresh.map(demand =>
          registry.lowestAvailable!(pkg, demand.req.constraint).then(raised => {
            if (raised === undefined) {
              unpublished.set(nodeId(pkg, version), { pkg, version, err });
              return;
            }
            candidateRaises.push({ pkg, constraint: demand.req.constraint, declared: version, raised, requiredBy: demand.requiredBy });
            attempt(demand.key, demand.req, raised, demand.requiredBy);
          })
        ),
        () => {
          if (--pending === 0) {
            settle();
          }
        }
      ).catch(raiseErr => fail(toError(raiseErr)));
    };

    /**
     * The registry's verdict that pkg@version was never published, applied to
     * the demands recorded so far: repaired by floor raises when the phase and
     * registry allow it, else tolerated as an unexpandable pending selection.
     * Consumes the `pending` token the caller holds for the node.
     */
    const nodeNotPublished = (id: string, pkg: string, version: V, err: VersionNotFoundError): void => {
      notPublished.set(id, err);
      if (repair && registry.lowestAvailable) {
        raiseFloors(pkg, version, err, nodeDemands.get(id) ?? []);
        return;
      }
      unpublished.set(id, { pkg, version, err });
      if (--pending === 0) {
        settle();
      }
    };

    /**
     * Attribute a metadata failure to the requirement chain that first reached
     * the failing node: walk the first-reacher parents back to a root. The
     * first reacher may be a later-superseded version — still a truthful
     * "required by" trace, and the only one available if the walk cannot finish.
     */
    const annotate = (id: string, pkg: string, version: V, err: unknown): MetadataFetchError => {
      const path: string[] = [];
      for (let parent = nodeParents.get(id); parent && parent !== ROOT_REQUIRER; parent = nodeParents.get(parent)) {
        path.push(parent);
      }
      const rootId = path.at(-1) ?? id;
      const rootPkg = rootId.substring(0, rootId.lastIndexOf("@"));
      const cause = err instanceof Error ? err : new Error(String(err));
      return new MetadataFetchError(pkg, domain.versionToString(version), path, rootPkg, cause);
    };

    const visit = (pkg: string, version: V, requiredBy: string, demand: { key: string; req: Requirement }): void => {
      const id = nodeId(pkg, version);
      const entry: Demand = { ...demand, requiredBy };
      const demands = nodeDemands.get(id);
      if (demands) {
        /* Metadata already demanded (or resolved); record the demand for raise
         * attribution should the node turn out unpublished — or repair it now
         * if that answer is already in, so a demand is treated the same either
         * side of it. */
        demands.push(entry);
        const known = notPublished.get(id);
        if (known && repair && registry.lowestAvailable) {
          pending++;
          raiseFloors(pkg, version, known, [entry]);
        }
        return;
      }
      nodeDemands.set(id, [entry]);
      nodeRequirements.set(id, []);
      nodeParents.set(id, requiredBy);
      pending++;
      const onMetadataError = (err: unknown): void => {
        if (err instanceof VersionNotFoundError) {
          nodeNotPublished(id, pkg, version, err);
        } else {
          fail(annotate(id, pkg, version, err));
        }
      };
      try {
        registry.getRequirements(pkg, version).then(requirements => {
          nodeRequirements.set(id, requirements);
          for (const req of requirements) {
            enqueue(req, id);
          }
          if (--pending === 0) {
            settle();
          }
        }, onMetadataError);
      } catch (err) {
        /* A registry that throws instead of rejecting gets the same treatment */
        onMetadataError(err);
      }
    };

    /**
     * Quiescence gate: before finishing, fire any deferred soft requirement
     * whose package the tree selects nothing for — as an ordinary demand,
     * stripped of softness — and keep walking. Judged at quiescence so the
     * outcome is a function of the converged state, not of visit order (the
     * same discipline as the repair phases); a fired demand may itself declare
     * more soft requirements, so this repeats until quiet.
     */
    const settle = (): void => {
      if (failed) {
        return;
      }
      const selectedPkgs = new Set([...selected.values()].map(sel => sel.pkg));
      const firing = softReqs.filter(entry => !softFired.has(entry) && !selectedPkgs.has(entry.req.pkg));
      if (firing.length === 0) {
        finish();
        return;
      }
      pending++;
      for (const entry of firing) {
        softFired.add(entry);
        enqueue({ pkg: entry.req.pkg, constraint: entry.req.constraint }, entry.requiredBy);
      }
      if (--pending === 0) {
        settle();
      }
    };

    /**
     * The fixpoint walk visits the requirements of superseded versions too, so
     * once it completes we recompute reachability through the *selected* versions
     * only: this prunes packages dragged in solely by superseded versions, and
     * ensures upper bounds are only validated for requirements actually in effect.
     */
    const finish = (): void => {
      if (failed) {
        return;
      }
      /* The selections of each package, ordered by version — canonical, and
       * NOT `selected`'s insertion order, which follows metadata arrival. The
       * multi-selection cases below iterate this (an unconstrained edge leads
       * to every selection of its package, a peer's to every candidate), so
       * that order sets the reachability walk's queue order, and reaches the
       * result as `reachedVia` attribution and the order of `violations`. It
       * is the last read of `selected` that isn't by key or membership. */
      const selectionsByPkg = new Map<string, Selected<V>[]>();
      for (const selection of selected.values()) {
        selectionsByPkg.set(selection.pkg, [...(selectionsByPkg.get(selection.pkg) ?? []), selection]);
      }
      for (const ofPkg of selectionsByPkg.values()) {
        ofPkg.sort((a, b) => domain.compare(a.version, b.version));
      }

      /* Where each edge leads, by the shared rule (see edgeTargets) — the same
       * one a consumer lays the result out by, over each package's selections
       * in the canonical order established above. */
      const targetsOf = (req: Requirement): Selected<V>[] => edgeTargets(domain, selectionsByPkg.get(req.pkg) ?? [], req);

      /* Reachable selections, each annotated (as a copy) with how it was
       * first reached; keyed by the underlying selection instance since an
       * unconstrained edge has no resolution key of its own */
      const reachable = new Map<Selected<V>, Selected<V>>();
      const visited = new Set<string>();
      const queue: Array<{ from: string; requirements: Requirement[] }> = [{ from: ROOT_REQUIRER, requirements: roots }];

      const followEdge = (from: string, req: Requirement): void => {
        let constraint: C;
        try {
          constraint = domain.parseConstraint(req.constraint);
        } catch (err) {
          /* An unparseable constraint on an edge that is actually in effect
           * (reachable through selected versions): report it here, where
           * pruning has already dropped superseded/unreachable requirements. */
          const message = `${err instanceof Error ? err.message : err} in requirement '${req.pkg}: ${req.constraint}' (required by ${from})`;
          errors.set(message, { message, rootPkg: rootPkgOf(from, req.pkg) });
          return;
        }
        const targets = targetsOf(req);
        if (targets.length === 0 && domain.isUnconstrained(constraint)) {
          const message =
            `'${req.pkg}' is required by ${from} without a version constraint ('${req.constraint}'),` +
            ` and no versioned requirement for it exists — add one explicitly`;
          errors.set(message, { message, rootPkg: rootPkgOf(from, req.pkg) });
          return;
        }
        for (const selection of targets) {
          if (!domain.satisfies(selection.version, constraint)) {
            violations.push({ pkg: selection.pkg, constraint: req.constraint, requiredBy: from, selected: selection.version });
          }
          if (!reachable.has(selection)) {
            reachable.set(selection, { ...selection, reachedVia: { requiredBy: from, constraint: req.constraint } });
            const id = nodeId(selection.pkg, selection.version);
            if (!visited.has(id)) {
              visited.add(id);
              queue.push({ from: id, requirements: nodeRequirements.get(id) ?? [] });
            }
          }
        }
      };

      let entry: { from: string; requirements: Requirement[] } | undefined;
      while ((entry = queue.shift())) {
        for (const req of entry.requirements) {
          followEdge(entry.from, req);
        }
      }

      /* Mark, for each root, which selections it (transitively) reaches */
      roots.forEach((root, rootIndex) => {
        const visitedNodes = new Set<string>();
        const visit = (requirements: Requirement[]): void => {
          for (const req of requirements) {
            for (const target of targetsOf(req)) {
              const selection = reachable.get(target);
              if (!selection) {
                continue;
              }
              const from = (selection.reachableFrom ??= []);
              if (!from.includes(rootIndex)) {
                from.push(rootIndex);
              }
              const id = nodeId(selection.pkg, selection.version);
              if (!visitedNodes.has(id)) {
                visitedNodes.add(id);
                visit(nodeRequirements.get(id) ?? []);
              }
            }
          }
        };
        visit([root]);
      });

      const selections = [...reachable.values()].sort((a, b) => {
        if (a.pkg !== b.pkg) {
          return a.pkg < b.pkg ? -1 : 1;
        }
        return domain.compare(a.version, b.version);
      });
      /* Convergence judgment on tolerated unpublished versions: one still a
       * live (reachable) winner means the tree is unresolvable without repair —
       * trigger the repair phase when the registry offers one, else fail with
       * the usual metadata attribution. Superseded/pruned entries never
       * mattered and are dropped silently. In the repair phase the raise hook
       * has already had its turn (a live entry there is one nothing published
       * satisfies), so the failure is terminal rather than a second signal.
       * Ordered by node id so the reported failure doesn't depend on which
       * metadata answer landed first. */
      const liveUnpublished = [...unpublished.entries()]
        .filter(([id]) => selections.some(sel => nodeId(sel.pkg, sel.version) === id))
        .sort(([a], [b]) => compareText(a, b));
      if (liveUnpublished.length > 0) {
        const [id, info] = liveUnpublished[0];
        fail(!repair && registry.lowestAvailable ? new RepairsRequired() : annotate(id, info.pkg, info.version, info.err));
        return;
      }
      /* Keep only the raises that shaped the result: the raised version must
       * have won its key AND be reachable (a raise superseded by a higher
       * floor, or pruned with a superseded subtree, never mattered) — then
       * dedup identical (pkg, constraint) raises from parallel demands, in a
       * canonical order (they are pushed as the registry answers). */
      const raiseKeys = new Set<string>();
      const ordered = [...candidateRaises].sort(
        (a, b) => compareText(a.pkg, b.pkg) || compareText(a.constraint, b.constraint) || compareText(a.requiredBy, b.requiredBy)
      );
      const raises = ordered.filter(raise => {
        const winner = selections.some(sel => sel.pkg === raise.pkg && domain.compare(sel.version, raise.raised) === 0);
        const dedup = `${raise.pkg}\n${raise.constraint}`;
        if (!winner || raiseKeys.has(dedup)) {
          return false;
        }
        raiseKeys.add(dedup);
        return true;
      });
      resolve({ selections, errors: [...errors.values()], violations, raises });
    };

    for (const root of roots) {
      enqueue(root, ROOT_REQUIRER);
    }
    if (--pending === 0) {
      settle();
    }
  });
}

/**
 * A private subtree repairing one violated requirement: the violated
 * `constraint` on `pkg` resolved standalone (its own MVS tree, floor raises
 * included), exactly what that requirement would get in isolation —
 * self-consistent by construction, deduplicated by (pkg, constraint) across
 * every requirer and every level. Its root selection is the subtree's own
 * selection of `pkg`.
 */
export interface SplitResolution<V> {
  pkg: string;
  constraint: string;
  tree: MVSResolution<V>;
}

/** A joint resolution together with the private splits repairing its (and,
 * recursively, their) violations — the loose-resolution result a sealed tool
 * delivery consumes and a strict delivery judges. */
export interface RepairableResolution<V> {
  tree: MVSResolution<V>;
  splits: SplitResolution<V>[];
}

/**
 * Resolve with **conflict splits**: run the joint MVS resolution, then give
 * every violated requirement edge a private standalone subtree, iterating over
 * the subtrees' own violations to a fixpoint. Splits are deduplicated globally
 * by (pkg, constraint) — a finite set given finite metadata, so the iteration
 * terminates. Violations remain listed on their trees (they attribute the
 * requirer); a consumer maps a violated edge to its split by (pkg, constraint).
 * Errors on any tree (unparseable constraints, unconstrained-only
 * requirements) remain that tree's hard errors — the caller aggregates.
 */
export function resolveWithRepairs<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: PackageRegistry<V>
): Computable<RepairableResolution<V>> {
  const splits = new Map<string, SplitResolution<V>>();
  const keyOf = (pkg: string, constraint: string): string => `${pkg}\n${constraint}`;
  const expand = (violations: Violation<V>[]): Computable<undefined> => {
    const fresh = new Map<string, Violation<V>>();
    for (const violation of violations) {
      const key = keyOf(violation.pkg, violation.constraint);
      if (!splits.has(key) && !fresh.has(key)) {
        fresh.set(key, violation);
      }
    }
    if (fresh.size === 0) {
      return Computable.resolve(undefined);
    }
    return Computable.forAll(
      [...fresh.values()].map(violation =>
        resolveMVS([{ pkg: violation.pkg, constraint: violation.constraint }], domain, registry).then(tree => {
          splits.set(keyOf(violation.pkg, violation.constraint), { pkg: violation.pkg, constraint: violation.constraint, tree });
          return tree.violations;
        })
      ),
      (...nested: Violation<V>[][]) => nested.flat()
    ).then(expand);
  };
  return resolveMVS(roots, domain, registry).then(tree =>
    /* Canonically ordered, not insertion-ordered: the splits are filled in as
     * their subtrees resolve, and the order is both persisted and load-bearing
     * (a consumer resolving edges takes the first scope that claims a shared
     * version). */
    expand(tree.violations).then(() => ({
      tree,
      splits: [...splits.values()].sort((a, b) => compareText(a.pkg, b.pkg) || compareText(a.constraint, b.constraint)),
    }))
  );
}
