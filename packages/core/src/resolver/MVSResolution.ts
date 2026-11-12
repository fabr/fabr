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
 * A finished resolution read as a graph: node identity, the selection each
 * requirement binds to, and the lookups made of a resolution once it is
 * finished. MVSResolver uses the same functions ({@link edgeBinding},
 * {@link nodeId}) on its own state while it walks.
 */

import { buildReference, constraintOf, isBuildVersion, requiredAs } from "./Requirement";
import {
  DependencyName,
  IResolutionError,
  NodeId,
  PackageName,
  RaisedFloor,
  Requirement,
  ROOT_REQUIRER,
  Selected,
  VersionDomain,
  Violation,
} from "./Types";

/**
 * Make the id of package `pkg` at `version`, `pkg@version`: what a
 * requirement's `requiredBy` and a MetadataFetchError's requirer chain hold,
 * and the key of every per-node table of a resolution.
 */
export function nodeId<V, C>(domain: VersionDomain<V, C>, pkg: PackageName, version: V): NodeId {
  return nodeIdOf(pkg, domain.versionToString(version));
}

/** Make the {@link nodeId} of package `pkg` at the version spelled `versionText`. */
export function nodeIdOf(pkg: PackageName, versionText: string): NodeId {
  return `${pkg}@${versionText}`;
}

/**
 * Format a node for a message: its id, or for a build the reference to it
 * (`core<BUILD_TYPE=release>`).
 */
export function nodeLabel(id: NodeId): string {
  const at = id.indexOf("@", 1);
  const version = at < 0 ? "" : id.slice(at + 1);
  return isBuildVersion(version) ? buildReference(id.slice(0, at), version) : id;
}

/**
 * The data an {@link MVSResolution} is made from: the walk's result
 * (resolveMVS), or a persisted resolution read back (ResolutionDoc), which
 * stores every field but `errors`.
 */
export interface IResolutionData<V> {
  /** The selected package versions, sorted by package and version. A package
   * may have several: one without a fork, and forks (`Selected.fork`). */
  readonly selections: Selected<V>[];
  /** Problems with single requirements, such as an unparseable constraint, a
   * package required only without a lower bound, or two packages required
   * under one name. */
  readonly errors: IResolutionError[];
  /** Requirements their package's selection without a fork does not satisfy
   * (where the package has only forks, the selection they bind to). */
  readonly violations: Violation<V>[];
  /**
   * Requirements a `force` (`!`) requirement overrode: `requiredBy` declared
   * `versionConstraint` on `name`, and the forced version (`selected`) does not
   * satisfy it. Recorded for explanation only: no fork is made for them and
   * nothing refuses them.
   */
  readonly coerced: Violation<V>[];
  /**
   * Provided requirements the selection they bind to does not satisfy, in a
   * domain whose {@link VersionDomain.providedMismatch} tolerates that.
   * Recorded for explanation only: nothing refuses them.
   */
  readonly shared: Violation<V>[];
  /** Lower bounds never published, raised to the lowest published version
   * satisfying the constraint; only raises whose version was selected. */
  readonly raises: RaisedFloor<V>[];
  /**
   * The requirements each selection declared, by {@link nodeId}, forks
   * included: the constraint text explanations and the strict check read, and
   * which requirements are provided.
   */
  readonly requirements: Map<NodeId, Requirement[]>;
  /**
   * For each selection, by {@link nodeId}: the {@link nodeId} of the selection
   * each of its requirements binds to ({@link edgeBinding}), keyed by the
   * requirer's name for the dependency (`dependencyNameOf`: the rename for a
   * renamed one, `<name>/<variant>` for a variant). Where two requirements of
   * one node share a name, the first declared is kept. A requirement that binds
   * to nothing has no entry.
   */
  readonly edges: Map<NodeId, Map<DependencyName, NodeId>>;
  /**
   * For each root requirement, by its index in the roots resolved: the index in
   * `selections` of the selection it binds to, chosen among the selections that
   * root reaches. Undefined for an `alternate` (`?`) root, which selects
   * nothing, and for a root that binds to nothing.
   */
  readonly rootBindings: (number | undefined)[];
}

const NONE: never[] = [];
const NO_EDGES: ReadonlyMap<DependencyName, NodeId> = new Map();

/**
 * A finished resolution as a graph: the {@link IResolutionData} it is made
 * from, with lookups over it. Returned by resolveMVS and by reading a
 * persisted resolution back (deserializeResolutionDoc), and shared, unchanged,
 * by every collection point it answers.
 *
 * Lookups:
 * - by node: `id`, `node`, `edgesOf`, `violationsOf`,
 *   `providedNames` and `optionalProvidedNames`;
 * - by package: `selectionsOf`;
 * - by root: `rootBinding`;
 * - over a subset: `reachable` (the nodes some seeds reach),
 *   `nodesOf` and `ordered` (in the order of `selections`);
 * - for explanation: `pathTo` and `explainer`.
 *
 * It needs only `versionToString` of the version domain, to spell node ids.
 * The data is not copied: the caller must not change it afterwards.
 */
export class MVSResolution<V> implements IResolutionData<V> {
  public readonly selections: Selected<V>[];
  public readonly errors: IResolutionError[];
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
  /** Each selection's position in {@link selections}, by its id. */
  private readonly positions = new Map<NodeId, number>();
  /** Each selection's position in {@link selections}, by the selection. */
  private readonly order = new Map<Selected<V>, number>();
  /** The answers of {@link optionalProvidedNames}, by node id, for the nodes
   * that have any; made on its first call. */
  private optionalProvided: Map<NodeId, Set<DependencyName>> | undefined;

  constructor(
    public readonly versionToString: (version: V) => string,
    data: IResolutionData<V>
  ) {
    this.selections = data.selections;
    this.errors = data.errors;
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
      this.order.set(selection, this.order.size);
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

  /** Get the {@link nodeId} of a selection. */
  public id(selection: Selected<V>): NodeId {
    return `${selection.name}@${this.versionToString(selection.version)}`;
  }

  /** Look up the selection an id names, if the resolution holds one. */
  public node(id: NodeId): Selected<V> | undefined {
    return this.byId.get(id);
  }

  /** Get the selections the given ids name, in the order of
   * {@link selections} whatever order the ids are in. Ids the resolution does
   * not hold are dropped. */
  public nodesOf(ids: Iterable<NodeId>): Selected<V>[] {
    return [...ids]
      .filter(id => this.byId.has(id))
      .sort((a, b) => this.positions.get(a)! - this.positions.get(b)!)
      .map(id => this.byId.get(id)!);
  }

  /** Put `selections`, each one of this resolution's, in the order of
   * {@link selections}. */
  public ordered(selections: Iterable<Selected<V>>): Selected<V>[] {
    return [...selections].sort((a, b) => this.order.get(a)! - this.order.get(b)!);
  }

  /** Get the selections of a package, forks included, in the order of
   * {@link selections}. */
  public selectionsOf(pkg: PackageName): readonly Selected<V>[] {
    return this.byPkg.get(pkg) ?? NONE;
  }

  /** Get the selection the root requirement at `index` binds to (see
   * {@link rootBindings}), or undefined where it binds to none. */
  public rootBinding(index: number): Selected<V> | undefined {
    const at = this.rootBindings[index];
    return at === undefined ? undefined : this.selections[at];
  }

  /** Get the selections a node's requirements bind to, by dependency name
   * (see {@link edges}); empty for an id the resolution does not hold. */
  public edgesOf(id: NodeId): ReadonlyMap<DependencyName, NodeId> {
    return this.edges.get(id) ?? NO_EDGES;
  }

  /** Find the nodes reachable from `seeds`, seeds included, by following
   * {@link edges}. An optional provided requirement is not followed (see
   * {@link optionalProvidedNames}): its selection is reached only where
   * something else reaches it. */
  public reachable(seeds: Iterable<NodeId>): Set<NodeId> {
    return reachableFrom(this.edges, seeds, id => this.optionalProvidedNames(id));
  }

  /** Get the dependency names a node requires only as `"optional"` provided
   * requirements, or undefined where there are none. A name it also requires
   * by a requirement that is not optional provided is left out. */
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

  /** Get the dependency names a node requires only as provided requirements,
   * `"expected"` or `"optional"`. A name it also requires by a requirement that
   * is not provided is left out. */
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

  /** Get the {@link violations} of the requirements one node declared
   * ({@link ROOT_REQUIRER} for the root requirements). */
  public violationsOf(requirerId: NodeId): readonly Violation<V>[] {
    return this.byRequirer.get(requirerId) ?? NONE;
  }

  /**
   * Trace the selections from a root requirement down to `node`, following
   * each selection's `reachedVia` back to the node that required it. Each
   * segment is the selection's {@link nodeLabel}, followed by the constraint it
   * was required with in parentheses; the root-most has no constraint, nor has
   * a selection required with none or required as a build. Returned as
   * segments, for a caller to append its own to before joining with " -> ".
   */
  public pathTo(node: Selected<V>): string[] {
    const chain: string[] = [];
    const seen = new Set<Selected<V>>();
    let current: Selected<V> | undefined = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      const via = current.reachedVia;
      if (!via || via.requiredBy === ROOT_REQUIRER) {
        chain.unshift(nodeLabel(this.id(current)));
        break;
      }
      /* A node required with no version stated is shown alone, and so is a
       * build, whose label already names the build required. */
      const stated = via.versionConstraint === undefined || isBuildVersion(via.versionConstraint) ? "" : ` (${via.versionConstraint})`;
      chain.unshift(`${nodeLabel(this.id(current))}${stated}`);
      current = this.byId.get(via.requiredBy);
    }
    return chain;
  }

  /** Get a {@link ResolutionExplainer} over this resolution. */
  public explainer(): ResolutionExplainer<V> {
    return { id: sel => this.id(sel), find: id => this.node(id), pathTo: node => this.pathTo(node) };
  }
}

/**
 * Find the nodes reachable from `seeds`, seeds included, by following `edges`
 * (an {@link IResolutionData.edges}), leaving out the dependency names `skip`
 * gives for a node.
 */
export function reachableFrom(
  edges: ReadonlyMap<NodeId, ReadonlyMap<DependencyName, NodeId>>,
  seeds: Iterable<NodeId>,
  /** The dependency names of a node not to follow. */
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

/** Pick the highest of `selections` by version; undefined if there are none.
 * Ties keep the earlier, so the caller's order decides — pass a canonical
 * one. */
function highestOf<V, C>(domain: VersionDomain<V, C>, selections: readonly Selected<V>[]): Selected<V> | undefined {
  return selections.reduce<Selected<V> | undefined>(
    (best, sel) => (best === undefined || domain.compare(sel.version, best.version) > 0 ? sel : best),
    undefined
  );
}

/**
 * Choose the one selection a requirement binds to, among `selections` of the
 * package it is required as (`requiredAs`); selections of other packages are
 * ignored. The first of these that exists is chosen:
 * 1. the package's selection without a fork, where it satisfies the
 *    requirement's constraint, or the requirement is provided (`"expected"`
 *    or `"optional"`) whatever it satisfies;
 * 2. the highest selection that satisfies the constraint (a fork,
 *    `Selected.fork`);
 * 3. the selection without a fork;
 * 4. the highest selection.
 *
 * So a requirement nothing satisfies still binds to a selection; it is the
 * caller's to record it as a violation. A requirement stating no version
 * binds as one whose constraint every version satisfies.
 *
 * @return the selection, or undefined where the constraint does not parse or
 * `selections` holds none of the package.
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
 * The lookups that explain why a selection is in a resolution: node ids, the
 * selection an id names, and the path from a root requirement down to a
 * selection.
 */
export interface ResolutionExplainer<V> {
  /** Get the {@link nodeId} of a selection. */
  id(selection: Selected<V>): NodeId;
  /** Look up the selection an id names, if the resolution holds one. A
   * `requiredBy` may name a node the resolution does not select, so this can
   * miss. */
  find(id: NodeId): Selected<V> | undefined;
  /** Trace the selections from a root requirement down to `node`, as
   * {@link MVSResolution.pathTo} does. */
  pathTo(node: Selected<V>): string[];
}

/** Make a {@link ResolutionExplainer} over `selections`. */
export function resolutionExplainer<V>(
  selections: readonly Selected<V>[],
  versionToString: (version: V) => string
): ResolutionExplainer<V> {
  /* A resolution of these selections alone, with no requirements or edges. */
  return new MVSResolution(versionToString, {
    selections: [...selections],
    errors: [],
    violations: [],
    coerced: [],
    shared: [],
    raises: [],
    requirements: new Map(),
    edges: new Map(),
    rootBindings: [],
  }).explainer();
}
