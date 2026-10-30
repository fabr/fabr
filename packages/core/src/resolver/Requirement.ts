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
 * the override marker written on that version. Also the versions of packages
 * built in the project ({@link BUILDS_ALONE}) and the domain a resolution
 * holding them runs over ({@link allowingBuilds}).
 */

import { compareText } from "../support/Functional";
import { Requirement, VersionDomain, Violation } from "./Types";

/** Get the marker an override is written with (`?` / `!`), or none. */
export function markerOf(override: Requirement["override"]): "" | "?" | "!" {
  return override === "force" ? "!" : override === "alternate" ? "?" : "";
}

/**
 * Get the name a requirement's package is **required as**: its rename where it
 * has one, else the package's own. A renamed package is a package of that
 * name — selected, installed and known by it; only the registry is asked for
 * it under the name it publishes (`Selected.publishedName`).
 */
export function requiredAs(req: Requirement): string {
  return req.renameTo ?? req.name;
}

/** @return the name the variant `variant` of the package `name` is installed as: `<name>/<variant>`. */
export function variantName(name: string, variant: string): string {
  return `${name}/${variant}`;
}

/**
 * @return the name a requirement's edge has in its requirer: the name it is
 * required as, and for a variant, the variant's name under it.
 */
export function dependencyNameOf(req: Requirement): string {
  return req.variant === undefined ? requiredAs(req) : variantName(requiredAs(req), req.variant);
}

/**
 * Make a requirement's canonical identity, marker, rename and role included:
 * an override changes what resolution means (a force substitutes outright; an
 * alternate can supply a floorless-only package's version), a rename makes it
 * a requirement on a package of another name, and being provided demands
 * nothing where the tree already selects the package, and a variant installs
 * other content — so all four are part
 * of the identity, hence of any resolution memo key built from these.
 */
export function requirementKey(req: Requirement): string {
  const role = req.provided === undefined ? "" : req.provided === "optional" ? " (optionally provided)" : " (provided)";
  const rename = requiredAs(req) === req.name ? "" : ` -> ${req.renameTo}`;
  const name = req.variant === undefined ? req.name : variantName(req.name, req.variant);
  return `${req.versionConstraint === undefined ? name : `${name}:${req.versionConstraint}`}${markerOf(req.override)}${rename}${role}`;
}

/**
 * Deduplicate requirements and order them canonically by {@link
 * requirementKey} — the one root-set form everything downstream shares: a
 * resolution (and its memo key, and the root indices a resolution's
 * `reachableFrom` refers to) must be independent of the order references were
 * written in.
 */
export function canonicalRequirements(requirements: readonly Requirement[]): { roots: Requirement[]; keys: string[] } {
  const byKey = new Map<string, Requirement>(requirements.map(req => [requirementKey(req), req]));
  const keys = [...byKey.keys()].sort();
  return { roots: keys.map(key => byKey.get(key)!), keys };
}

/**
 * Make the constraint a requirement's stated version makes — every version,
 * where it states none.
 */
export function constraintOf<V, C>(domain: VersionDomain<V, C>, versionConstraint: string | undefined): C {
  return versionConstraint === undefined ? domain.unconstrained : domain.parseConstraint(versionConstraint);
}

/** Format a version of `name`, as its domain writes it, for a message: a
 * build as the reference to it. */
export function versionText(version: string, name: string): string {
  return isBuildVersion(version) ? buildReference(name, version) : version;
}

/** Write the reference to the build `version` names, as a message suggests
 * writing it: the target's name, with the configuration that tells it apart. */
export function buildReference(name: string, version: string, marker?: "?" | "!"): string {
  const configuration = version.slice(BUILD_PREFIX.length, version.lastIndexOf(" #")).trim();
  return `${name}${configuration === "" ? "" : `<${configuration}>`}${marker ?? ""}`;
}

/** Format a requirement's version constraint for a message: a build as the
 * reference to it where the package's `name` is given. */
export function versionConstraintText(versionConstraint: string | undefined, name?: string): string {
  if (versionConstraint === undefined) {
    return "any version";
  }
  if (isBuildVersion(versionConstraint)) {
    return name === undefined ? "a build" : `'${buildReference(name, versionConstraint)}'`;
  }
  return `'${versionConstraint}'`;
}

/**
 * Make the keys a violation recorded against one of these root requirements has
 * (a {@link Violation} states the package and constraint alone). A forced
 * root is never violated and an alternate is never demanded, so neither has
 * one.
 */
export function violationKeys(roots: readonly Requirement[]): Set<string> {
  return new Set(roots.filter(req => req.override === undefined).map(req => `${requiredAs(req)}\n${req.versionConstraint}`));
}

/** Make the key of the root requirement a violation was recorded against. */
export function violationKey<V>(violation: Violation<V>): string {
  return `${violation.name}\n${violation.versionConstraint}`;
}

/**
 * Make the key of a package built in the project: its version in
 * {@link BUILDS_ALONE}, and the constraint naming it exactly. It is written
 * with the configuration that tells it from the other builds of its name and
 * a digest of what it is (`<build BUILD_TYPE=release #1a2b3c4d>`).
 */
export function buildKey(configuration: string, digest: string): string {
  return `${BUILD_PREFIX}${configuration === "" ? "" : ` ${configuration}`} #${digest}>`;
}

/** @return true if `value`, a version, a constraint or the text of either, is
 * a build's version (its key, which is also the constraint naming it),
 * otherwise false. */
export function isBuildVersion(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(BUILD_PREFIX);
}

const BUILD_PREFIX = "<build";

/**
 * The versions of packages built in the project: each build is its key
 * ({@link buildKey}), which is also the only constraint it satisfies. Nothing
 * is published in it, so a constraint that is no build's key is floorless and
 * answered by none. Builds order by their keys.
 */
export const BUILDS_ALONE: VersionDomain<string, string> = {
  parseConstraint: text => {
    if (!isBuildVersion(text)) {
      throw new Error(`'${text}' asks for a published version, and none is in reach here`);
    }
    return text;
  },
  /* No build's key: floorless and answered by none, as every constraint that
   * is no key is. Reached only by a requirement stating no version, which no
   * requirement among builds alone makes (each names a build). */
  unconstrained: "",
  compare: compareText,
  minimumOf: constraint => {
    if (!isBuildVersion(constraint)) {
      throw new Error("internal: nothing is published among builds alone");
    }
    return constraint;
  },
  isFloorless: constraint => !isBuildVersion(constraint),
  satisfies: (version, constraint) => version === constraint,
  versionToString: version => version,
  parseVersion: text => {
    if (!isBuildVersion(text)) {
      throw new Error(`'${text}' names a published version, and none is in reach here`);
    }
    return text;
  },
  exactVersion: text => (isBuildVersion(text) ? text : undefined),
};

/**
 * Make the domain of `domain`'s versions and {@link BUILDS_ALONE}'s together,
 * for a resolution with packages built in the project among its candidates.
 * Each answers only its own constraints, so a build answers no version range
 * (a build the collection requests itself answers the other requirements on
 * its name by being forced), and a build ranks above every version of
 * `domain`. A version of `domain` must not be a string.
 */
export function allowingBuilds<V, C>(domain: VersionDomain<V, C>): VersionDomain<V | string, C | string> {
  const isStable = domain.isStable?.bind(domain);
  const exactVersion = domain.exactVersion?.bind(domain);
  return {
    ...domain,
    parseConstraint: text => (isBuildVersion(text) ? BUILDS_ALONE.parseConstraint(text) : domain.parseConstraint(text)),
    minimumOf: constraint => (isBuildVersion(constraint) ? BUILDS_ALONE.minimumOf(constraint) : domain.minimumOf(constraint as C)),
    isFloorless: constraint => !isBuildVersion(constraint) && domain.isFloorless(constraint as C),
    compare: (a, b) =>
      isBuildVersion(a) ? (isBuildVersion(b) ? BUILDS_ALONE.compare(a, b) : 1) : isBuildVersion(b) ? -1 : domain.compare(a as V, b as V),
    /* A build answers the constraint naming it, and a floorless one (`*`),
     * which any selection answers; a range is a demand on the registry. */
    satisfies: (version, constraint) =>
      isBuildVersion(constraint)
        ? isBuildVersion(version) && BUILDS_ALONE.satisfies(version, constraint)
        : isBuildVersion(version)
        ? domain.isFloorless(constraint as C)
        : domain.satisfies(version as V, constraint as C),
    versionToString: version => (isBuildVersion(version) ? version : domain.versionToString(version as V)),
    parseVersion: text => (isBuildVersion(text) ? text : domain.parseVersion(text)),
    exactVersion: text => (isBuildVersion(text) ? text : exactVersion?.(text)),
    ...(isStable === undefined ? {} : { isStable: (version: V | string) => isBuildVersion(version) || isStable(version as V) }),
  };
}
