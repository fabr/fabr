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
 * A resolution read as a **graph**: node identity, where each requirement edge
 * leads, and the structural questions a consumer asks of a finished
 * resolution. Separate from the algorithm that produces one (MVSResolver) and
 * from how it is explained (ResolutionProvenance) — but *shared* with the
 * algorithm, which asks the same questions of its own converged state.
 *
 * That sharing is the point of the module. A consumer laying a resolution out,
 * or judging it, must reach the same answers the walk did; two implementations
 * obliged to agree is how they stop agreeing.
 */

import { Requirement, Selected, VersionDomain, Violation } from "./Types";

/**
 * The identity of one concrete package version — `pkg@version` — as it appears
 * in a requirement edge's `requiredBy`, in a MetadataFetchError's requirer
 * chain, and as the key of any per-node table a consumer builds. One
 * definition, because those tables are joined by it.
 */
export function nodeId<V, C>(domain: VersionDomain<V, C>, pkg: string, version: V): string {
  return `${pkg}@${domain.versionToString(version)}`;
}

/** {@link nodeId} of a selection. */
export function selectionId<V, C>(domain: VersionDomain<V, C>, selection: Selected<V>): string {
  return nodeId(domain, selection.pkg, selection.version);
}

/** The highest of `selections` by version; undefined if there are none. Ties
 * keep the earlier, so the caller's order decides — pass a canonical one. */
function highestOf<V, C>(domain: VersionDomain<V, C>, selections: readonly Selected<V>[]): Selected<V> | undefined {
  return selections.reduce<Selected<V> | undefined>(
    (best, sel) => (best === undefined || domain.compare(sel.version, best.version) > 0 ? sel : best),
    undefined
  );
}

/**
 * **The** rule for what a requirement edge leads to, within `selections` (a
 * whole resolution, or one private split's tree): the selection under the
 * requirement's resolution key; every selection of the package for a
 * floorless requirement, since any of them satisfies its (absent) floor; or —
 * for a soft (peer) requirement — those satisfying its range whatever their
 * key (attach-first: a peer range may span majors), falling back to the
 * highest candidate so the edge lands on what is actually delivered. A floored
 * edge whose declared key holds no selection follows *satisfaction* instead:
 * its floor was never published (the only way a demanded slot converges
 * empty), and the request is answered by whatever meets it — the raised
 * floor's selection, or an existing selection (a root pin) in range — else by
 * the highest candidate, so a jointly-unsatisfiable edge still binds what is
 * delivered and reports as a violation, exactly as an in-key mismatch does.
 * Empty when the constraint is unparseable (reported by the walk) or nothing
 * of the package is selected (a gated optional pruned from it).
 *
 * A layout whose answer here disagreed with the walk's would be one the
 * resolution never sanctioned — hence one rule, two callers. A selection's own
 * key comes from its exact version, per {@link VersionDomain.resolutionKey}'s
 * contract.
 */
export function edgeTargets<V, C>(
  domain: VersionDomain<V, C>,
  selections: readonly Selected<V>[],
  req: Requirement
): Selected<V>[] {
  let constraint: C;
  try {
    constraint = domain.parseConstraint(req.constraint);
  } catch {
    return [];
  }
  const candidates = selections.filter(sel => sel.pkg === req.pkg);
  if (domain.isFloorless(constraint)) {
    return candidates;
  }
  if (req.soft) {
    const satisfying = candidates.filter(sel => domain.satisfies(sel.version, constraint));
    if (satisfying.length > 0) {
      return satisfying;
    }
    const highest = highestOf(domain, candidates);
    return highest ? [highest] : [];
  }
  const key = domain.resolutionKey(req.pkg, constraint);
  const match = candidates.find(sel => domain.resolutionKey(sel.pkg, domain.parseConstraint(domain.versionToString(sel.version))) === key);
  if (match) {
    return [match];
  }
  const satisfied = highestOf(
    domain,
    candidates.filter(sel => domain.satisfies(sel.version, constraint))
  );
  if (satisfied) {
    return [satisfied];
  }
  const highest = highestOf(domain, candidates);
  return highest ? [highest] : [];
}

/**
 * The single selection an edge *binds* to, where the consumer must pick one —
 * a layout slot names one package, while reachability follows every target.
 * The two differ only for an unconstrained or unsatisfied-soft edge, where the
 * highest is the binding.
 */
export function edgeBinding<V, C>(
  domain: VersionDomain<V, C>,
  selections: readonly Selected<V>[],
  req: Requirement
): Selected<V> | undefined {
  return highestOf(domain, edgeTargets(domain, selections, req));
}

/**
 * The names `selections` selects more than one version of — the fact a strict
 * (linked) delivery rejects and a sealed one nests.
 */
export function coexistingVersions<V>(selections: readonly Selected<V>[]): Array<[string, V[]]> {
  const byPkg = new Map<string, V[]>();
  for (const sel of selections) {
    byPkg.set(sel.pkg, [...(byPkg.get(sel.pkg) ?? []), sel.version]);
  }
  return [...byPkg].filter(([, versions]) => versions.length > 1);
}

/**
 * The splits repairing `violations`, plus those repairing the splits' own
 * violations, transitively — the repair set a delivery of those violated edges
 * has to carry. Generic over the split representation (a resolved tree, or a
 * deserialized one), which need only carry its (pkg, constraint) identity and
 * its own violations.
 */
export function reachableSplits<V, S extends { pkg: string; constraint: string; violations: Violation<V>[] }>(
  violations: readonly Violation<V>[],
  splits: readonly S[]
): S[] {
  const byKey = new Map(splits.map(split => [`${split.pkg}\n${split.constraint}`, split]));
  const included = new Map<string, S>();
  let frontier: readonly Violation<V>[] = violations;
  while (frontier.length > 0) {
    const next: Violation<V>[] = [];
    for (const violation of frontier) {
      const key = `${violation.pkg}\n${violation.constraint}`;
      const split = byKey.get(key);
      if (split && !included.has(key)) {
        included.set(key, split);
        next.push(...split.violations);
      }
    }
    frontier = next;
  }
  return [...included.values()];
}
