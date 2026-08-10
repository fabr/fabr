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
 * The user-facing override vocabulary, ecosystem-generic: the `?`/`!` version
 * markers as written (parsing), and the sanction judgment a strict delivery
 * applies against them. A repository contributes only its own reference
 * grammar (where the version slot is) and its `VersionDomain`; everything
 * here is shared by any ecosystem that resolves through the MVS core.
 */

import { Requirement, Selected, VersionDomain, Violation } from "./Types";

/**
 * Split a written version slot's trailing override marker: `1.4.2?` (permitted
 * alternate) / `2.0.0!` (forced version). Pure text — the caller validates the
 * remainder against its domain (markers demand an exact version) and reports
 * in its own reference grammar.
 */
export function splitOverrideMarker(written: string): { text: string; override?: "alternate" | "force" } {
  if (written.endsWith("?")) {
    return { text: written.slice(0, -1), override: "alternate" };
  }
  if (written.endsWith("!")) {
    return { text: written.slice(0, -1), override: "force" };
  }
  return { text: written };
}

/**
 * A requirement's canonical identity, marker included: an override changes
 * what resolution means (a force substitutes outright; an alternate can
 * supply a floorless-only package's version), so the marker is part of the
 * identity — hence of any resolution memo key built from these.
 */
export function requirementKey(req: Requirement): string {
  const marker = req.override === "force" ? "!" : req.override === "alternate" ? "?" : "";
  return `${req.pkg}:${req.constraint}${marker}`;
}

/**
 * Requirements deduplicated and canonically ordered by {@link requirementKey}
 * — the one root-set form everything downstream shares: a resolution (and its
 * memo key, and the root indices a resolution's `reachableFrom` refers to)
 * must be independent of the order references were written in.
 */
export function canonicalRequirements(requirements: readonly Requirement[]): { roots: Requirement[]; keys: string[] } {
  const byKey = new Map<string, Requirement>(requirements.map(req => [requirementKey(req), req]));
  const keys = [...byKey.keys()].sort();
  return { roots: keys.map(key => byKey.get(key)!), keys };
}

/**
 * The canonical (`versionToString`) form of a written exact version, or
 * undefined when the text is a range (or the domain has no exact-version
 * notion). Every sanction set must store this form: {@link allSanctioned}
 * compares against `versionToString(selection)`, so a non-canonical spelling
 * (`v1.4.2`, `1.4.2+build`) recorded verbatim could never match.
 */
export function canonicalExactVersion<V, C>(domain: VersionDomain<V, C>, text: string): string | undefined {
  const exact = domain.exactVersion?.(text);
  return exact === undefined ? undefined : domain.versionToString(exact);
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
    const exact = canonicalExactVersion(domain, req.constraint);
    if (exact === undefined) {
      continue;
    }
    const versions = written.get(req.pkg) ?? new Set();
    written.set(req.pkg, versions.add(exact));
  }
  return written;
}

/**
 * The sanction rule, a pure set comparison: every version of `pkg` in the
 * delivered set must be explicitly written. One `?` alone would implicitly
 * bless coexistence with whatever the rest of the tree resolves to, so drift
 * on ANY side re-errors loudly, with the unallowed version(s) named (see
 * the conflict report).
 */
export function allSanctioned<V, C>(
  domain: VersionDomain<V, C>,
  needed: readonly Selected<V>[],
  written: ReadonlyMap<string, ReadonlySet<string>>,
  pkg: string
): boolean {
  const allowed = written.get(pkg);
  return allowed !== undefined && needed.every(sel => sel.pkg !== pkg || allowed.has(domain.versionToString(sel.version)));
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
    constraint = domain.parseConstraint(violation.constraint);
  } catch {
    /* Unparseable constraints are hard errors at resolve; a violation's
     * constraint always parsed there. */
    return false;
  }
  return selections.some(sel => sel.pkg === violation.pkg && domain.satisfies(sel.version, constraint));
}
