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

import * as path from "path";

/** Characters that are never part of a valid name, whatever the path structure. */
// eslint-disable-next-line no-control-regex
const JUNK_CHARACTER = /[\\\u0000-\u001f\u007f]/;

const SLASH = "/".charCodeAt(0);
const DOT = ".".charCodeAt(0);
const BACKSLASH = "\\".charCodeAt(0);
const DEL = 0x7f;

/**
 * Canonicalize a file name for the FileSet namespace: a clean, relative,
 * `/`-separated path. `./` and interior `..` segments are resolved away, and a
 * leading `/` or run of `../` is **stripped** — the namespace is a flat sandbox
 * with no "above", so a name climbing out of its frame flattens to its tail
 * (`../scripts/x` names `scripts/x`; the rule behind file-relative references
 * that climb out of their build file's directory). Names
 * that aren't path structure at all — `\`, control characters, or nothing left
 * after flattening — are errors, never repaired.
 */
export function canonicalFileName(name: string): string {
  if (JUNK_CHARACTER.test(name)) {
    throw new Error(`Invalid file name ${JSON.stringify(name)}: '\\' and control characters are not allowed`);
  }
  let result = path.posix.normalize(name).replace(/^\/+/, "");
  while (result.startsWith("../")) {
    result = result.substring(3);
  }
  result = result.replace(/\/+$/, "");
  if (result === "" || result === "." || result === "..") {
    throw new Error(`Invalid file name '${name}': names no path`);
  }
  return result;
}

/**
 * Whether `name` is already canonical — defined as the fixed point of
 * {@link canonicalFileName}, so the two can never drift. Beyond the FileSet
 * fast path, this is the general "is this string usable as a path?" test for
 * any name that will be used verbatim as path structure (e.g. a package name,
 * mounted at `node_modules/<name>`): a name canonicalization would change or
 * refuse cannot honestly serve as the path it claims to be.
 *
 * Answered by a direct scan rather than by canonicalizing and comparing: it is
 * asked once per name per FileSet construction (millions of times in a large
 * build), where allocating a normalized copy to throw away dominates. The two
 * must agree exactly — a test pins them together over a corpus.
 */
export function isCanonicalFileName(name: string): boolean {
  const length = name.length;
  /* Empty, absolute, or trailing-slash: all three are things canonicalization
   * would change or refuse. */
  if (length === 0 || name.charCodeAt(0) === SLASH || name.charCodeAt(length - 1) === SLASH) {
    return false;
  }
  let segment = 0;
  for (let i = 0; i <= length; i++) {
    const c = i === length ? SLASH : name.charCodeAt(i);
    if (c === BACKSLASH || c < 0x20 || c === DEL) {
      return false;
    }
    if (c === SLASH) {
      /* An empty (`//`), `.` or `..` segment is one normalization resolves
       * away; every other segment survives verbatim. */
      const len = i - segment;
      if (len === 0) {
        return false;
      }
      if (len <= 2 && name.charCodeAt(segment) === DOT && (len === 1 || name.charCodeAt(segment + 1) === DOT)) {
        return false;
      }
      segment = i + 1;
    }
  }
  return true;
}
