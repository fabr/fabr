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

import { constraintOf, requiredAs } from "./Requirement";
import { DependencyName, NodeId, PackageName, RaisedFloor, Requirement, ROOT_REQUIRER, Selected, VersionDomain, Violation } from "./Types";

/**
 * The identity of one concrete package version — `pkg@version` — as it appears
 * in a requirement edge's `requiredBy`, in a MetadataFetchError's requirer
 * chain, and as the key of any per-node table a consumer builds. One
 * definition, because those tables are joined by it.
 */
export function nodeId<V, C>(domain: VersionDomain<V, C>, pkg: PackageName, version: V): NodeId {
  return `${pkg}@${domain.versionToString(version)}`;
}

/** The data of a finished resolution — what {@link ResolutionGraph} is
 * constructed over: the deserialized form of the persisted resolution doc
 * (see ResolutionDoc), one field for one doc section. */
export interface IResolutionData<V> {
  readonly selections: Selected<V>[];
  readonly violations: Violation<V>[];
  readonly coerced: Violation<V>[];
  readonly shared: Violation<V>[];
  readonly raises: RaisedFloor<V>[];
  readonly requirements: Map<NodeId, Requirement[]>;
  readonly edges: Map<NodeId, Map<DependencyName, NodeId>>;
  readonly rootBindings: (number | undefined)[];
}

const NONE: never[] = [];
const NO_EDGES: ReadonlyMap<DependencyName, NodeId> = new Map();

/**
 * A finished resolution **as a graph**: the resolved data plus the indexes
 * every consumer of it asks for, built once at construction. A resolution is
 * immutable and shared by every delivery made from it, so every recurring
 * question — which selection an id names, which selections a package has,
 * what a node violated, what a seed set reaches — is answered from one
 * derivation instead of once per delivery. This IS the loaded resolution
 * (deserialization returns one); a delivery reads it through this face, so it
 * cannot disagree with the resolution it came from.
 *
 * Takes a `versionToString` rather than a whole VersionDomain (the explainer's
 * precedent): a persisted resolution is readable on its own, without the
 * ecosystem's comparison and constraint machinery.
 */
export class ResolutionGraph<V> implements IResolutionData<V> {
  public readonly selections: Selected<V>[];
  public readonly violations: Violation<V>[];
  public readonly coerced: Violation<V>[];
  public readonly shared: Violation<V>[];
  public readonly raises: RaisedFloor<V>[];
  public readonly requirements: Map<string, Requirement[]>;
  public readonly edges: Map<string, Map<string, string>>;
  public readonly rootBindings: (number | undefined)[];

  private readonly byId = new Map<NodeId, Selected<V>>();
  private readonly byPkg = new Map<PackageName, Selected<V>[]>();
  private readonly byRequirer = new Map<NodeId, Violation<V>[]>();
  /** id → position in {@link selections} — the canonical order, reimposable on
   * any id subset without the domain's comparator. */
  private readonly positions = new Map<NodeId, number>();
  /** id → the dependency names its OPTIONAL-provided requirements bind
   * (optional peers, minus any name a real requirement also demands). Derived
   * lazily — only {@link reachable} asks. */
  private optionalProvided: Map<NodeId, Set<DependencyName>> | undefined;

  constructor(
    public readonly versionToString: (version: V) => string,
    data: IResolutionData<V>
  ) {
    this.selections = data.selections;
    this.violations = data.violations;
    this.coerced = data.coerced;
    this.shared = data.shared;
    this.raises = data.raises;
    this.requirements = data.requirements;
    this.edges = data.edges;
    this.rootBindings = data.rootBindings;
    for (const selection of data.selections) {
      const id = this.id(selection);
      this.byId.set(id, selection);
      this.positions.set(id, this.positions.size);
      const candidates = this.byPkg.get(selection.name);
      if (candidates) {
        candidates.push(selection);
      } else {
        this.byPkg.set(selection.name, [selection]);
      }
    }
    for (const violation of data.violations) {
      const held = this.byRequirer.get(violation.requiredBy);
      if (held) {
        held.push(violation);
      } else {
        this.byRequirer.set(violation.requiredBy, [violation]);
      }
    }
  }

  /** {@link nodeId} of a selection. */
  public id(selection: Selected<V>): NodeId {
    return `${selection.name}@${this.versionToString(selection.version)}`;
  }

  /** The selection an id names, if the resolution holds one. */
  public node(id: NodeId): Selected<V> | undefined {
    return this.byId.get(id);
  }

  /** The selections the given ids name, in the resolution's **canonical
   * order** — whatever order the ids arrived in (typically a reachability
   * walk's). Ids the resolution does not hold are dropped. */
  public nodesOf(ids: Iterable<NodeId>): Selected<V>[] {
    return [...ids]
      .filter(id => this.byId.has(id))
      .sort((a, b) => this.positions.get(a)! - this.positions.get(b)!)
      .map(id => this.byId.get(id)!);
  }

  /** The selections of a package, in the resolution's canonical order — the
   * candidate list {@link edgeBinding} considers. */
  public selectionsOf(pkg: PackageName): readonly Selected<V>[] {
    return this.byPkg.get(pkg) ?? NONE;
  }

  /** The selection a canonical root (by index) binds to — decided when the
   * resolution was computed, scoped to what that root reaches, so a fork
   * packed for another root's violated edge cannot answer here. */
  public rootBinding(index: number): Selected<V> | undefined {
    const at = this.rootBindings[index];
    return at === undefined ? undefined : this.selections[at];
  }

  /** A node's resolved edges: dependency name (the *requirer's* name for it —
   * the rename, for a renamed dependency) → the id of the selection it binds to. */
  public edgesOf(id: NodeId): ReadonlyMap<DependencyName, NodeId> {
    return this.edges.get(id) ?? NO_EDGES;
  }

  /** The nodes reachable from `seeds` by walking the resolved edges forward —
   * O(the subset), which is what a delivery is proportional to. Optional
   * provided edges are bound ({@link edgesOf} — a delivered peer must mount)
   * but never traversed: an optional peer makes nothing deliverable, so a
   * subset that does not otherwise reach the peer must not fetch it. */
  public reachable(seeds: Iterable<NodeId>): Set<NodeId> {
    return reachableFrom(this.edges, seeds, id => this.optionalProvidedNames(id));
  }

  /** The names a node requires only as an optional peer (see {@link
   * optionalProvided}). A name both a real requirement and an optional peer
   * demand is not one — the real edge is in effect. */
  public optionalProvidedNames(id: NodeId): ReadonlySet<DependencyName> | undefined {
    if (this.optionalProvided === undefined) {
      this.optionalProvided = new Map();
      for (const [node, requires] of this.requirements) {
        const names = new Set(requires.filter(req => req.provided === "optional").map(req => requiredAs(req)));
        for (const req of requires) {
          if (req.provided !== "optional") {
            names.delete(requiredAs(req));
          }
        }
        if (names.size > 0) {
          this.optionalProvided.set(node, names);
        }
      }
    }
    return this.optionalProvided.get(id);
  }

  /** The names a node requires only as provided, whatever the strength — the
   * edges its consumer binds. A name a real requirement also demands is not
   * one. */
  public providedNames(id: NodeId): ReadonlySet<DependencyName> {
    const requires = this.requirements.get(id) ?? [];
    const names = new Set(requires.filter(req => req.provided !== undefined).map(req => requiredAs(req)));
    for (const req of requires) {
      if (req.provided === undefined) {
        names.delete(requiredAs(req));
      }
    }
    return names;
  }

  /** The violations declared by one node ({@link ROOT_REQUIRER} for root
   * requirements), so scoping violations to a delivery is a lookup per
   * delivered node rather than a pass over everything recorded. */
  public violationsOf(requirerId: NodeId): readonly Violation<V>[] {
    return this.byRequirer.get(requirerId) ?? NONE;
  }

  /**
   * The chain of selected versions from a root requirement down to `node`,
   * following each node's reachability edge, each annotated with the
   * constraint its predecessor declared (the root-most carries none). Returned
   * as segments, for a caller that appends its own before joining with " -> ".
   */
  public pathTo(node: Selected<V>): string[] {
    const chain: string[] = [];
    const seen = new Set<Selected<V>>();
    let current: Selected<V> | undefined = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      const via = current.reachedVia;
      if (!via || via.requiredBy === ROOT_REQUIRER) {
        chain.unshift(this.id(current));
        break;
      }
      chain.unshift(`${this.id(current)} (${via.versionConstraint})`);
      current = this.byId.get(via.requiredBy);
    }
    return chain;
  }

  /** This resolution's {@link ResolutionExplainer} — the same indexes, behind
   * the narrow explain-only face provenance rendering consumes. */
  public explainer(): ResolutionExplainer<V> {
    return { id: sel => this.id(sel), find: id => this.node(id), pathTo: node => this.pathTo(node) };
  }
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
export function reachableFrom(
  edges: ReadonlyMap<NodeId, ReadonlyMap<DependencyName, NodeId>>,
  seeds: Iterable<NodeId>,
  /** Edge names of a node the walk must NOT follow — its optional-provided
   * bindings, which confer no reachability (see {@link ResolutionGraph.reachable}). */
  skip?: (id: NodeId) => ReadonlySet<DependencyName> | undefined
): Set<NodeId> {
  const reached = new Set<NodeId>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id)) {
      continue;
    }
    reached.add(id);
    const barred = skip?.(id);
    for (const [name, target] of edges.get(id) ?? []) {
      if (!reached.has(target) && barred?.has(name) !== true) {
        pending.push(target);
      }
    }
  }
  return reached;
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
 * delivered, and reports as a violation. A provided edge binds the principal
 * whatever it satisfies: no fork serves one, and its consumer may rebind it
 * (see bindProvided). A floorless constraint has no floor
 * to fail and any cap it has is what `satisfies` checks, and a provided (peer)
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
    constraint = constraintOf(domain, req.versionConstraint);
  } catch {
    return undefined;
  }
  const name = requiredAs(req);
  const candidates = selections.filter(sel => sel.name === name);
  const principal = candidates.find(sel => !sel.fork);
  if (principal && (req.provided !== undefined || domain.satisfies(principal.version, constraint))) {
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
  id(selection: Selected<V>): NodeId;
  /** The selection with that id, if the resolution holds one. A requirement
   * edge may name a node that was itself later superseded, so a `requiredBy`
   * lookup can legitimately miss. */
  find(id: NodeId): Selected<V> | undefined;
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
  /* A bare selection list explained as a graph with nothing else in it — the
   * synthetic case (a bare package's minted origin, a delivery slice) where no
   * loaded resolution stands behind the selections. One pathTo, one home. */
  return new ResolutionGraph(versionToString, {
    selections: [...selections],
    violations: [],
    coerced: [],
    shared: [],
    raises: [],
    requirements: new Map(),
    edges: new Map(),
    rootBindings: [],
  }).explainer();
}

/**
 * The names `selections` selects more than one version of — the fact a strict
 * (linked) delivery rejects and a sealed one nests.
 */
export function coexistingVersions<V>(selections: readonly Selected<V>[]): Array<[string, V[]]> {
  const byPkg = new Map<string, V[]>();
  for (const sel of selections) {
    byPkg.set(sel.name, [...(byPkg.get(sel.name) ?? []), sel.version]);
  }
  return [...byPkg].filter(([, versions]) => versions.length > 1);
}

