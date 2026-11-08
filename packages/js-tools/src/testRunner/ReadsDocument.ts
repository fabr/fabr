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
 * The runner contract's `--reads` document: what a test process read, from
 * which the test step decides what a change reaches. Every path is relative to
 * the runner's working directory.
 */
export interface IReadsDocument {
  /** Every module the process loaded, the `package.json` nearest each, and
   *  every file it read or probed through `fs`; a probe that found a directory
   *  is its path with a trailing `/`. */
  readonly files: ReadonlyArray<string>;
  /** Every package the process looked up by a bare specifier. */
  readonly lookups: ReadonlyArray<ILookup>;
}

/** One lookup of a package by a bare specifier: the file that asked, the
 *  package's name, and the file that answered, absent where nothing did. */
export interface ILookup {
  readonly from: string;
  readonly name: string;
  readonly to?: string;
}

/** Convert a parsed `--reads` document, or throw where it is not one. */
export function toReadsDocument(json: unknown): IReadsDocument {
  if (typeof json !== "object" || json === null || !("files" in json) || !("lookups" in json)) {
    throw new Error("expected a reads document with 'files' and 'lookups'");
  }
  const { files, lookups } = json as { files: unknown; lookups: unknown };
  if (!Array.isArray(files) || files.some(file => typeof file !== "string")) {
    throw new Error("expected 'files' to be a list of paths");
  }
  if (!Array.isArray(lookups) || !lookups.every(isLookup)) {
    throw new Error("expected 'lookups' to be a list of {from, name, to?}");
  }
  return { files: files as string[], lookups: lookups as ILookup[] };
}

function isLookup(json: unknown): json is ILookup {
  if (typeof json !== "object" || json === null) {
    return false;
  }
  const { from, name, to } = json as Record<string, unknown>;
  return typeof from === "string" && typeof name === "string" && (to === undefined || typeof to === "string");
}
