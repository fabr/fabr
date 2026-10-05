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

/** A bare package name — the per-name slot minimal version selection selects
 * over, and the namespace a {@link Requirement} demands from. */
export type PackageName = string;

/**
 * The identity of one concrete selected package version — `name@version` (the
 * resolver's `nodeId` form): the key every per-node table in a resolution is
 * joined by. A `requiredBy` holds one, or {@link ROOT_REQUIRER} for a root
 * requirement.
 */
export type NodeId = string;

/** The name a requirer resolves a dependency by: normally the dependency's own
 * {@link PackageName}, but the local name of a renamed requirement
 * ({@link Requirement.renameTo}) — hence the name a consumer mounts it under. */
export type DependencyName = string;

/**
 * A requirement on a package: the package, the versions of it that answer,
 * any override marker written on that, the name it is to be known by where
 * that is not the package's own, and whether something else is expected to
 * supply it.
 *
 * It names a package within ONE repository, whose format interprets
 * `versionConstraint`; a reference ({@link RepositoryRef}) is a requirement
 * addressed to a named repository.
 */
export interface Requirement {
  readonly name: PackageName;
  /** The version or range wanted, in the syntax of the repository's format.
   * Absent where what names the package states none: a catalog member, or a
   * package that has no version. Any version of the package then answers. */
  readonly versionConstraint: string | undefined;
  /**
   * A user-written override marker on an exact version (`@npm:pkg:1.4.2?` /
   * `@npm:pkg:2.0.0!`; `version` carries the bare version):
   *
   * - `"force"` (`!`) — full substitution, npm-`overrides` semantics: every
   *   requirement on the package, from any requirer, is replaced by exactly
   *   this version at resolve time. Ranges the forced version does not
   *   satisfy are recorded as {@link MVSResolution.coerced} — data, never
   *   violations. Participates in resolution (and its memo identity).
   * - `"alternate"` (`?`) — a sanction plus a supply of last resort, never an
   *   ordinary demand: it contributes no floor and mounts nothing of its own.
   *   It IS a resolver root, handled by a dedicated attach-last branch
   *   (MVSResolver's enqueue): only when the converged tree requires the
   *   package solely floorlessly does the written version supply a selection.
   *   Included in the canonical roots and the resolution memo key (its
   *   {@link requirementKey} carries the marker); the sanction itself is
   *   judged by the consumer at delivery.
   */
  readonly override?: "alternate" | "force";
  /**
   * The name whoever requires the package knows it by, when that differs from
   * the package's own (`@npm:typescript:6.0.3 -> typescript-6`; npm's
   * `"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"`, Cargo's `package =` rename).
   * Purely local: a renamed requirement takes part in the joint selection
   * exactly as an ordinary one, under its resultant name (`requiredAs`): the
   * renamed package is a package of that name, selected and installed apart
   * from the one it is a copy of, which only the registry is asked for.
   */
  readonly renameTo?: DependencyName;
  /**
   * The consumer's tree provides this package — the peer relationship, fabr's
   * `provided_deps` (which npm manifests spell `peerDependencies`, an
   * "optional" one also listed in `peerDependenciesMeta`). Either way the
   * requirement is attach-first: primarily a constraint on whatever the tree
   * selects for `name`, satisfied by any selection in range — which is what
   * keeps a wide multi-major peer range (chai '>= 2.1.2 < 5') from demanding
   * the range's floor beside an already-satisfying selection. The value is the
   * strength of the expectation, i.e. what happens when the converged tree
   * provides nothing:
   *
   * - `"expected"` — the failed expectation is repaired: the requirement fires
   *   as an ordinary demand for its own minimum (npm's peer auto-install as a
   *   last resort).
   * - `"optional"` — never a demand: nothing is installed, ever, and the edge
   *   simply does not bind. It is still a requirement, and that is the whole
   *   point of recording it: the requirer must be able to REACH the package
   *   when a consumer does provide it (`zustand` optionally peering on
   *   `react`). A hoisted tree gave that away for free by walking up; a
   *   dependency table has to say it.
   */
  readonly provided?: "expected" | "optional";
}

/**
 * The distinguished `requiredBy` value identifying a root requirement (one
 * passed directly to the resolver, rather than declared by a package).
 */
export const ROOT_REQUIRER = "(root)";

/**
 * A requirement edge in the dependency graph, for provenance: the node that
 * declared the requirement ("name@version", or ROOT_REQUIRER for a root
 * requirement) and the constraint it declared.
 */
export interface IRequirementEdge {
  requiredBy: NodeId;
  /** The version constraint the requirement states, if it states one. */
  versionConstraint: string | undefined;
}

/**
 * A concrete package version chosen by a resolver.
 *
 * The two provenance edges answer the questions a user asks of a resolution:
 * reachedVia answers "why is this package in my build at all" (following the
 * chain of reachedVia.requiredBy nodes leads back to a root), and selectedBy
 * answers "why this version" (the requirement whose lower bound won).
 * Note that under minimal version selection the winning requirement may have
 * been declared by a version that was itself later superseded — the raised
 * version legitimately remains — so selectedBy.requiredBy is not always a
 * selected node.
 *
 * Both are optional so that resolutions persisted before these fields existed
 * still deserialize.
 */
export interface Selected<V> {
  /** The package's name — the one it is required as (`requiredAs`), hence
   * installed as; a renamed package is a package of that name. The key of
   * every per-name table, and what a violation's and a floor raise's `name`
   * are. */
  name: PackageName;
  /** The name the registry publishes the package under, where it is not
   * `name`: what its requirements and content are fetched by. */
  publishedName?: PackageName;
  version: V;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  /**
   * Indices into the resolution's root list identifying which root
   * requirements (transitively) reach this selection.
   *
   * Resolver-internal and NOT persisted: it is the marking pass's own working
   * state, used to prune superseded nodes and to scope each root's binding. A
   * consumer carving the resolution into per-root subsets walks the edges
   * forward instead ({@link reachableFrom}) — this index answers the opposite
   * question ("which roots reach me"), so consulting it would cost a pass over
   * every selection per delivery.
   */
  reachableFrom?: number[];
  /**
   * Absent (or 0) for the **principal** selection — the one version per
   * package name the flat delivery ships. A positive index marks a **fork**: a
   * further selection of the same package repairing the violated requirement
   * edges the principal cannot satisfy (jointly-unsatisfiable constraints),
   * deliverable only by nesting it privately under its requirers. A strict
   * (linked) delivery refuses reachable forks; a sealed one nests them.
   * Indices are canonical per package (ascending version order), carrying no
   * meaning beyond distinctness.
   */
  fork?: number;
}

/** A selected package by name: what a reference to it is written from (see
 * {@link Selected.name} and {@link Selected.publishedName}). */
export type PackageIdentity = Pick<Selected<unknown>, "name" | "publishedName">;

/**
 * An upper-bound violation found after selection: `requiredBy` declared
 * `versionConstraint` on `name`, and the principal selection of the package does not
 * satisfy it (jointly-unsatisfiable constraints — an exact transitive pin
 * against a higher floor, or ranges confined to different majors). Reported as
 * data: the consumer decides whether it is an error (a linked delivery) or is
 * repaired by the fork selection the resolver packed its edge into (a sealed
 * tool delivery, which nests the fork privately). A violation no fork repairs
 * — nothing published satisfies its constraint — is undeliverable in every
 * mode; a consumer detects that by checking the selections (no selection of
 * `name` satisfies `version`).
 */
export interface Violation<V> {
  name: PackageName;
  versionConstraint: string;
  requiredBy: NodeId;
  selected: V;
}

/**
 * A floor-raise repair: `versionConstraint`'s declared minimum was never published, so
 * the lowest *published* satisfying version was selected in its place (via the
 * registry's {@link RequirementSource.lowestAvailable} hook). Only raises whose
 * raised version made the result are reported — a raise superseded by a higher
 * requirement's floor never shaped it.
 */
export interface RaisedFloor<V> {
  name: PackageName;
  versionConstraint: string;
  declared: V;
  raised: V;
  requiredBy: NodeId;
}

/**
 * The complete result of a resolution: the selected package versions, plus the
 * repairs applied (floor raises) and constraint violations found, plus any
 * hard errors (unparseable constraints, unconstrained-only requirements).
 *
 * Violations and repairs are reported as data rather than by rejecting the
 * Computable, both so that callers can decide how to present them (strict
 * consumers error at delivery; sealed tool deliveries accept the repaired
 * tree), and because a rejected Computable halts the graph without
 * user-visible diagnostics.
 */
export interface MVSResolution<V> {
  selections: Selected<V>[];
  errors: IResolutionError[];
  violations: Violation<V>[];
  /**
   * Requirement edges a `force` override coerced: `requiredBy` declared
   * `versionConstraint` on `name`, and the forced version (`selected`) does not
   * satisfy it. The force suppresses the conflict by design — these are
   * recorded so the coercion is explainable, never judged as violations (no
   * fork is packed for them and no delivery refuses them).
   */
  coerced: Violation<V>[];
  /**
   * Provided requirement edges the selection they bind does not satisfy, in a
   * domain that {@link VersionDomain.providedMismatch tolerates} that: data,
   * never judged — no delivery refuses them, and only the one selection ships.
   */
  shared: Violation<V>[];
  raises: RaisedFloor<V>[];
  /**
   * The declared requirements of each selected node ({@link nodeId} → its
   * requirements), i.e. the resolution's edges as the packages declared them.
   * The walk collects these to compute reachability; handing them back is what
   * lets a consumer lay the result out — where each edge leads is a pure
   * function of these plus {@link MVSResolution.selections} (see edgeBinding),
   * so a layout needs no second read of package metadata. Pruned nodes are not
   * listed: only what the resolution selected.
   */
  requirements: Map<NodeId, Requirement[]>;
  /**
   * The **resolved** edges of the selected graph: for each node, the selection
   * each of its requirements binds to, keyed by the name the *requirer* uses
   * (so a renamed dependency is an edge to the package under the name it is
   * renamed to). The companion of {@link MVSResolution.requirements}, which is the
   * same edges as *declared* — kept because explaining a resolution needs the
   * constraint text, while laying one out needs only where each edge leads.
   *
   * Computed here, once, by {@link edgeBinding} — the one rule for what an edge
   * binds to. A consumer reads the answer rather than recomputing it, which is
   * what makes a delivery a walk over the graph instead of a search of it, and
   * leaves nothing for a layout to disagree with.
   */
  edges: Map<NodeId, Map<DependencyName, NodeId>>;
  /**
   * Per canonical root (by index), the **index within `selections`** of the
   * node its requirement binds to — scoped to what that root reaches, so a fork
   * reachable only from a different root cannot capture it. Undefined for a
   * root that selects nothing (an `?`-alternate, which demands nothing of its
   * own).
   *
   * A position rather than an id so that reading it costs nothing: a delivery
   * resolves its root with an array index, needing no id table of its own.
   */
  rootBindings: (number | undefined)[];
}

/**
 * A hard resolution error, attributed to the root package whose subtree
 * contains it — the errors' analogue of MetadataFetchError's rootName, so a
 * repository can map the failure back to the written reference(s) requiring
 * that root rather than reporting it against the whole collection point.
 */
export interface IResolutionError {
  message: string;
  /** The root requirement whose subtree reached the error; the erring
   * requirement's own package when it is itself a root. */
  rootName: string;
  /** For a required-only-floorless error: the package that lacks any versioned
   * requirement (the remedy — an explicit requirement — names it). A consumer
   * groups the per-edge errors by this key: one missing pin is one fact,
   * however many requirers hit it. */
  name?: string;
  /** With `name`: the name the registry publishes that package under, where
   * it is required under another (see {@link Selected.publishedName}). */
  publishedName?: string;
  /** The node that declared the erring requirement (for the grouped render). */
  requiredBy?: string;
  /** Remedy line(s) a consumer attached (a concrete pin suggestion), rendered
   * as the diagnostic's `help`. */
  help?: string[];
}

/**
 * Defines how versions and version constraints behave for one package ecosystem
 * (semver for npm, maven versioning, PEP 440, etc).
 *
 * V is the (opaque to the resolver) parsed version type; C the parsed constraint type.
 */
export interface VersionDomain<V, C> {
  /**
   * Parse a constraint string as it appears in package metadata.
   * @throws if the constraint is syntactically invalid or uses features the
   *   domain does not support.
   */
  parseConstraint(text: string): C;

  /**
   * The constraint of a requirement that states no version: every version
   * satisfies it, and it is {@link isFloorless floorless}.
   */
  readonly unconstrained: C;

  /**
   * Total order on versions. Returns negative/zero/positive in the usual manner.
   */
  compare(a: V, b: V): number;

  /**
   * The minimum version admitted by the constraint. This is what makes MVS
   * deterministic: constraints are interpreted as lower bounds, so the result
   * can never be affected by newer versions being published.
   */
  minimumOf(constraint: C): V;

  /**
   * @return true if the constraint expresses no lower bound (its minimum is
   * the zero version): npm's '*' (ubiquitous among DefinitelyTyped
   * inter-package deps), and equally an upper-bound-only range ('<4.1.0'),
   * whose zero floor is fabricated by parsing rather than requested. Under
   * minimal version selection a requirement's contribution IS its declared
   * minimum, and a floorless requirement declares none — so it contributes no
   * selection of its own (demanding the fabricated floor would select, and try
   * to fetch, a version nothing asked for) and is satisfied by whichever
   * version(s) of the package the floored requirements select; {@link
   * satisfies} still enforces any upper bound, reported as an ordinary
   * violation. A package required ONLY floorless cannot be selected
   * deterministically (the resolver never consults the registry's version
   * list) and is reported as an error whose remedy is an explicit requirement.
   */
  isFloorless(constraint: C): boolean;

  /**
   * What a provided requirement outside the range of the selection it binds
   * comes to. It is never repaired by a fork — a private copy is the opposite
   * of provided — so the mismatch is either `"tolerate"`d (bound anyway and
   * recorded as {@link MVSResolution.shared}) or `"refuse"`d (a violation). An
   * ecosystem with provided requirements states which; absent refuses.
   */
  readonly providedMismatch?: "tolerate" | "refuse";

  /**
   * @return true if the version fully satisfies the constraint (including any
   * upper bounds, which minimumOf ignores). Used to detect conflicts after
   * selection.
   */
  satisfies(version: V, constraint: C): boolean;

  /**
   * Canonical string form of a version (for cache keys and diagnostics).
   */
  versionToString(version: V): string;

  /**
   * Parse the canonical form produced by {@link versionToString} — the other
   * half of the round-trip pair (e.g. reading versions back out of a persisted
   * resolution document). Throws on anything else.
   */
  parseVersion(text: string): V;

  /**
   * The exact version `text` names, when it is a single concrete version
   * rather than a range — undefined otherwise. What override markers demand
   * of their version (`pkg:1.4.2?`), and what lets an unmarked pin count as a
   * written version in sanction judgment. Optional: a domain without it
   * treats no constraint as exact.
   */
  exactVersion?(text: string): V | undefined;

  /**
   * Whether the version is suggestion-eligible (not a prerelease): the repair
   * suggester proposes only stable versions. Optional: a domain without it
   * treats every version as stable.
   */
  isStable?(version: V): boolean;
}

/**
 * What the resolution walk reads: the requirements a name@version declares, and
 * the floor-raise hook — resolveMVS's whole view of a registry (the full
 * registry surface, PackageResolver's `RepositoryReader`, extends this). All
 * answers are expected to be immutable documents (a given name@version never
 * changes its declared requirements), which is what makes resolution results
 * cacheable.
 */
export interface RequirementSource<V> {
  /**
   * @return the requirements declared by name@version (e.g. the dependencies
   * from its package.json). Rejects with a VersionNotFoundError (core/Errors)
   * when name@version was never published — the signal for the floor-raise
   * repair, distinguished from transport failures.
   */
  getRequirements(name: string, version: V): Computable<Requirement[]>;

  /**
   * Floor-raise hook: the lowest *published* version of `name` satisfying
   * `versionConstraint`, consulted when its own minimum is not published;
   * undefined when nothing published satisfies (a genuine failure). Reads a
   * mutable version list, so the result is deterministic only modulo registry
   * append — the one sanctioned relaxation, confined to broken floors. A
   * registry without this hook keeps unpublished floors as hard failures.
   */
  lowestAvailable?(name: string, versionConstraint: string): Computable<V | undefined>;
}
