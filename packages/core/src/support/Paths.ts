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
import { FabrError } from "../core/Errors";

/** The characters no file name may hold: `\` and control characters. */
// eslint-disable-next-line no-control-regex
const JUNK_CHARACTER = /[\\\u0000-\u001f\u007f]/;

const SLASH = "/".charCodeAt(0);
const DOT = ".".charCodeAt(0);
const BACKSLASH = "\\".charCodeAt(0);
const DEL = 0x7f;

/**
 * Canonicalize a file name as a FileSet names files: a relative, `/`-separated
 * path with no empty, `.` or `..` segment and no trailing `/`. Interior `.` and
 * `..` segments are resolved, and a leading `/` or run of `../` is stripped
 * (`../scripts/x` names `scripts/x`). Throws where the name holds `\` or a
 * control character, or names nothing once stripped.
 */
export function canonicalFileName(name: string): string {
  if (JUNK_CHARACTER.test(name)) {
    throw new FabrError(`Invalid file name ${JSON.stringify(name)}: '\\' and control characters are not allowed`);
  }
  let result = path.posix.normalize(name).replace(/^\/+/, "");
  while (result.startsWith("../")) {
    result = result.substring(3);
  }
  result = result.replace(/\/+$/, "");
  if (result === "" || result === "." || result === "..") {
    throw new FabrError(`Invalid file name '${name}': names no path`);
  }
  return result;
}

/**
 * @return true if `name` is one {@link canonicalFileName} returns unchanged,
 * otherwise false. Use it to test any name used as a path as it stands (a
 * package name mounted at `node_modules/<name>`). It scans the name without
 * copying it, and must agree exactly with canonicalFileName: a test checks the
 * two against each other.
 */
export function isCanonicalFileName(name: string): boolean {
  const length = name.length;
  /* Empty, absolute, or ending in `/`. */
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
      /* An empty (`//`), `.` or `..` segment. */
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

/** Normalize an archive entry's name to a relative FileSet name: a leading `/`
 * stripped, `.` and `..` segments resolved.
 * @return the name, or undefined where it is empty or escapes the tree with
 *   `../`. Drop such an entry: an archive is untrusted. */
export function normalizeEntryName(raw: string): string | undefined {
  const normalized = path.posix.normalize(raw.replace(/^\/+/, ""));
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

/** @return the directory entries above the archive entry `name`, outermost first (`a/`, `a/b/`). */
export function ancestorsOf(name: string): string[] {
  const ancestors: string[] = [];
  for (let slash = name.indexOf("/"); slash !== -1; slash = name.indexOf("/", slash + 1)) {
    ancestors.push(name.substring(0, slash + 1));
  }
  return ancestors;
}

/**
 * @return the names of an archive's entries in the order written: `names`, with
 * every directory above one where `directories` is set; the names in `first`
 * lead, each after the directories above it, and the rest follow in sorted
 * order, a directory before the entries within it.
 */
export function archiveEntryNames(names: readonly string[], options: { directories: boolean; first?: readonly string[] }): string[] {
  const all = options.directories ? [...new Set(names.flatMap(ancestorsOf)), ...names] : [...names];
  const leading = new Set((options.first ?? []).flatMap(name => [...(options.directories ? ancestorsOf(name) : []), name]));
  return [...leading, ...all.filter(name => !leading.has(name)).sort()];
}
