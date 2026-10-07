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
 * The judgment of a user's **overrides**, ecosystem-generic: what the `?`/`!`
 * markers on written requirements sanction, and whether a delivery's versions
 * stay within it. A repository contributes only its `VersionDomain`;
 * everything here is shared by any ecosystem that resolves through the MVS
 * core. (The markers' spelling is read in Requirement.ts.)
 */

import { requiredAs } from "./Requirement";
import { PackageName, Requirement, Selected, VersionDomain, Violation } from "./Types";

/**
 * The canonical (`versionToString`) form of a written exact version, or
 * undefined when the text is a range (or the domain has no exact-version
 * notion). Every sanction set must store this form: the sanction judgment
 * compares against `versionToString(selection)`, so a non-canonical spelling
 * (`v1.4.2`, `1.4.2+build`) recorded verbatim could never match.
 */
function canonicalExactVersion<V, C>(domain: VersionDomain<V, C>, text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const exact = domain.exactVersion?.(text);
  return exact === undefined ? undefined : domain.versionToString(exact);
}

/**
 * Collect the `?` sanctions written in a batch (pkg → the canonical exact
 * versions whose forks a strict delivery may accept), rejecting the
 * contradictory marker combinations — a package both forced and alternated,
 * or forced at two different versions — via `fail`, which the caller supplies
 * so the error is attributed to the written references (this module stays
 * reference-free).
 */
export function collectSanctions<V, C>(
  domain: VersionDomain<V, C>,
  requirements: readonly Requirement[],
  fail: (pkg: PackageName, message: string) => never
): Map<PackageName, Set<string>> {
  const alternates = new Map<PackageName, Set<string>>();
  for (const req of requirements) {
    if (req.override === "alternate" && req.versionConstraint !== undefined) {
      const versions = alternates.get(requiredAs(req)) ?? new Set();
      /* Canonical form: the sanction judgment compares versionToString. */
      alternates.set(requiredAs(req), versions.add(canonicalExactVersion(domain, req.versionConstraint) ?? req.versionConstraint));
    }
  }
  const contradicted = requirements.find(req => req.override === "force" && alternates.has(requiredAs(req)));
  if (contradicted) {
    fail(
      requiredAs(contradicted),
      `'${requiredAs(contradicted)}' is both forced ('!') and permitted as an alternate ('?') — pick one`
    );
  }
  /* Two forces at different versions are equally contradictory — the
   * resolver would have to pick one silently. */
  const forcedAt = new Map<PackageName, string>();
  for (const req of requirements) {
    if (req.override !== "force" || req.versionConstraint === undefined) {
      continue;
    }
    const name = requiredAs(req);
    const existing = forcedAt.get(name);
    if (existing !== undefined && existing !== req.versionConstraint) {
      fail(name, `'${name}' is forced ('!') at two different versions (${existing}, ${req.versionConstraint}) — pick one`);
    }
    forcedAt.set(name, req.versionConstraint);
  }
  return alternates;
}

/**
 * The versions the user explicitly WROTE per package — `?` sanctions plus
 * exact unmarked pins (the catalog form; recognized via the domain's
 * `exactVersion`, so a range stays a floor, not a written version), all in
 * canonical `versionToString` form. This is the right-hand side of the
 * sanction rule: a strict delivery ships only version sets ⊆ what was written.
 */
export function writtenVersions<V, C>(
  domain: VersionDomain<V, C>,
  alternates: ReadonlyMap<string, ReadonlySet<string>>,
  demanded: readonly Requirement[]
): Map<string, ReadonlySet<string>> {
  const written = new Map<string, Set<string>>();
  for (const [pkg, versions] of alternates) {
    written.set(pkg, new Set(versions));
  }
  for (const req of demanded) {
    const exact = canonicalExactVersion(domain, req.versionConstraint);
    if (exact === undefined) {
      continue;
    }
    const versions = written.get(requiredAs(req)) ?? new Set();
    written.set(requiredAs(req), versions.add(exact));
  }
  return written;
}

/**
 * Whether any selection of the violated package — principal or fork —
 * satisfies the violated constraint: the test for whether the resolver could
 * repair the edge at all. Nothing published satisfies an unrepaired one, so
 * no delivery mode (and no sanction) can honor it.
 */
export function satisfiedByAnySelection<V, C>(
  domain: VersionDomain<V, C>,
  selections: readonly Selected<V>[],
  violation: Violation<V>
): boolean {
  let constraint: C;
  try {
    constraint = domain.parseConstraint(violation.versionConstraint);
  } catch {
    /* Unparseable constraints are hard errors at resolve; a violation's
     * constraint always parsed there. */
    return false;
  }
  return selections.some(sel => sel.name === violation.name && domain.satisfies(sel.version, constraint));
}

/**
 * Whether any of `selections` is a version of the violated package that fails
 * the violated constraint — the violation as it stands among these selections
 * rather than against the resolution's principal.
 */
export function violatedAmong<V, C>(domain: VersionDomain<V, C>, selections: readonly Selected<V>[], violation: Violation<V>): boolean {
  let constraint: C;
  try {
    constraint = domain.parseConstraint(violation.versionConstraint);
  } catch {
    return true;
  }
  return selections.some(sel => sel.name === violation.name && !domain.satisfies(sel.version, constraint));
}
