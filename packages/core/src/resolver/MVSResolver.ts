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
import { PackageRegistry, RaisedFloor, Requirement, MVSResolution, ROOT_REQUIRER, Selected, VersionDomain, Violation } from "./Types";

/**
 * Minimal Version Selection resolver (after Go's MVS): every constraint is
 * interpreted as a lower bound, and each resolution key is resolved to the
 * maximum over all lower bounds declared in the reachable requirement graph.
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
 * version — recorded in MVSResolution.raises when it wins its key. Without the
 * hook, an unpublished floor fails as before.
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
    const nodeDemands = new Map<string, Array<{ key: string; req: Requirement; requiredBy: string }>>();
    /* Raises applied during the walk; filtered to the winners at finish */
    const candidateRaises: RaisedFloor<V>[] = [];
    const errors = new Set<string>();
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

    const nodeId = (pkg: string, version: V): string => `${pkg}@${domain.versionToString(version)}`;

    const enqueue = (req: Requirement, requiredBy: string): void => {
      let constraint: C;
      try {
        constraint = domain.parseConstraint(req.constraint);
      } catch (err) {
        errors.add(`${err instanceof Error ? err.message : err} (required by ${requiredBy})`);
        return;
      }
      if (domain.isUnconstrained(constraint)) {
        /* No version preference: contributes no selection of its own, and is
         * satisfied by whatever the constrained requirements select (resolved
         * during finish; an unconstrained-only package is an error there) */
        return;
      }
      attempt(domain.resolutionKey(req.pkg, constraint), req, domain.minimumOf(constraint), requiredBy);
    };

    /** Offer `version` as a lower bound for `key` (a requirement's declared
     * minimum, or its raised floor): selected and visited iff it beats the
     * current selection. */
    const attempt = (key: string, req: Requirement, version: V, requiredBy: string): void => {
      const current = selected.get(key);
      if (!current || domain.compare(version, current.version) > 0) {
        selected.set(key, { pkg: req.pkg, version, selectedBy: { requiredBy, constraint: req.constraint } });
        visit(req.pkg, version, requiredBy, { key, req });
      }
    };

    /**
     * The demanded version was never published: raise each demanding
     * requirement's contribution to the lowest published version satisfying
     * its constraint (re-offered through the normal max-of-minimums rule); a
     * requirement nothing published satisfies is a genuine failure, as is the
     * whole node when the registry offers no raise hook.
     */
    const raiseFloors = (id: string, pkg: string, version: V, err: VersionNotFoundError): void => {
      const demands = nodeDemands.get(id) ?? [];
      Computable.forAll(
        demands.map(demand =>
          registry.lowestAvailable!(pkg, demand.req.constraint).then(raised => {
            if (raised === undefined) {
              throw annotate(id, pkg, version, err);
            }
            candidateRaises.push({ pkg, constraint: demand.req.constraint, declared: version, raised, requiredBy: demand.requiredBy });
            attempt(demand.key, demand.req, raised, demand.requiredBy);
          })
        ),
        () => {
          if (--pending === 0) {
            finish();
          }
        }
      ).catch(raiseErr => fail(toError(raiseErr)));
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
      const demands = nodeDemands.get(id);
      if (demands) {
        /* Metadata already demanded (or resolved); just record the demand for
         * raise attribution should the node turn out unpublished. */
        demands.push({ ...demand, requiredBy });
        return;
      }
      nodeDemands.set(id, [{ ...demand, requiredBy }]);
      nodeRequirements.set(id, []);
      nodeParents.set(id, requiredBy);
      pending++;
      try {
        registry.getRequirements(pkg, version).then(
          requirements => {
            nodeRequirements.set(id, requirements);
            for (const req of requirements) {
              enqueue(req, id);
            }
            if (--pending === 0) {
              finish();
            }
          },
          err => {
            if (err instanceof VersionNotFoundError && registry.lowestAvailable) {
              raiseFloors(id, pkg, version, err);
            } else {
              fail(annotate(id, pkg, version, err));
            }
          }
        );
      } catch (err) {
        /* A registry that throws instead of rejecting gets the same treatment */
        if (err instanceof VersionNotFoundError && registry.lowestAvailable) {
          raiseFloors(id, pkg, version, err);
        } else {
          fail(annotate(id, pkg, version, err));
        }
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
      const selectionsByPkg = new Map<string, Selected<V>[]>();
      for (const selection of selected.values()) {
        selectionsByPkg.set(selection.pkg, [...(selectionsByPkg.get(selection.pkg) ?? []), selection]);
      }

      /**
       * The selections a requirement edge leads to: the (single) selection
       * under its resolution key, or — for an unconstrained requirement —
       * every selection of the package, since it is satisfied by any of them.
       */
      const targetsOf = (req: Requirement): Selected<V>[] => {
        let constraint: C;
        try {
          constraint = domain.parseConstraint(req.constraint);
        } catch {
          return []; /* Already reported during the walk */
        }
        if (domain.isUnconstrained(constraint)) {
          return selectionsByPkg.get(req.pkg) ?? [];
        }
        return [selected.get(domain.resolutionKey(req.pkg, constraint))!];
      };

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
        } catch {
          return; /* Already reported during the walk */
        }
        const targets = targetsOf(req);
        if (targets.length === 0 && domain.isUnconstrained(constraint)) {
          errors.add(
            `'${req.pkg}' is required by ${from} without a version constraint ('${req.constraint}'),` +
              ` and no versioned requirement for it exists — add one explicitly`
          );
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
      /* Keep only the raises that shaped the result: the raised version must
       * have won its key AND be reachable (a raise superseded by a higher
       * floor, or pruned with a superseded subtree, never mattered) — then
       * dedup identical (pkg, constraint) raises from parallel demands. */
      const raiseKeys = new Set<string>();
      const raises = candidateRaises.filter(raise => {
        const winner = selections.some(sel => sel.pkg === raise.pkg && domain.compare(sel.version, raise.raised) === 0);
        const dedup = `${raise.pkg}\n${raise.constraint}`;
        if (!winner || raiseKeys.has(dedup)) {
          return false;
        }
        raiseKeys.add(dedup);
        return true;
      });
      resolve({ selections, errors: [...errors], violations, raises });
    };

    for (const root of roots) {
      enqueue(root, ROOT_REQUIRER);
    }
    if (--pending === 0) {
      finish();
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
    expand(tree.violations).then(() => ({ tree, splits: [...splits.values()] }))
  );
}
