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
}

/**
 * The complete result of a resolution: the selected package versions, plus any
 * constraint violations or unparseable constraints encountered along the way.
 *
 * Violations are reported as data rather than by rejecting the Computable, both
 * so that callers can decide how to present them, and because a rejected
 * Computable currently halts the graph without user-visible diagnostics.
 */
export interface Resolution<V> {
  selections: Selected<V>[];
  errors: string[];
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
   * @return true if the version fully satisfies the constraint (including any
   * upper bounds, which minimumOf ignores). Used to detect conflicts after
   * selection.
   */
  satisfies(version: V, constraint: C): boolean;

  /**
   * The unit of coexistence: requirements with the same resolution key must
   * resolve to a single version, while different keys may coexist in a build.
   * e.g. npm allows one version per major ("pkg@1"), while Go and Maven
   * allow only one version per package name.
   */
  resolutionKey(pkg: string, constraint: C): string;

  /**
   * Canonical string form of a version (for cache keys and diagnostics).
   */
  versionToString(version: V): string;
}

/**
 * Read access to package metadata within a repository. All answers are expected
 * to be immutable documents (a given pkg@version never changes its declared
 * requirements), which is what makes resolution results cacheable.
 */
export interface PackageRegistry<V> {
  /**
   * @return the requirements declared by pkg@version (e.g. the dependencies
   * from its package.json).
   */
  getRequirements(pkg: string, version: V): Computable<Requirement[]>;
}
