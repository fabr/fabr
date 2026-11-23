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
 * Browser versions and references: `<browser>:<version>`, the version a
 * dotted number of any length (Can I Use's `120` and `17.2`, Chrome for
 * Testing's `156.0.8078.4`) or Can I Use's `all`.
 */

import { Computable, FabrError, IProjection, Name, PackageFormat, Requirement } from "@fabr-build/core";

/**
 * The one version Can I Use lists for a browser it does not number (Opera Mini): a browser's
 * only version, with no numbered parts, so lower than any other.
 */
export const ALL = "all";

/** A browser version: its numbered parts (a range's lower end; none for `all`), and its text as written. */
export interface BrowserVersion {
  readonly parts: readonly number[];
  readonly text: string;
}

/** A browser version constraint: the leading parts a version must have (`156` admits `156.0.8078.4`). */
export interface BrowserConstraint {
  readonly prefix: readonly number[];
}

/** @return true if `text` is a browser version as written in a reference (`17`, `17.2`, `156.0.8078.4`, `all`), otherwise false. */
function isBareVersion(text: string): boolean {
  return text === ALL || /^\d+(\.\d+)*$/.test(text);
}

/** @return the numbered parts of a version as written (`17.2`, a range's lower end, `18.5-18.7`, or `all`, which has none). */
function partsOf(text: string): number[] {
  return text === ALL ? [] : text.split("-")[0].split(".").map(Number);
}

/** Order browser versions oldest first, part by part, a missing part reading as 0 (`17` = `17.0`). */
export function compareBrowserVersions(a: BrowserVersion, b: BrowserVersion): number {
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const difference = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The format of browser references: `<browser>:<version>`, the version a
 * dotted number of any length (Can I Use's `120` and `17.2`, Chrome for
 * Testing's `156.0.8078.4`), or Can I Use's `all`. A version written in a
 * reference names every version it is a prefix of (`156` names
 * `156.0.8078.4`). Can I Use's range releases (`18.5-18.7`) are versions ordered by
 * their lower end.
 */
export const BROWSER_FORMAT: PackageFormat<BrowserVersion, BrowserConstraint> = {
  name: "browser",
  resolutionTag: "browser:resolve:4",
  parseVersion: text => {
    if (!isVersionOrRange(text)) {
      throw new FabrError(`'${text}' is not a browser version`);
    }
    return { parts: partsOf(text), text };
  },
  versionToString: version => version.text,
  compare: compareBrowserVersions,
  parseConstraint: text => {
    if (!isBareVersion(text)) {
      throw new FabrError(`'${text}' is not a browser version (expected one like '17.2')`);
    }
    return { prefix: partsOf(text) };
  },
  unconstrained: { prefix: [] },
  minimumOf: constraint => ({ parts: constraint.prefix, text: constraint.prefix.length === 0 ? ALL : constraint.prefix.join(".") }),
  isFloorless: () => false,
  satisfies: (version, constraint) => constraint.prefix.every((part, i) => (version.parts[i] ?? 0) === part),
  exactConstraint: version => (version.parts.length === 0 ? ALL : version.parts.join(".")),
  splitReference: splitBrowserReference,
  validateRequirement: validateBrowserRequirement,
  parsePublishCoordinate: () => {
    throw new FabrError("browsers cannot be published to");
  },
  readContentPackage: () => Computable.reject(new FabrError("content cannot be read as a browser")),
  makeRunnable: () => Computable.reject(new FabrError("a browser is not a program fabr can run")),
};

/** Split `<browser>:<version>` (the reference after `@browser:`). A browser has no files, so nothing selects from it. */
function splitBrowserReference(name: Name): Requirement & { projection?: IProjection } {
  const written = name.toBaseString();
  const colon = written.indexOf(":");
  if (colon === -1) {
    return { name: written, versionConstraint: undefined };
  }
  if (written.indexOf(":", colon + 1) !== -1 || written.includes("/")) {
    throw new FabrError(`'${written}' selects files, and a browser has none (expected '@browser:<browser>:<version>')`);
  }
  return { name: written.substring(0, colon), versionConstraint: written.substring(colon + 1) };
}

/** Check a browser reference states a version, the oldest supported, as a version is written in a reference. */
function validateBrowserRequirement({ name, versionConstraint }: Requirement): void {
  if (versionConstraint === undefined) {
    throw new FabrError(`Missing version in a browser reference (expected '@browser:${name}:<version>', that version and newer)`);
  }
  if (!isBareVersion(versionConstraint)) {
    throw new FabrError(
      `'${versionConstraint}' is not a browser version (expected one like '@browser:${name}:17.2', that version and newer)`
    );
  }
}

/** @return true if `text` is a browser version: numbered, a range of Can I Use's, or `all` (not `TP`), otherwise false. */
export function isVersionOrRange(text: string): boolean {
  return text === ALL || /^\d+(\.\d+)*(-\d+(\.\d+)*)?$/.test(text);
}
