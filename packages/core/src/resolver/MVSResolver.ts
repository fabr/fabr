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
import { PackageRegistry, Requirement, Resolution, ROOT_REQUIRER, Selected, VersionDomain } from "./Types";

/**
 * Minimal Version Selection resolver (after Go's MVS): every constraint is
 * interpreted as a lower bound, and each resolution key is resolved to the
 * maximum over all lower bounds declared in the reachable requirement graph.
 *
 * The result therefore depends only on what the packages in the graph declare,
 * never on what else the repository happens to contain, so it is deterministic
 * without a lockfile (provided published metadata is immutable). Upper bounds
 * are checked after selection; violations are reported in Resolution.errors
 * (the deterministic remedy is a user-supplied override, i.e. an additional
 * root requirement, which dominates naturally by the max rule).
 *
 * Note: if the registry rejects a metadata fetch, the returned Computable
 * rejects with that error (the requirement graph cannot be determined, which is
 * unlike a constraint violation and so is not reported via Resolution.errors).
 */
export function resolveMVS<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: PackageRegistry<V>
): Computable<Resolution<V>> {
  return Computable.from((resolve, reject) => {
    /* Highest minimum seen so far, per resolution key */
    const selected = new Map<string, Selected<V>>();
    /* Declared requirements of every pkg@version visited (including superseded ones) */
    const nodeRequirements = new Map<string, Requirement[]>();
    const errors = new Set<string>();
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
      const key = domain.resolutionKey(req.pkg, constraint);
      const min = domain.minimumOf(constraint);
      const current = selected.get(key);
      if (!current || domain.compare(min, current.version) > 0) {
        selected.set(key, { pkg: req.pkg, version: min, selectedBy: { requiredBy, constraint: req.constraint } });
        visit(req.pkg, min);
      }
    };

    const visit = (pkg: string, version: V): void => {
      const id = nodeId(pkg, version);
      if (nodeRequirements.has(id)) {
        return;
      }
      nodeRequirements.set(id, []);
      pending++;
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
        err => fail(err)
      );
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
            errors.add(
              `${selection.pkg}@${domain.versionToString(selection.version)} does not satisfy '${req.constraint}'` +
                ` required by ${from}`
            );
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
      resolve({ selections, errors: [...errors] });
    };

    for (const root of roots) {
      enqueue(root, ROOT_REQUIRER);
    }
    if (--pending === 0) {
      finish();
    }
  });
}
