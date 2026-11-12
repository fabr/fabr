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
 * The versions written requirements permit a strict collection to ship
 * together (their `?` markers and exact versions), and checks of a violation
 * against selections, for any {@link VersionDomain}.
 */

import { requiredAs, versionText } from "./Requirement";
import { PackageName, Requirement, Selected, VersionDomain, Violation } from "./Types";

/**
 * Get the canonical (`versionToString`) form of a written exact version, or
 * undefined where the text is a range or the domain has no `exactVersion`.
 * Store sanctioned versions in this form: they are compared with
 * `versionToString` of a selection, which `v1.4.2` would never match.
 */
function canonicalExactVersion<V, C>(domain: VersionDomain<V, C>, text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const exact = domain.exactVersion?.(text);
  return exact === undefined ? undefined : domain.versionToString(exact);
}

/** The versions the `?` requirements of a batch permit. */
export interface Sanctions {
  /** The canonical versions permitted, by package. */
  readonly versions: Map<PackageName, Set<string>>;
  /** The packages a `?` stating no version permits at every version. */
  readonly everyVersion: Set<PackageName>;
}

/**
 * Collect the versions the `?` requirements of a batch permit. Calls `fail`
 * with the package and a message where a package is both forced (`!`) and
 * permitted (`?`), or forced at two different versions; the caller
 * attributes the error to the written references.
 */
export function collectSanctions<V, C>(
  domain: VersionDomain<V, C>,
  requirements: readonly Requirement[],
  fail: (pkg: PackageName, message: string) => never
): Sanctions {
  const alternates = new Map<PackageName, Set<string>>();
  const everyVersion = new Set<PackageName>();
  for (const req of requirements) {
    if (req.override !== "alternate") {
      continue;
    }
    if (req.versionConstraint === undefined) {
      everyVersion.add(requiredAs(req));
    } else {
      const versions = alternates.get(requiredAs(req)) ?? new Set();
      alternates.set(requiredAs(req), versions.add(canonicalExactVersion(domain, req.versionConstraint) ?? req.versionConstraint));
    }
  }
  const contradicted = requirements.find(
    req => req.override === "force" && (alternates.has(requiredAs(req)) || everyVersion.has(requiredAs(req)))
  );
  if (contradicted) {
    fail(
      requiredAs(contradicted),
      `'${requiredAs(contradicted)}' is both forced ('!') and permitted as an alternate ('?') — pick one`
    );
  }
  const forcedAt = new Map<PackageName, string>();
  for (const req of requirements) {
    if (req.override !== "force" || req.versionConstraint === undefined) {
      continue;
    }
    const name = requiredAs(req);
    const existing = forcedAt.get(name);
    if (existing !== undefined && existing !== req.versionConstraint) {
      const shown = (text: string): string => versionText(text, name);
      fail(
        name,
        `'${name}' is forced ('!') at two different versions (${shown(existing)}, ${shown(req.versionConstraint)}) — pick one`
      );
    }
    forcedAt.set(name, req.versionConstraint);
  }
  return { versions: alternates, everyVersion };
}

/**
 * Collect the versions written per package, in canonical form: those of
 * `alternates`, and the exact versions among `demanded` (a range is not
 * one). A strict collection ships several versions of a package only where
 * each is written.
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
 * @return true if any of `selections` of the violated package, fork or not,
 * satisfies the violated constraint, otherwise false: false where no fork
 * repairs the violation.
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
    /* Unreachable: a violation's constraint parsed when it was found. */
    return false;
  }
  return selections.some(sel => sel.name === violation.name && domain.satisfies(sel.version, constraint));
}

/**
 * @return true if any of `selections` is a version of the violated package
 * that fails the violated constraint, otherwise false.
 */
export function violatedAmong<V, C>(
  domain: VersionDomain<V, C>,
  selections: readonly Selected<V>[],
  violation: Violation<V>
): boolean {
  let constraint: C;
  try {
    constraint = domain.parseConstraint(violation.versionConstraint);
  } catch {
    return true;
  }
  return selections.some(sel => sel.name === violation.name && !domain.satisfies(sel.version, constraint));
}
