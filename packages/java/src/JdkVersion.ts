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

import { FabrError, VersionDomain } from "@fabr-build/core";

/**
 * A JDK release's version, as its release name spells it less the `jdk-`
 * prefix: `17.0.12+7` (`$FEATURE.$INTERIM.$UPDATE.$PATCH+$BUILD`, trailing
 * numbers dropped where zero, as in `21+35`), Java 8's `8u302-b08`, either
 * with a rebuild's `.1` after the build (`17.0.9+9.1`, `8u422-b05.1`).
 */
export interface JdkVersion {
  /** The version numbers, Java 8's `8u302` as 8.0.302. */
  readonly numbers: readonly number[];
  readonly build: number;
  /** The rebuild of that build, 0 for the first. */
  readonly rebuild: number;
  /** The version as a reference writes it. */
  readonly text: string;
}

/**
 * What a reference to a JDK release asks for: one release, or every release
 * whose version numbers start with `numbers` (`21`, `17.0.12`, `8u302`).
 */
export type JdkConstraint = { readonly exact: JdkVersion } | { readonly numbers: readonly number[] };

const MODERN = /^(\d+(?:\.\d+)*)\+(\d+)(?:\.(\d+))?$/;
const LEGACY = /^(\d+)u(\d+)-b(\d+)(?:\.(\d+))?$/;
const MODERN_PREFIX = /^\d+(?:\.\d+)*$/;
const LEGACY_PREFIX = /^(\d+)u(\d+)$/;

/** Parse a release's version (`17.0.12+7`, `8u302-b08`). Throws on anything else. */
function parseJdkVersion(text: string): JdkVersion {
  const modern = MODERN.exec(text);
  if (modern) {
    return { numbers: modern[1].split(".").map(Number), build: Number(modern[2]), rebuild: Number(modern[3] ?? 0), text };
  }
  const legacy = LEGACY.exec(text);
  if (legacy) {
    return { numbers: [Number(legacy[1]), 0, Number(legacy[2])], build: Number(legacy[3]), rebuild: Number(legacy[4] ?? 0), text };
  }
  throw new FabrError(`'${text}' is not a JDK release version`);
}

/** Compare two releases' version numbers, a missing number as 0, then their builds and rebuilds. */
function compareJdkVersions(a: JdkVersion, b: JdkVersion): number {
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i++) {
    const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a.build - b.build || a.rebuild - b.rebuild;
}

/** Parse a reference's version: an exact release, or a prefix of version numbers (`21`, `8u302`, `*` for every release). */
function parseJdkConstraint(text: string): JdkConstraint {
  if (text === "*") {
    return { numbers: [] };
  }
  if (MODERN_PREFIX.test(text)) {
    return { numbers: text.split(".").map(Number) };
  }
  const legacy = LEGACY_PREFIX.exec(text);
  if (legacy) {
    return { numbers: [Number(legacy[1]), 0, Number(legacy[2])] };
  }
  return { exact: parseJdkVersion(text) };
}

/** The version domain of Temurin JDK releases. */
export const JDK_VERSIONS: VersionDomain<JdkVersion, JdkConstraint> = {
  parseConstraint: parseJdkConstraint,
  unconstrained: { numbers: [] },
  compare: compareJdkVersions,

  minimumOf(constraint: JdkConstraint): JdkVersion {
    return "exact" in constraint
      ? constraint.exact
      : { numbers: constraint.numbers, build: 0, rebuild: 0, text: `${constraint.numbers.join(".") || "0"}+0` };
  },

  isFloorless(constraint: JdkConstraint): boolean {
    return !("exact" in constraint) && constraint.numbers.length === 0;
  },

  satisfies(version: JdkVersion, constraint: JdkConstraint): boolean {
    return "exact" in constraint
      ? compareJdkVersions(version, constraint.exact) === 0
      : constraint.numbers.every((n, i) => (version.numbers[i] ?? 0) === n);
  },

  versionToString: version => version.text,
  parseVersion: parseJdkVersion,

  exactVersion(text: string): JdkVersion | undefined {
    try {
      return parseJdkVersion(text);
    } catch {
      return undefined;
    }
  },
};
