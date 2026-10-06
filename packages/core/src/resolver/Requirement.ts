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
 * Reading a {@link Requirement}, ecosystem-generic: the name its package is
 * required as, its identity (the key a root set and a resolution memo are
 * built from), the constraint its stated version makes, and the spelling of
 * the override marker written on that version.
 */

import { Requirement, VersionDomain, Violation } from "./Types";

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

/** The marker an override is written with (`?` / `!`), or none. */
export function markerOf(override: Requirement["override"]): "" | "?" | "!" {
  return override === "force" ? "!" : override === "alternate" ? "?" : "";
}

/**
 * The name a requirement's package is **required as**: its rename where it has
 * one, else the package's own. A renamed package is a package of that name —
 * selected, installed and known by it; only the registry is asked for it
 * under the name it publishes ({@link Selected.publishedName}).
 */
export function requiredAs(req: Requirement): string {
  return req.renameTo ?? req.name;
}

/**
 * A requirement's canonical identity, marker, rename and role included: an
 * override changes what resolution means (a force substitutes outright; an
 * alternate can supply a floorless-only package's version), a rename makes it
 * a requirement on a package of another name, and being provided demands
 * nothing where the tree already selects the package — so all three are part
 * of the identity, hence of any resolution memo key built from these.
 */
export function requirementKey(req: Requirement): string {
  const role = req.provided === undefined ? "" : req.provided === "optional" ? " (optionally provided)" : " (provided)";
  const rename = requiredAs(req) === req.name ? "" : ` -> ${req.renameTo}`;
  return `${req.versionConstraint === undefined ? req.name : `${req.name}:${req.versionConstraint}`}${markerOf(req.override)}${rename}${role}`;
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
 * The constraint a requirement's stated version makes — every version, where
 * it states none.
 */
export function constraintOf<V, C>(domain: VersionDomain<V, C>, versionConstraint: string | undefined): C {
  return versionConstraint === undefined ? domain.unconstrained : domain.parseConstraint(versionConstraint);
}

/** A requirement's version constraint as a message quotes it. */
export function versionConstraintText(versionConstraint: string | undefined): string {
  return versionConstraint === undefined ? "any version" : `'${versionConstraint}'`;
}

/**
 * The keys a violation recorded against one of these root requirements has
 * (a {@link Violation} states the package and constraint alone). A forced
 * root is never violated and an alternate is never demanded, so neither has
 * one.
 */
export function violationKeys(roots: readonly Requirement[]): Set<string> {
  return new Set(roots.filter(req => req.override === undefined).map(req => `${requiredAs(req)}\n${req.versionConstraint}`));
}

/** The key of the root requirement a violation was recorded against. */
export function violationKey<V>(violation: Violation<V>): string {
  return `${violation.name}\n${violation.versionConstraint}`;
}

/** How a package with no version is written where a version would be. */
export const UNVERSIONED = "*";

/**
 * `domain`, over versions that may be absent: a package with no version — one
 * built in the project and not yet given one — answers whatever is asked of
 * it, since nothing else answers to its name, and orders below any version.
 */
export function allowingUnversioned<V, C>(domain: VersionDomain<V, C>): VersionDomain<V | undefined, C> {
  /* One per domain: a domain's identity is how deliveries are told to belong
   * together. */
  const held = UNVERSIONED_DOMAINS.get(domain) as VersionDomain<V | undefined, C> | undefined;
  if (held !== undefined) {
    return held;
  }
  const isStable = domain.isStable?.bind(domain);
  const lifted: VersionDomain<V | undefined, C> = {
    ...domain,
    compare: (a, b) => (a === undefined ? (b === undefined ? 0 : -1) : b === undefined ? 1 : domain.compare(a, b)),
    satisfies: (version, constraint) => version === undefined || domain.satisfies(version, constraint),
    versionToString: version => (version === undefined ? UNVERSIONED : domain.versionToString(version)),
    parseVersion: text => (text === UNVERSIONED ? undefined : domain.parseVersion(text)),
    ...(isStable === undefined ? {} : { isStable: (version: V | undefined) => version === undefined || isStable(version) }),
  };
  UNVERSIONED_DOMAINS.set(domain, lifted);
  return lifted;
}

const UNVERSIONED_DOMAINS = new WeakMap<object, object>();
