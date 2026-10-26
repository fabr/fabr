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
 * Maven's versions and version requirements as a {@link VersionDomain}.
 *
 * Versions order as Maven's `ComparableVersion` orders them: numbers compare
 * numerically, trailing zeros are dropped (`1.0` equals `1`), and qualifiers
 * rank `alpha < beta < milestone < rc < snapshot < (release) < sp`, any other
 * qualifier after those, alphabetically. A version is identified by its text:
 * `1.0` and `1.0.0` compare equal but are different published artifacts.
 *
 * A plain version (`1.2`) is a soft requirement, a floor with no cap. A range
 * (`[1.0,2.0)`, `[1.2]`, `(,1.0],[1.2,)`) admits exactly what it names.
 */

import { FabrError, VersionDomain } from "@fabr-build/core";

/**
 * One item of a parsed version: a number, a qualifier, a qualifier with its
 * number (`alpha1`, `rc-2`), or a sublist (what follows a `-`, or a change
 * between digits and letters).
 */
type Item =
  | { kind: "int"; value: bigint }
  | { kind: "string"; value: string }
  | { kind: "combination"; qualifier: Item & { kind: "string" }; number: Item }
  | { kind: "list"; items: Item[] };

export interface MavenVersion {
  /** The version as published, which is its identity. */
  readonly text: string;
  readonly items: Item[];
}

interface Bound {
  readonly version: MavenVersion;
  readonly inclusive: boolean;
}

/** One interval of a range; an absent bound is unbounded. */
interface Interval {
  readonly lower?: Bound;
  readonly upper?: Bound;
}

/** A soft requirement's floor, or the intervals a range admits (any of them). */
export type MavenConstraint = { kind: "soft"; floor: MavenVersion } | { kind: "range"; intervals: Interval[] };

const ZERO_INT = BigInt(0);

const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const RELEASE_INDEX = String(QUALIFIERS.indexOf(""));
const ALIASES = new Map([
  ["ga", ""],
  ["final", ""],
  ["release", ""],
  ["cr", "rc"],
]);
/* A single letter followed by a digit (`1.0a1`) abbreviates a qualifier. */
const ABBREVIATIONS = new Map([
  ["a", "alpha"],
  ["b", "beta"],
  ["m", "milestone"],
]);

function stringItem(text: string, followedByDigit: boolean): Item & { kind: "string" } {
  const expanded = followedByDigit ? (ABBREVIATIONS.get(text) ?? text) : text;
  return { kind: "string", value: ALIASES.get(expanded) ?? expanded };
}

function isDigitChar(char: string): boolean {
  return char >= "0" && char <= "9";
}

function parseItem(text: string, combination: boolean, isDigit: boolean): Item {
  if (combination) {
    const joined = text.replace(/-/g, "");
    const index = [...joined].findIndex(isDigitChar);
    return { kind: "combination", qualifier: stringItem(joined.substring(0, index), true), number: parseItem(joined.substring(index), false, true) };
  }
  return isDigit ? { kind: "int", value: BigInt(text) } : stringItem(text, false);
}

function isNullItem(item: Item): boolean {
  switch (item.kind) {
    case "int":
      return item.value === ZERO_INT;
    case "string":
      return item.value === "";
    case "combination":
      return false;
    case "list":
      return item.items.length === 0;
  }
}

/** Drop a list's null items where they end it or precede a qualifier (`1.0.0` → `1`, `1.0-alpha` → `1-alpha`). */
function normalize(items: Item[]): void {
  for (let index = items.length - 1; index >= 0; index--) {
    if (!isNullItem(items[index])) {
      continue;
    }
    const next = items[index + 1];
    const leading = next?.kind === "list" ? next.items[0] : undefined;
    if (next === undefined || next.kind === "string" || leading?.kind === "combination" || leading?.kind === "string") {
      items.splice(index, 1);
    }
  }
}

function parseItems(text: string): Item[] {
  const version = text.toLowerCase();
  const root: Item[] = [];
  let list = root;
  const lists: Item[][] = [root];
  const sublist = (): void => {
    const items: Item[] = [];
    list.push({ kind: "list", items });
    list = items;
    lists.push(items);
  };
  let isDigit = false;
  let combination = false;
  let start = 0;
  for (let index = 0; index < version.length; index++) {
    const char = version[index];
    if (char === ".") {
      list.push(index === start ? { kind: "int", value: ZERO_INT } : parseItem(version.substring(start, index), combination, isDigit));
      combination = false;
      start = index + 1;
    } else if (char === "-") {
      if (index === start) {
        list.push({ kind: "int", value: ZERO_INT });
      } else {
        /* `X-1` reads as `X1`. */
        if (!isDigit && index !== version.length - 1 && isDigitChar(version[index + 1])) {
          combination = true;
          continue;
        }
        list.push(parseItem(version.substring(start, index), combination, isDigit));
      }
      start = index + 1;
      sublist();
      combination = false;
    } else if (isDigitChar(char)) {
      if (!isDigit && index > start) {
        combination = true;
        if (list.length > 0) {
          sublist();
        }
      }
      isDigit = true;
    } else {
      if (isDigit && index > start) {
        list.push(parseItem(version.substring(start, index), combination, true));
        start = index;
        sublist();
        combination = false;
      }
      isDigit = false;
    }
  }
  if (version.length > start) {
    /* A trailing `.X` qualifier reads as `-X`. */
    if (!isDigit && list.length > 0) {
      sublist();
    }
    list.push(parseItem(version.substring(start), combination, isDigit));
  }
  for (const items of lists.reverse()) {
    normalize(items);
  }
  return root;
}

function comparableQualifier(value: string): string {
  const index = QUALIFIERS.indexOf(value);
  return index === -1 ? `${QUALIFIERS.length}-${value}` : String(index);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare an item with another, or with a missing one. */
function compareItem(item: Item, other: Item | undefined): number {
  if (other === undefined) {
    switch (item.kind) {
      case "int":
        return item.value === ZERO_INT ? 0 : 1;
      case "string":
        return compareText(comparableQualifier(item.value), RELEASE_INDEX);
      case "combination":
        return compareItem(item.qualifier, undefined);
      case "list":
        return item.items.length === 0 ? 0 : compareItem(item.items[0], undefined);
    }
  }
  switch (item.kind) {
    case "int":
      return other.kind === "int" ? (item.value < other.value ? -1 : item.value > other.value ? 1 : 0) : 1;
    case "string":
      if (other.kind === "combination") {
        return -compareItem(other, item);
      }
      return other.kind === "string" ? compareText(comparableQualifier(item.value), comparableQualifier(other.value)) : -1;
    case "combination":
      if (other.kind === "string") {
        /* `X1` is above `X`. */
        return compareItem(item.qualifier, other) || 1;
      }
      if (other.kind === "combination") {
        return compareItem(item.qualifier, other.qualifier) || compareItem(item.number, other.number);
      }
      return -1;
    case "list":
      return other.kind === "int" ? -1 : other.kind === "list" ? compareLists(item.items, other.items) : 1;
  }
}

function compareLists(left: Item[], right: Item[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const l = left[index];
    const r = right[index];
    const result = l === undefined ? (r === undefined ? 0 : -compareItem(r, undefined)) : compareItem(l, r);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
}

/** Parse a version as published. Throws on an empty one, or one with a character
 *  no Maven version holds (a range's brackets, an unexpanded `${property}`). */
export function parseMavenVersion(text: string): MavenVersion {
  const trimmed = text.trim();
  if (trimmed === "" || /[[\](),${}\s]/.test(trimmed)) {
    throw new FabrError(`'${text}' is not a Maven version`);
  }
  return { text: trimmed, items: parseItems(trimmed) };
}

export function compareMavenVersions(a: MavenVersion, b: MavenVersion): number {
  return compareLists(a.items, b.items);
}

function parseBound(text: string, inclusive: boolean): Bound | undefined {
  return text.trim() === "" ? undefined : { version: parseMavenVersion(text), inclusive };
}

/** Parse a range: one or more comma-separated intervals, each `[`/`(` … `]`/`)`. */
function parseRange(text: string): Interval[] {
  const intervals: Interval[] = [];
  let rest = text.trim();
  while (rest !== "") {
    const match = /^([[(])([^\])]*)([\])])\s*(?:,\s*)?/.exec(rest);
    if (!match) {
      throw new FabrError(`'${text}' is not a Maven version range`);
    }
    const [whole, open, body, close] = match;
    const parts = body.split(",");
    if (parts.length === 1) {
      if (open !== "[" || close !== "]") {
        throw new FabrError(`'${text}' is not a Maven version range: a single version must be written '[${body.trim()}]'`);
      }
      const bound = parseBound(parts[0], true);
      if (bound === undefined) {
        throw new FabrError(`'${text}' is not a Maven version range`);
      }
      intervals.push({ lower: bound, upper: bound });
    } else if (parts.length === 2) {
      intervals.push({ lower: parseBound(parts[0], open === "["), upper: parseBound(parts[1], close === "]") });
    } else {
      throw new FabrError(`'${text}' is not a Maven version range`);
    }
    rest = rest.substring(whole.length);
  }
  return intervals;
}

export function parseMavenConstraint(text: string): MavenConstraint {
  const trimmed = text.trim();
  return /^[[(]/.test(trimmed) ? { kind: "range", intervals: parseRange(trimmed) } : { kind: "soft", floor: parseMavenVersion(trimmed) };
}

function admits(interval: Interval, version: MavenVersion): boolean {
  const { lower, upper } = interval;
  if (lower !== undefined) {
    const order = compareMavenVersions(version, lower.version);
    if (order < 0 || (order === 0 && !lower.inclusive)) {
      return false;
    }
  }
  if (upper !== undefined) {
    const order = compareMavenVersions(version, upper.version);
    if (order > 0 || (order === 0 && !upper.inclusive)) {
      return false;
    }
  }
  return true;
}

const ZERO = parseMavenVersion("0");

function minimumOf(constraint: MavenConstraint): MavenVersion {
  if (constraint.kind === "soft") {
    return constraint.floor;
  }
  const floors = constraint.intervals.map(interval => interval.lower?.version ?? ZERO);
  return floors.reduce((lowest, floor) => (compareMavenVersions(floor, lowest) < 0 ? floor : lowest));
}

/** The qualifiers a stable release never carries. */
const UNSTABLE = /(^|[.-])(alpha|beta|milestone|rc|cr|snapshot|ea|preview)|[.-]?(a|b|m)\d/i;

/** Maven's versions: soft requirements are floors, and every delivery is flat
 *  (one version per package, as on a classpath). */
export const MAVEN_VERSIONS: VersionDomain<MavenVersion, MavenConstraint> = {
  parseConstraint: parseMavenConstraint,
  unconstrained: { kind: "range", intervals: [{}] },
  compare: compareMavenVersions,
  minimumOf,
  isFloorless: constraint => constraint.kind === "range" && constraint.intervals.some(interval => interval.lower === undefined),
  flat: true,
  satisfies: (version, constraint) =>
    constraint.kind === "soft"
      ? compareMavenVersions(version, constraint.floor) >= 0
      : constraint.intervals.some(interval => admits(interval, version)),
  versionToString: version => version.text,
  parseVersion: parseMavenVersion,
  exactVersion: text => {
    try {
      const constraint = parseMavenConstraint(text);
      if (constraint.kind === "soft") {
        return constraint.floor;
      }
      const [only] = constraint.intervals;
      return constraint.intervals.length === 1 && only.lower !== undefined && only.lower === only.upper ? only.lower.version : undefined;
    } catch {
      return undefined;
    }
  },
  isStable: version => !UNSTABLE.test(version.text),
};
