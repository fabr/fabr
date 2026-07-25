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

/**
 * Canonicalize a file name for the FileSet namespace: a clean, relative,
 * `/`-separated path. `./` and interior `..` segments are resolved away, and a
 * leading `/` or run of `../` is **stripped** — the namespace is a flat sandbox
 * with no "above", so a name climbing out of its frame flattens to its tail
 * (`../scripts/x` names `scripts/x`; the rule behind file-relative references
 * that climb out of their build file's directory — see RATIONALE.md). Names
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
 */
export function isCanonicalFileName(name: string): boolean {
  try {
    return canonicalFileName(name) === name;
  } catch {
    return false;
  }
}
