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
 * The text formats fabr writes build data in and reads it back from: the row
 * one file is written as, the documents made of rows (the recorded base, the
 * source index), and the record of what a run read. Each format's writer and
 * reader are kept together here.
 *
 * This module deals in text and rows only and imports no FileSet, so FileSet
 * can write its own manifest with {@link manifestLine}. Code that reads a
 * FileSet to produce this text lives beside what it renders (an action's key
 * in BuildAction, the narrowing of discoverable inputs in BuildCache).
 */

/**
 * A file a run looked for in its discoverable inputs, found or not: the names
 * of the packages along the dependency path the lookup took (none for a loose
 * member), then the file's name.
 */
export type DepsPath = ReadonlyArray<string>;

/**
 * The paths a run looked for in each of its discoverable inputs, by input
 * name. An empty list means the run looked for nothing in that input; a
 * missing input means nothing was recorded for it, and it is treated as wholly
 * read.
 */
export type DiscoveredDeps = Map<string, ReadonlyArray<DepsPath>>;

/**
 * Make the flat spelling of a {@link DepsPath}: its parts, each
 * {@link encodeName}-encoded, joined with single spaces. Convert between the
 * two spellings only with this and {@link splitDepsPath}: a raw `join` or
 * `split` mistakes a space inside a name for the separator, and the path then
 * finds nothing.
 *
 * Mirrored in @fabr-build/js-tools's pnp/ReadSet.ts, which must not depend on
 * core at runtime: keep the two in step.
 */
export function joinDepsPath(path: DepsPath): string {
  return path.map(part => encodeName(part)).join(" ");
}

/** The inverse of {@link joinDepsPath}. */
export function splitDepsPath(name: string): string[] {
  return name.split(" ").map(part => decodeName(part));
}

/* ── Names and rows ───────────────────────────────────────────
 * One file is written as the row `hash octalmode name[ extra]`. A document made
 * of rows (the cache's entry manifest, a build-state record, an action's key)
 * uses them as they are, and adds its own lines around them (a header, a
 * symlink's line).
 */

/**
 * Encode a file name as a row carries it, with `encodeURI`: the space (the
 * field separator), the newline and `%` are escaped, and a path's `/` and a
 * specifier's `:@&` are kept.
 */
export function encodeName(name: string): string {
  return URI_UNESCAPED.test(name) ? name : encodeURI(name);
}

/** The characters `encodeURI` leaves as they are: a name made only of them
 * encodes to itself. */
const URI_UNESCAPED = /^[A-Za-z0-9\-_.!~*'();/?:@&=+$,#]*$/;

/** Decode a name field. A field without `%` decodes to itself. */
export function decodeName(field: string): string {
  return field.indexOf("%") < 0 ? field : decodeURI(field);
}

/**
 * Write one file as a row. `extra` is a trailing field after the name (a
 * stored entry's mime); leave it out of a row that is key material. The mode
 * is written in octal, so a change to a file's permission bits changes the
 * row.
 */
export function manifestLine(name: string, hash: string, mode: number, extra?: string): string {
  return `${hash} ${mode.toString(8)} ${encodeName(name)}${extra === undefined ? "" : " " + extra}`;
}

/** A row read back by {@link parseManifestLine}. */
export interface IManifestRow {
  readonly name: string;
  readonly hash: string;
  readonly mode: number;
  /** Whatever the document put after the name, where it puts anything. */
  readonly extra?: string;
}

const ZERO = "0".charCodeAt(0);

/**
 * Read a row back, or return undefined for a line that is not one: one with
 * fewer than three fields, or whose second field is not an octal number, as a
 * document's own lines (a header, a symlink, an absence) are not.
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
 * What a build was made from: one list of every file it used, with no word of
 * which input each came from, and the paths that found nothing. Written from
 * the key text BuildAction renders, read back here.
 */

/** The start of the line recording a path that found nothing, one per line. */
export const ABSENT_PREFIX = "# absent ";

/** The seal a stored base ends with: `# end <n>`, `n` the rows and absences
 * above it. Framing lines are skipped on reading, so only the count tells a
 * whole base from a truncated one, which could be missing a deletion. */
const BASE_SEAL_PREFIX = "# end ";

/** Seal a recorded base for storing: the text as it is, then the seal. Seal
 * where the record is written, not into the key text. */
export function sealRecordedBase(text: string): string {
  const { rows, absent } = scanBase(text);
  return `${text}\n${BASE_SEAL_PREFIX}${rows.length + absent.length}\n`;
}

/**
 * Read a recorded base back: every row it holds, and every path that found
 * nothing, skipping framing lines. Returns undefined, meaning no base, where
 * the last non-empty line is not a seal or its count does not match what was
 * read (a truncated or torn copy, or one an older fabr wrote).
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

/** Scan a base's text for its rows and absences, skipping every other line.
 * Both the seal's count and the read-back use it, so they count alike. */
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

/* ── The source index ─────────────────────────────────────────
 * A project's stat cache: one row per source file used, holding the file's
 * content hash and mime with the size and mtime it was hashed at, so a run
 * whose stat matches can skip reading the file. Only a `verified` row (one a
 * second hashing reproduced; see SourceFileSource.recordIndexRow) is used on
 * a stat match; an unverified one is hashed again.
 */

/** One source file's row in the source index. `mtimeMs` keeps
 * `fs.Stats.mtimeMs`'s full precision and is compared exactly. `verified` is
 * true where two hashings at this stat agreed; only such a row is used on a
 * stat match. */
export interface ISourceIndexRow {
  readonly name: string;
  readonly hash: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mime: string;
  readonly verified: boolean;
}

/** The source index's header. `root` is the real path of the source tree the
 * rows describe; `algorithm` names the hash the rows carry; `writtenAt` is when
 * it was written, for information only. */
export interface ISourceIndexMeta {
  readonly root: string;
  readonly algorithm: string;
  readonly writtenAt: number;
}

/** The source-index magic. Bump it on any change of grammar or meaning: an
 * older record then reads as absent. */
const SOURCE_INDEX_MAGIC = "!source-index 2 ";

/** Serialize a source index: the magic and the header (with the row count),
 * then one `hash size mtimeMs <trust> name mime` row per file in code-unit
 * name order, `<trust>` `=` for a verified row and `?` for an unverified one. */
export function serializeSourceIndex(meta: ISourceIndexMeta, rows: ReadonlyMap<string, ISourceIndexRow>): string {
  const lines = [...rows.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(row => `${row.hash} ${row.size} ${row.mtimeMs} ${row.verified ? "=" : "?"} ${encodeName(row.name)} ${row.mime}`);
  const header = { ...meta, rows: rows.size };
  return [SOURCE_INDEX_MAGIC + JSON.stringify(header), ...lines, ""].join("\n");
}

/**
 * Read a source index back, or return undefined for anything that is not
 * exactly one: a wrong magic or header, any malformed row, or a row count
 * that differs from the header's (a truncated copy). Never a partial read.
 */
export function parseSourceIndex(text: string): { meta: ISourceIndexMeta; rows: Map<string, ISourceIndexRow> } | undefined {
  if (!text.startsWith(SOURCE_INDEX_MAGIC)) {
    return undefined;
  }
  const lines = text.split("\n");
  let header: { root?: unknown; algorithm?: unknown; writtenAt?: unknown; rows?: unknown };
  try {
    header = JSON.parse(lines[0].substring(SOURCE_INDEX_MAGIC.length)) as typeof header;
  } catch {
    return undefined;
  }
  const { root, algorithm, writtenAt } = header;
  if (typeof root !== "string" || typeof algorithm !== "string" || typeof writtenAt !== "number") {
    return undefined;
  }
  const rows = new Map<string, ISourceIndexRow>();
  for (const line of lines.slice(1)) {
    if (line.length === 0) {
      continue;
    }
    const row = parseSourceIndexRow(line);
    if (row === undefined) {
      return undefined;
    }
    rows.set(row.name, row);
  }
  return rows.size === header.rows ? { meta: { root, algorithm, writtenAt }, rows } : undefined;
}

/** Read one source-index row back, or return undefined for a line that is
 * not one. Every field must be non-empty (`Number("")` is 0), and the trust
 * mark exactly `=` or `?`. The mime is the rest of the line after the name. */
function parseSourceIndexRow(line: string): ISourceIndexRow | undefined {
  const afterHash = line.indexOf(" ");
  const afterSize = line.indexOf(" ", afterHash + 1);
  const afterMtime = line.indexOf(" ", afterSize + 1);
  const afterTrust = line.indexOf(" ", afterMtime + 1);
  const afterName = line.indexOf(" ", afterTrust + 1);
  if (
    afterHash < 1 ||
    afterSize <= afterHash + 1 ||
    afterMtime <= afterSize + 1 ||
    afterTrust !== afterMtime + 2 ||
    afterName <= afterTrust + 1 ||
    afterName + 1 >= line.length
  ) {
    return undefined;
  }
  const size = Number(line.substring(afterHash + 1, afterSize));
  const mtimeMs = Number(line.substring(afterSize + 1, afterMtime));
  const trust = line.substring(afterMtime + 1, afterTrust);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || (trust !== "=" && trust !== "?")) {
    return undefined;
  }
  return {
    hash: line.substring(0, afterHash),
    size,
    mtimeMs,
    verified: trust === "=",
    name: decodeName(line.substring(afterTrust + 1, afterName)),
    mime: line.substring(afterName + 1),
  };
}

/* ── The discovered-deps record ───────────────────────────────
 * A {@link DiscoveredDeps} written as a section per discoverable input: a line
 * with the input's name, then one line per path, indented by a space, in its
 * flat spelling ({@link joinDepsPath}).
 */

/** The discovered-deps record's magic. Bump it on any change of grammar or
 * meaning: an older record then reads as absent. */
const DISCOVERED_DEPS_MAGIC = "!discovered-deps 4";

/** Serialize a selection as a discovered-deps record, sections and paths each
 * sorted, so one selection always has one text. */
export function serializeDiscoveredDeps(selection: DiscoveredDeps): string {
  const sections = [...selection.keys()].sort().flatMap(input => [
    encodeName(input),
    ...selection
      .get(input)!
      .map(path => ` ${joinDepsPath(path)}`)
      .sort(),
  ]);
  return [DISCOVERED_DEPS_MAGIC, ...sections, ""].join("\n");
}

/** Read a discovered-deps record back, or return undefined for anything that
 * is not exactly one. */
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
