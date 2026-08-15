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

import { Requirement, ROOT_REQUIRER, Selected, VersionDomain, Violation } from "./Types";

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

/**
 * The indexes a consumer of a resolution asks for repeatedly: which selections
 * are forks, which selection an id names, and which selections a package has.
 *
 * Held per selection LIST rather than per query: a resolution is immutable and
 * shared by every delivery made from it, so these are properties of the whole
 * result, derived once for it instead of once per delivery. Weakly held — a
 * resolution that falls out of use takes its indexes with it.
 */
export interface IResolutionIndex<V> {
  /** The ids of the **fork** selections — a sanctioned second (third, …)
   * version of a package, deliverable only nested under its requirers. */
  readonly forkIds: ReadonlySet<string>;
  /** Selections by {@link nodeId}, so a walk over the edges can reach the
   * selection an id names. */
  readonly byId: ReadonlyMap<string, Selected<V>>;
  /** The selections of each package, in the resolution's canonical order — the
   * candidate list {@link edgeBinding} actually considers. */
  readonly byPkg: ReadonlyMap<string, Selected<V>[]>;
}

const INDEXES = new WeakMap<object, IResolutionIndex<unknown>>();

export function resolutionIndex<V, C>(domain: VersionDomain<V, C>, selections: readonly Selected<V>[]): IResolutionIndex<V> {
  const known = INDEXES.get(selections as object);
  if (known !== undefined) {
    return known as IResolutionIndex<V>;
  }
  const forkIds = new Set<string>();
  const byId = new Map<string, Selected<V>>();
  const byPkg = new Map<string, Selected<V>[]>();
  for (const selection of selections) {
    const id = selectionId(domain, selection);
    byId.set(id, selection);
    if (selection.fork !== undefined) {
      forkIds.add(id);
    }
    const candidates = byPkg.get(selection.pkg);
    if (candidates) {
      candidates.push(selection);
    } else {
      byPkg.set(selection.pkg, [selection]);
    }
  }
  const index: IResolutionIndex<V> = { forkIds, byId, byPkg };
  INDEXES.set(selections as object, index as IResolutionIndex<unknown>);
  return index;
}

/**
 * The nodes reachable from `seeds`, by **walking the resolution's own edges**
 * — the delivered subset of a joint resolution.
 *
 * A walk rather than a filter over `reachableFrom`: that index answers "which
 * roots reach this node", so asking it what a root reaches costs a pass over
 * every selection, per delivery, however small the subset. Following the edges
 * forward is O(the subset) — which is what a delivery is proportional to.
 *
 * The two agree by construction: the resolver marked `reachableFrom` by
 * following exactly these bindings (see the walk's own reachability pass).
 */
export function reachableFrom(edges: ReadonlyMap<string, ReadonlyMap<string, string>>, seeds: Iterable<string>): Set<string> {
  const reached = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id)) {
      continue;
    }
    reached.add(id);
    for (const target of edges.get(id)?.values() ?? []) {
      if (!reached.has(target)) {
        pending.push(target);
      }
    }
  }
  return reached;
}

/** Violations indexed by the node that declared the violated edge, so scoping
 * them to a delivery is a lookup per delivered node rather than a pass over
 * every violation the resolution recorded. */
const VIOLATIONS_BY_REQUIRER = new WeakMap<object, Map<string, unknown[]>>();

export function violationsByRequirer<V>(violations: ReadonlyArray<Violation<V>>): Map<string, Violation<V>[]> {
  const known = VIOLATIONS_BY_REQUIRER.get(violations as object);
  if (known !== undefined) {
    return known as Map<string, Violation<V>[]>;
  }
  const index = new Map<string, Violation<V>[]>();
  for (const violation of violations) {
    index.set(violation.requiredBy, [...(index.get(violation.requiredBy) ?? []), violation]);
  }
  VIOLATIONS_BY_REQUIRER.set(violations as object, index as Map<string, unknown[]>);
  return index;
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
 * **The** rule for the single selection a requirement edge *binds* to, within
 * `selections` (a resolution's, principal and fork selections together), by
 * **satisfaction**: the principal selection of the package when it satisfies
 * the constraint (the flat winner serves every edge it can — nesting is never
 * gratuitous), else the highest satisfying fork (the fork packing repaired
 * this edge into), else the principal, else the highest candidate — so a
 * jointly-unsatisfiable edge nothing repairs still binds what is actually
 * delivered, and reports as a violation. A floorless constraint has no floor
 * to fail and any cap it has is what `satisfies` checks, and a soft (peer)
 * edge is satisfied by whatever the tree provides in range — the same rule
 * answers both, with no case of their own. Undefined when the constraint is
 * unparseable (reported by the walk) or nothing of the package is selected (a
 * gated optional pruned from it).
 *
 * A layout whose answer here disagreed with the walk's would be one the
 * resolution never sanctioned — hence one rule, two callers.
 */
export function edgeBinding<V, C>(
  domain: VersionDomain<V, C>,
  selections: readonly Selected<V>[],
  req: Requirement
): Selected<V> | undefined {
  let constraint: C;
  try {
    constraint = domain.parseConstraint(req.constraint);
  } catch {
    return undefined;
  }
  const candidates = selections.filter(sel => sel.pkg === req.pkg);
  const principal = candidates.find(sel => !sel.fork);
  if (principal && domain.satisfies(principal.version, constraint)) {
    return principal;
  }
  const satisfying = highestOf(
    domain,
    candidates.filter(sel => domain.satisfies(sel.version, constraint))
  );
  return satisfying ?? principal ?? highestOf(domain, candidates);
}

/**
 * Reader over a resolution's provenance edges: node identity, lookup by it,
 * and the requirement path back to a root. Every "why is this here / why this
 * version" answer is one of these, so provenance rendering and a delivery's
 * own diagnostics reach identical explanations of the same resolution.
 *
 * Takes a `versionToString` rather than a whole {@link VersionDomain}: a
 * persisted resolution is explainable on its own, without the ecosystem's
 * comparison and constraint machinery. The ids it produces are {@link nodeId}'s
 * form — that is what `requiredBy` holds.
 */
export interface ResolutionExplainer<V> {
  /** {@link nodeId} of a selection. */
  id(selection: Selected<V>): string;
  /** The selection with that id, if the resolution holds one. A requirement
   * edge may name a node that was itself later superseded, so a `requiredBy`
   * lookup can legitimately miss. */
  find(id: string): Selected<V> | undefined;
  /**
   * The chain of selected versions from a root requirement down to `node`,
   * following each node's reachability edge, each annotated with the
   * constraint its predecessor declared (the root-most carries none). Returned
   * as segments, for a caller that appends its own before joining with " -> ".
   */
  pathTo(node: Selected<V>): string[];
}

/** {@link ResolutionExplainer} over `selections`. */
export function resolutionExplainer<V>(
  selections: readonly Selected<V>[],
  versionToString: (version: V) => string
): ResolutionExplainer<V> {
  const id = (selection: Selected<V>): string => `${selection.pkg}@${versionToString(selection.version)}`;
  const byId = new Map(selections.map(selection => [id(selection), selection]));
  const pathTo = (node: Selected<V>): string[] => {
    const chain: string[] = [];
    const seen = new Set<Selected<V>>();
    let current: Selected<V> | undefined = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      const via = current.reachedVia;
      if (!via || via.requiredBy === ROOT_REQUIRER) {
        chain.unshift(id(current));
        break;
      }
      chain.unshift(`${id(current)} (${via.constraint})`);
      current = byId.get(via.requiredBy);
    }
    return chain;
  };
  return { id, find: key => byId.get(key), pathTo };
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

