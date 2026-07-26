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

import { VersionDomain } from "./Types";

/**
 * npm-flavoured semver, supporting the constraint forms that appear in practice
 * in package dependencies: exact versions, caret and tilde ranges, comparators
 * (>=, >, <, <=, =, with or without whitespace before the version, per npm)
 * and space-separated conjunctions thereof, x-ranges
 * (1.x, 1.2.x, bare 1 or 1.2, *), hyphen ranges ('1.2.3 - 2.3.4'), and '||'
 * disjunctions.
 *
 * Not supported (parseConstraint throws): dist-tags. Prerelease versions are
 * ordered per the semver spec, but the npm rule that prereleases only match
 * ranges explicitly mentioning a prerelease of the same triple is not
 * implemented (plain ordering is used instead).
 */

export interface SemverVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
}

/**
 * A contiguous version interval. min is always present (0.0.0 for unbounded);
 * max of undefined means unbounded above.
 */
interface IRange {
  min: SemverVersion;
  minInclusive: boolean;
  max?: SemverVersion;
  maxInclusive: boolean;
}

/**
 * A constraint is a disjunction ('||') of ranges.
 */
export interface SemverConstraint {
  ranges: IRange[];
}

/**
 * A version pattern as written in a range, where trailing components may be
 * omitted or wildcarded (undefined = unspecified/wildcard).
 */
interface IPartialVersion {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: Array<string | number>;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

const ZERO_VERSION: SemverVersion = { major: 0, minor: 0, patch: 0, prerelease: [] };

export function parseVersion(text: string): SemverVersion {
  const m = VERSION_RE.exec(text.trim());
  if (!m) {
    throw new Error(`Invalid semver version '${text}'`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? parsePrerelease(m[4]) : [],
  };
}

export function versionToString(version: SemverVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length > 0 ? `${base}-${version.prerelease.join(".")}` : base;
}

export function compareVersions(a: SemverVersion, b: SemverVersion): number {
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease)
  );
}

function parsePrerelease(text: string): Array<string | number> {
  return text.split(".").map(id => (/^\d+$/.test(id) ? Number(id) : id));
}

function comparePrerelease(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number {
  /* A version without a prerelease sorts above any prerelease of the same triple */
  if (a.length === 0) {
    return b.length === 0 ? 0 : 1;
  } else if (b.length === 0) {
    return -1;
  }
  for (let idx = 0; idx < a.length && idx < b.length; idx++) {
    const l = a[idx];
    const r = b[idx];
    if (l !== r) {
      if (typeof l === "number" && typeof r === "number") {
        return l - r;
      } else if (typeof l === "number") {
        return -1; /* Numeric identifiers sort below alphanumeric */
      } else if (typeof r === "number") {
        return 1;
      } else {
        return l < r ? -1 : 1;
      }
    }
  }
  return a.length - b.length;
}

function parsePartial(text: string): IPartialVersion {
  const m = PARTIAL_RE.exec(text);
  if (!m) {
    throw new Error(`Invalid semver range component '${text}'`);
  }
  const component = (value: string | undefined): number | undefined =>
    value === undefined || /[xX*]/.test(value) ? undefined : Number(value);
  return {
    major: component(m[1]),
    minor: component(m[2]),
    patch: component(m[3]),
    prerelease: m[4] ? parsePrerelease(m[4]) : [],
  };
}

function lowerOf(p: IPartialVersion): SemverVersion {
  return { major: p.major ?? 0, minor: p.minor ?? 0, patch: p.patch ?? 0, prerelease: p.prerelease };
}

/**
 * The exclusive upper bound implied by the unspecified components of a partial
 * version (e.g. 1.2 -> 1.3.0, 1 -> 2.0.0), or undefined if fully unbounded.
 */
function upperOfPartial(p: IPartialVersion): SemverVersion | undefined {
  if (p.major === undefined) {
    return undefined;
  } else if (p.minor === undefined) {
    return { major: p.major + 1, minor: 0, patch: 0, prerelease: [] };
  } else if (p.patch === undefined) {
    return { major: p.major, minor: p.minor + 1, patch: 0, prerelease: [] };
  } else {
    return undefined; /* Fully specified: no implied upper bound */
  }
}

/**
 * '^' fixes the leftmost non-zero component (^1.2.3 -> <2.0.0, ^0.2.3 -> <0.3.0,
 * ^0.0.3 -> <0.0.4); unspecified trailing components widen accordingly.
 */
function caretRange(p: IPartialVersion, lower: SemverVersion): IRange {
  if (p.major === undefined) {
    return { min: ZERO_VERSION, minInclusive: true, maxInclusive: false };
  }
  let max: SemverVersion;
  if (p.major > 0) {
    max = { major: p.major + 1, minor: 0, patch: 0, prerelease: [] };
  } else if (p.minor === undefined) {
    max = { major: 1, minor: 0, patch: 0, prerelease: [] };
  } else if (p.minor > 0 || p.patch === undefined) {
    max = { major: 0, minor: p.minor + 1, patch: 0, prerelease: [] };
  } else {
    max = { major: 0, minor: 0, patch: p.patch + 1, prerelease: [] };
  }
  return { min: lower, minInclusive: true, max, maxInclusive: false };
}

/**
 * '~' admits patch-level changes (~1.2.3 -> <1.3.0), or minor-level if no minor
 * is given (~1 -> <2.0.0).
 */
function tildeRange(p: IPartialVersion, lower: SemverVersion): IRange {
  if (p.major === undefined) {
    return { min: ZERO_VERSION, minInclusive: true, maxInclusive: false };
  }
  const max =
    p.minor === undefined
      ? { major: p.major + 1, minor: 0, patch: 0, prerelease: [] }
      : { major: p.major, minor: p.minor + 1, patch: 0, prerelease: [] };
  return { min: lower, minInclusive: true, max, maxInclusive: false };
}

function parseComparator(token: string): IRange {
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
  const op = m[1] ?? "";
  const p = parsePartial(m[2]);
  const lower = lowerOf(p);

  switch (op) {
    case "^":
      return caretRange(p, lower);
    case "~":
      return tildeRange(p, lower);
    case ">=":
      return { min: lower, minInclusive: true, maxInclusive: false };
    case ">": {
      /* '>1.2' means >=1.3.0; a fully specified '>1.2.3' is a true exclusive bound */
      const implied = upperOfPartial(p);
      if (p.patch === undefined && implied) {
        return { min: implied, minInclusive: true, maxInclusive: false };
      }
      return { min: lower, minInclusive: false, maxInclusive: false };
    }
    case "<":
      return { min: ZERO_VERSION, minInclusive: true, max: lower, maxInclusive: false };
    case "<=": {
      /* '<=1.2' admits all of 1.2.x, i.e. <1.3.0 */
      const implied = upperOfPartial(p);
      if (p.patch === undefined && implied) {
        return { min: ZERO_VERSION, minInclusive: true, max: implied, maxInclusive: false };
      }
      return { min: ZERO_VERSION, minInclusive: true, max: lower, maxInclusive: true };
    }
    case "":
    case "=": {
      const implied = upperOfPartial(p);
      if (p.major !== undefined && p.minor !== undefined && p.patch !== undefined) {
        return { min: lower, minInclusive: true, max: lower, maxInclusive: true };
      }
      return { min: lower, minInclusive: true, max: implied, maxInclusive: false };
    }
    default:
      throw new Error(`Unsupported semver operator '${op}'`);
  }
}

function intersectRanges(a: IRange, b: IRange): IRange {
  let min: SemverVersion;
  let minInclusive: boolean;
  const mincmp = compareVersions(a.min, b.min);
  if (mincmp === 0) {
    min = a.min;
    minInclusive = a.minInclusive && b.minInclusive;
  } else {
    ({ min, minInclusive } = mincmp > 0 ? a : b);
  }

  let max: SemverVersion | undefined;
  let maxInclusive: boolean;
  if (a.max === undefined) {
    ({ max, maxInclusive } = b);
  } else if (b.max === undefined) {
    ({ max, maxInclusive } = a);
  } else {
    const maxcmp = compareVersions(a.max, b.max);
    if (maxcmp === 0) {
      max = a.max;
      maxInclusive = a.maxInclusive && b.maxInclusive;
    } else {
      ({ max, maxInclusive } = maxcmp < 0 ? a : b);
    }
  }
  return { min, minInclusive, max, maxInclusive };
}

/**
 * npm hyphen range: 'A - B' is >=A together with the <= reading of B — a
 * partial B admits its whole prefix ('1.2.3 - 2.3' is <2.4.0, '1.2.3 - 2' is
 * <3.0.0; per npm, mirroring the '<=' partial rule), a wildcard B is
 * unbounded above. Each side reuses the ordinary partial-version machinery.
 */
function hyphenRange(left: string, right: string): IRange {
  const lower = lowerOf(parsePartial(left));
  const p = parsePartial(right);
  if (p.major === undefined) {
    return { min: lower, minInclusive: true, maxInclusive: false };
  }
  const implied = upperOfPartial(p);
  if (p.patch === undefined && implied) {
    return { min: lower, minInclusive: true, max: implied, maxInclusive: false };
  }
  return { min: lower, minInclusive: true, max: lowerOf(p), maxInclusive: true };
}

function parseRange(text: string): IRange {
  /* npm tolerates whitespace between an operator and its version — published
   * metadata contains e.g. '>= 2.1.2 < 3.0.0' (iconv-lite) — so join each
   * operator to the version it governs before splitting on conjunctions. */
  const tokens = text
    .replace(/(>=|<=|>|<|=|\^|~)\s+(?=[\dvxX*])/g, "$1")
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0);
  if (tokens.length === 0) {
    return { min: ZERO_VERSION, minInclusive: true, maxInclusive: false };
  }
  /* A standalone '-' token is a hyphen range joining its two neighbours (the
   * spaces are required — an unspaced '1.2.3-rc' hyphen is a prerelease). */
  const ranges: IRange[] = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    if (tokens[idx] === "-") {
      throw new Error(`Invalid hyphen range in '${text.trim()}' (expected '<version> - <version>')`);
    }
    if (tokens[idx + 1] === "-") {
      if (idx + 2 >= tokens.length) {
        throw new Error(`Invalid hyphen range in '${text.trim()}' (expected '<version> - <version>')`);
      }
      ranges.push(hyphenRange(tokens[idx], tokens[idx + 2]));
      idx += 2;
    } else {
      ranges.push(parseComparator(tokens[idx]));
    }
  }
  return ranges.reduce(intersectRanges);
}

export function parseConstraint(text: string): SemverConstraint {
  return { ranges: text.split("||").map(parseRange) };
}

function versionInRange(version: SemverVersion, range: IRange): boolean {
  const mincmp = compareVersions(version, range.min);
  if (range.minInclusive ? mincmp < 0 : mincmp <= 0) {
    return false;
  }
  if (range.max !== undefined) {
    const maxcmp = compareVersions(version, range.max);
    return range.maxInclusive ? maxcmp <= 0 : maxcmp < 0;
  }
  return true;
}

/**
 * Whether any bound of the constraint carries a prerelease component — npm's
 * opt-in signal that prerelease versions are admissible (`^1.2.3-beta.4`).
 */
function mentionsPrerelease(constraint: SemverConstraint): boolean {
  return constraint.ranges.some(range => range.min.prerelease.length > 0 || (range.max?.prerelease.length ?? 0) > 0);
}

/**
 * The lowest of `versions` satisfying `constraint`, under npm's prerelease
 * contract: a prerelease version is a candidate only when the constraint
 * itself mentions one (node-semver's opt-in — every other consumer of the
 * same registry metadata reads `^4.0.0` as excluding prereleases; and since
 * a prerelease sorts *below* its release, admitting them would make a
 * lowest-satisfying pick actively prefer `4.0.1-rc.0` over an available
 * `4.0.1`). The candidate rule for the floor-raise repair (see
 * NPMRepository.lowestAvailable), where fabr invents a version rather than
 * taking a declared one — so it must invent npm-consistently.
 */
export function lowestSatisfying(versions: SemverVersion[], constraint: SemverConstraint): SemverVersion | undefined {
  const allowPrerelease = mentionsPrerelease(constraint);
  return versions
    .filter(
      version =>
        (allowPrerelease || version.prerelease.length === 0) && constraint.ranges.some(range => versionInRange(version, range))
    )
    .sort(compareVersions)[0];
}

function rangeMinimum(range: IRange): SemverVersion {
  if (range.minInclusive) {
    return range.min;
  }
  /* Approximate the successor of an exclusive lower bound as the next patch version */
  return { major: range.min.major, minor: range.min.minor, patch: range.min.patch + 1, prerelease: [] };
}

export const SEMVER: VersionDomain<SemverVersion, SemverConstraint> = {
  parseConstraint,
  compare: compareVersions,

  minimumOf(constraint: SemverConstraint): SemverVersion {
    return constraint.ranges.map(rangeMinimum).reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
  },

  isUnconstrained(constraint: SemverConstraint): boolean {
    /* A disjunction admits everything if any arm does ('*', 'x', '>=0.0.0') */
    return constraint.ranges.some(
      range => range.max === undefined && range.minInclusive && compareVersions(range.min, ZERO_VERSION) === 0
    );
  },

  satisfies(version: SemverVersion, constraint: SemverConstraint): boolean {
    return constraint.ranges.some(range => versionInRange(version, range));
  },

  /**
   * npm permits distinct major versions of a package to coexist; within the
   * 0.x series each minor is its own compatibility unit (per caret semantics).
   */
  resolutionKey(pkg: string, constraint: SemverConstraint): string {
    const min = this.minimumOf(constraint);
    return min.major > 0 ? `${pkg}@${min.major}` : `${pkg}@0.${min.minor}`;
  },

  versionToString,
};
