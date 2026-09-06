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
 * **The file formats.** How fabr writes build data down and reads it back: the
 * row a file is named by, the documents framed over rows, and the record of
 * what a run read — both directions for each, so a format never has its writer
 * and its reader in different files.
 *
 * The BOTTOM of the layering: text and rows, nothing that needs a FileSet. That
 * is what lets FileSet write its own manifest through the one row writer.
 * Whatever has to READ a FileSet to produce this text is built on it from
 * above, next to the thing it serialises — an action's key material in
 * BuildAction, the narrowing of discoverable inputs in BuildCache.
 */

import type { Name } from "./Name";

/**
 * Non-file key material handed to a build step: argv, patterns, switches, and a
 * `Name` where a step consumes a projection. On a cache miss the step receives
 * the live `Name` and applies it with `makeProjector`.
 */
export type ActionOptions = Record<string, string | string[] | Name>;

/**
 * A file that a run looked for in its discoverable inputs (successfully or not)
 *
 * This is either a simple filename or a package resolution path (where each
 * element of the array is a package on the resolution path) ending in a filename.
 */
export type DepsPath = ReadonlyArray<string>;

/**
 * All paths that the runner tried to resolve from each of its discoverable inputs.
 *
 * Note: the empty list is interpreted as 'did not try to resolve anything', while the
 * missing key case means that discovery data was not recorded (and the system will
 * assume that all inputs may have been used).
 *
 * A Map, not a Record: the keys come back from a record file
 * ({@link parseDiscoveredDeps}), and a dictionary populated by a parser must
 * not be a plain object.
 */
export type DiscoveredDeps = Map<string, ReadonlyArray<DepsPath>>;

/**
 * The FLAT spelling of a {@link DepsPath}: its parts, each
 * {@link encodeName}-encoded, joined with single spaces. Every conversion
 * between the two spellings goes through this pair — a raw `join`/`split`
 * would make a space inside a part (legal in a file's name) indistinguishable
 * from the separator, and a read recorded through one narrows to a path that
 * resolves to nothing: a permanent absence, silently dropping the file from
 * the key.
 *
 * Mirrored in @fabr-build/js's pnp/ReadSet.ts for the driver side, which must
 * not depend on core at runtime — keep the two in sync.
 */
export function joinDepsPath(path: DepsPath): string {
  return path.map(part => encodeName(part)).join(" ");
}

/** The inverse of {@link joinDepsPath}. */
export function splitDepsPath(name: string): string[] {
  return name.split(" ").map(part => decodeName(part));
}

/* ── Names and rows ───────────────────────────────────────────
 * How one file is written down: `hash octalmode name[ extra]`. Every document
 * over these — the cache's entry manifest, a build-state record, an action's
 * key material — frames rows without respelling them, and what a document adds
 * around one (a header, a symlink's own line, the mime a persisted entry
 * carries) is that document's own.
 */

/**
 * A file name as a manifest row carries it. `encodeURI` escapes the space (the
 * field separator) and the newline while leaving a path's `/` and a
 * specifier's `:@&` legible.
 */
export function encodeName(name: string): string {
  return encodeURI(name);
}

/** Decode a name field. `encodeURI` only ever introduces `%` escapes, so a
 * field without one decodes to itself — and almost none have one, which makes
 * the check worth making before the call. */
export function decodeName(field: string): string {
  return field.indexOf("%") < 0 ? field : decodeURI(field);
}

/**
 * One file as a row. `extra` is the trailing field a document may carry after
 * the name — the persisted entry's mime; a row that is only ever hashed omits
 * it, a file's mime being a function of its content and never key material.
 *
 * Mode participates (octal): a consumer's cache key must turn over when an
 * input's permission bits change, not just its content.
 */
export function manifestLine(name: string, hash: string, mode: number, extra?: string): string {
  return `${hash} ${mode.toString(8)} ${encodeName(name)}${extra === undefined ? "" : " " + extra}`;
}

/** One row read back. Rows alone, never files: what backs a name is the
 * reader's business. */
export interface IManifestRow {
  readonly name: string;
  readonly hash: string;
  readonly mode: number;
  /** Whatever the document put after the name, where it puts anything. */
  readonly extra?: string;
}

const ZERO = "0".charCodeAt(0);

/**
 * Read a row back. Undefined for a line that is not one — the mode is
 * validated, not merely parsed, so a document's own line kinds (a header, a
 * symlink, an absence) cannot be mistaken for a row.
 */
export function parseManifestLine(line: string): IManifestRow | undefined {
  const afterHash = line.indexOf(" ");
  const afterMode = line.indexOf(" ", afterHash + 1);
  if (afterHash < 0 || afterMode < 0) {
    return undefined;
  }
  const mode = line.substring(afterHash + 1, afterMode);
  if (mode.length === 0) {
    return undefined;
  }
  let bits = 0;
  for (let i = 0; i < mode.length; i++) {
    const digit = mode.charCodeAt(i) - ZERO;
    if (digit < 0 || digit > 7) {
      return undefined;
    }
    bits = bits * 8 + digit;
  }
  const afterName = line.indexOf(" ", afterMode + 1);
  return {
    hash: line.substring(0, afterHash),
    mode: bits,
    name: decodeName(line.substring(afterMode + 1, afterName < 0 ? undefined : afterName)),
    extra: afterName < 0 ? undefined : line.substring(afterName + 1),
  };
}

/* ── The recorded base ────────────────────────────────────────
 * What a build was made from, as ONE list of every file it used. Which bag a
 * file came from is fabr's bookkeeping and no fact about the file, so nothing
 * here says. Written from key material (BuildAction), read back here.
 */

/** How a path that found nothing is written. Self-marking, one per line: these
 * are read back as well as hashed, and a bare name under a header would be
 * indistinguishable from framing. */
export const ABSENT_PREFIX = "# absent ";

/** The seal a stored base ends with: `# end <n>`, `n` the rows and absences
 * above it. The dialect is lenient about what a LINE is (framing is skipped),
 * so leniency alone cannot tell a whole document from a truncated one — and a
 * base short a line can lose a DELETION, a wrong build rather than a slow one.
 * The count is what refuses that, exactly as the entry manifest's own count
 * does. */
const BASE_SEAL_PREFIX = "# end ";

/** A recorded base as the record stores it: the text verbatim, sealed. Applied
 * where the record is written, not where the key material is built — the seal
 * frames the FILE against damage and is no fact about the build. */
export function sealRecordedBase(text: string): string {
  const { rows, absent } = scanBase(text);
  return `${text}\n${BASE_SEAL_PREFIX}${rows.length + absent.length}\n`;
}

/**
 * A recorded base read back: every row it holds, and every path that found
 * nothing. Framing is skipped; what refuses damage is the seal — undefined for
 * a document whose last line is not one, or whose count does not match what
 * was read, which covers a truncated copy, a torn one, and a document written
 * by an older fabr. Undefined means no base — a cold build, never a shorter
 * set.
 */
export function parseRecordedBase(text: string): { rows: IManifestRow[]; absent: string[] } | undefined {
  const lines = text.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].length === 0) {
    last--;
  }
  if (last < 0 || !lines[last].startsWith(BASE_SEAL_PREFIX)) {
    return undefined;
  }
  const claimed = Number(lines[last].substring(BASE_SEAL_PREFIX.length));
  const { rows, absent } = scanBase(lines.slice(0, last).join("\n"));
  return rows.length + absent.length === claimed ? { rows, absent } : undefined;
}

/** The meaningful lines of a base's text — one scanner behind the seal's count
 * and the read-back, so the two can never disagree about what counts. */
function scanBase(text: string): { rows: IManifestRow[]; absent: string[] } {
  const rows: IManifestRow[] = [];
  const absent: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(ABSENT_PREFIX)) {
      absent.push(decodeName(line.substring(ABSENT_PREFIX.length)));
      continue;
    }
    const row = parseManifestLine(line);
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return { rows, absent };
}

/* ── Options as key material ──────────────────────────────────
 * The non-file half of an action key — no files in it, so it is written down
 * here with the rest of the text.
 */

/** The options section of an action key: keys in sorted order, one
 * `name=manifest` line each. */
export function manifestOptions(options: ActionOptions): string {
  return Object.keys(options)
    .sort()
    .map(name => `${name}=${manifestOption(options[name])}`)
    .join("\n");
}

/** One option as key material. A `Name` manifests by `toGlobString`, which is
 * lossless where `toString` is not (a quoted `'*'` and a wildcard `*` render
 * alike, colliding two different projections onto one key). */
function manifestOption(value: string | string[] | Name): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(element => JSON.stringify(element)).join(",") + "]";
  }
  return JSON.stringify(value.toGlobString());
}

/* ── The discovered-deps record ───────────────────────────────
 * A {@link DiscoveredDeps} written out as a section per discoverable input,
 * headed by the input's name, then one INDENTED line per path holding its names
 * space-separated. `encodeName` escapes any space in a name, so the indent tells
 * a path from a section head and the split into names is exact.
 */

/** The discovered-deps document's magic. Bump it whenever a record's grammar OR
 * its meaning changes: an older record then fails the check and is simply
 * unread, costing one cold build per anchor. */
const DISCOVERED_DEPS_MAGIC = "!discovered-deps 4";

/** A selection as the discovered-deps record's bytes: sections and paths both
 * in canonical order, so one selection has one spelling (and so one
 * content-addressed record file). */
export function serializeDiscoveredDeps(selection: DiscoveredDeps): string {
  const sections = [...selection.keys()]
    .sort()
    .flatMap(input => [encodeName(input), ...selection.get(input)!.map(path => ` ${joinDepsPath(path)}`).sort()]);
  return [DISCOVERED_DEPS_MAGIC, ...sections, ""].join("\n");
}

/** Read a discovered-deps record back, or undefined for anything that is not
 * exactly one — the record is advisory, so damage means fewer probes, never an
 * error. */
export function parseDiscoveredDeps(text: string): DiscoveredDeps | undefined {
  const lines = text.split("\n");
  if (lines[0] !== DISCOVERED_DEPS_MAGIC) {
    return undefined;
  }
  const selection: DiscoveredDeps = new Map();
  let paths: DepsPath[] | undefined;
  try {
    for (const line of lines.slice(1)) {
      if (line.length === 0) {
        continue;
      }
      if (!line.startsWith(" ")) {
        paths = [];
        selection.set(decodeName(line), paths);
        continue;
      }
      if (paths === undefined) {
        return undefined;
      }
      paths.push(splitDepsPath(line.slice(1)));
    }
  } catch {
    return undefined;
  }
  return selection;
}
