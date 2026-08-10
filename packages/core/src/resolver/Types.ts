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

/**
 * A single declared dependency: some version of `pkg` satisfying `constraint`,
 * where the constraint syntax is interpreted by the ecosystem's VersionDomain.
 */
export interface Requirement {
  pkg: string;
  constraint: string;
  /**
   * The name the requirer knows this dependency by, when that differs from the
   * package's own name (npm's `"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"`,
   * Cargo's `package =` rename). Purely local: resolution is by `pkg`, so an
   * aliased requirement participates in the joint selection exactly as an
   * ordinary one — the alias survives only as the name the requirer's own
   * imports use, hence as the name a consumer must lay the result out under
   * (the requirer's code literally `require`s it).
   */
  alias?: string;
  /**
   * Attach-first (peer) semantics: primarily a constraint on whatever the tree
   * selects for `pkg` — satisfied by any selection in range — demanding its
   * own minimum only when the converged tree selects nothing for the package
   * at all (npm's peer auto-install as a last resort). This is what keeps a
   * wide multi-major peer range (chai '>= 2.1.2 < 5') from demanding the
   * range's floor beside an already-satisfying selection.
   */
  soft?: boolean;
  /**
   * A user-written override marker on the requirement's exact version
   * (`@npm:pkg:1.4.2?` / `@npm:pkg:2.0.0!`; the constraint carries the bare
   * version, the marker rides here):
   *
   * - `"force"` (`!`) — full substitution, npm-`overrides` semantics: every
   *   requirement on the package, from any requirer, is replaced by exactly
   *   this version at resolve time. Ranges the forced version does not
   *   satisfy are recorded as {@link MVSResolution.coerced} — data, never
   *   violations. Participates in resolution (and its memo identity).
   * - `"alternate"` (`?`) — a judgment-time sanction, never a demand: it
   *   contributes no floor and is excluded from the resolver's roots
   *   entirely (the consumer applies it when judging violations at
   *   delivery). Listed here for the parse's completeness; the resolver
   *   never sees one.
   */
  override?: "alternate" | "force";
}

/**
 * The distinguished `requiredBy` value identifying a root requirement (one
 * passed directly to the resolver, rather than declared by a package).
 */
export const ROOT_REQUIRER = "(root)";

/**
 * A requirement edge in the dependency graph, for provenance: the node that
 * declared the requirement ("pkg@version", or ROOT_REQUIRER for a root
 * requirement) and the constraint it declared.
 */
export interface IRequirementEdge {
  requiredBy: string;
  constraint: string;
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
  pkg: string;
  version: V;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  /**
   * Indices into the resolution's root list identifying which root
   * requirements (transitively) reach this selection — the basis for carving
   * a joint resolution into per-root subsets.
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

/**
 * An upper-bound violation found after selection: `requiredBy` declared
 * `constraint` on `pkg`, and the principal selection of the package does not
 * satisfy it (jointly-unsatisfiable constraints — an exact transitive pin
 * against a higher floor, or ranges confined to different majors). Reported as
 * data: the consumer decides whether it is an error (a linked delivery) or is
 * repaired by the fork selection the resolver packed its edge into (a sealed
 * tool delivery, which nests the fork privately). A violation no fork repairs
 * — nothing published satisfies its constraint — is undeliverable in every
 * mode; a consumer detects that by checking the selections (no selection of
 * `pkg` satisfies `constraint`).
 */
export interface Violation<V> {
  pkg: string;
  constraint: string;
  requiredBy: string;
  selected: V;
}

/**
 * A floor-raise repair: `constraint`'s declared minimum was never published, so
 * the lowest *published* satisfying version was selected in its place (via the
 * registry's {@link RequirementSource.lowestAvailable} hook). Only raises whose
 * raised version made the result are reported — a raise superseded by a higher
 * requirement's floor never shaped it.
 */
export interface RaisedFloor<V> {
  pkg: string;
  constraint: string;
  declared: V;
  raised: V;
  requiredBy: string;
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
   * `constraint` on `pkg`, and the forced version (`selected`) does not
   * satisfy it. The force suppresses the conflict by design — these are
   * recorded so the coercion is explainable, never judged as violations (no
   * fork is packed for them and no delivery refuses them).
   */
  coerced: Violation<V>[];
  raises: RaisedFloor<V>[];
  /**
   * The declared requirements of each selected node ({@link nodeId} → its
   * requirements), i.e. the resolution's edges as the packages declared them.
   * The walk collects these to compute reachability; handing them back is what
   * lets a consumer lay the result out — where each edge leads is a pure
   * function of these plus {@link MVSResolution.selections} (see edgeTargets),
   * so a layout needs no second read of package metadata. Pruned nodes are not
   * listed: only what the resolution selected.
   */
  requirements: Map<string, Requirement[]>;
}

/**
 * A hard resolution error, attributed to the root package whose subtree
 * contains it — the errors' analogue of MetadataFetchError's rootPkg, so a
 * repository can map the failure back to the written reference(s) requiring
 * that root rather than reporting it against the whole collection point.
 */
export interface IResolutionError {
  message: string;
  /** The root requirement whose subtree reached the error; the erring
   * requirement's own package when it is itself a root. */
  rootPkg: string;
  /** For a required-only-floorless error: the package that lacks any versioned
   * requirement (the remedy — an explicit requirement — names it). A consumer
   * groups the per-edge errors by this key: one missing pin is one fact,
   * however many requirers hit it. */
  pkg?: string;
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
 * What the resolution walk reads: the requirements a pkg@version declares, and
 * the floor-raise hook — resolveMVS's whole view of a registry (the full
 * registry surface, PackageResolver's `RepositoryReader`, extends this). All
 * answers are expected to be immutable documents (a given pkg@version never
 * changes its declared requirements), which is what makes resolution results
 * cacheable.
 */
export interface RequirementSource<V> {
  /**
   * @return the requirements declared by pkg@version (e.g. the dependencies
   * from its package.json). Rejects with a VersionNotFoundError (core/Errors)
   * when pkg@version was never published — the signal for the floor-raise
   * repair, distinguished from transport failures.
   */
  getRequirements(pkg: string, version: V): Computable<Requirement[]>;

  /**
   * Floor-raise hook: the lowest *published* version of `pkg` satisfying
   * `constraint`, consulted when the constraint's own minimum is not published;
   * undefined when nothing published satisfies (a genuine failure). Reads a
   * mutable version list, so the result is deterministic only modulo registry
   * append — the one sanctioned relaxation, confined to broken floors. A
   * registry without this hook keeps unpublished floors as hard failures.
   */
  lowestAvailable?(pkg: string, constraint: string): Computable<V | undefined>;
}
