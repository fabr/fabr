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
 * The tsc driver's incremental planning: from the names fabr reports changed
 * and deleted since the last green build, decide which files to check and
 * emit, and read and write the driver's memo of the import graph.
 *
 * The **memo** is the driver's own file in its `--state-dir`. Fabr keeps it with
 * the target's build state and stages it back, and never reads it. A memo that
 * is missing, damaged or of another format version means a cold compile.
 *
 * Names here are **node names**: a project file by its staged path, a
 * dependency's file by the path it is reached by (see PnpResolver.pathNameOf),
 * which contains a space.
 *
 * This module must not import fabr. The vocabulary it shares with the build
 * step (dependency path names, the changes document) comes from pnp/ReadSet.ts.
 */

import { IChangeLists } from "../pnp/ReadSet";

/** The extensions of the files a TypeScript program can hold. Any other file
 * under the source root is no file of the graph. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** The flag naming where the caller staged the declarations another compile
 * emitted for some of this compile's sources, laid out as the source root is.
 * Those sources are compiled against, and neither checked nor emitted. */
export const SOURCE_DECLARATIONS_FLAG = "--source-declarations";

/** The declaration extension a source's declaration has, by the source's own. */
export const DECLARATION_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".ts", ".d.ts"],
  [".tsx", ".d.ts"],
  [".js", ".d.ts"],
  [".jsx", ".d.ts"],
  [".mts", ".d.mts"],
  [".mjs", ".d.mts"],
  [".cts", ".d.cts"],
  [".cjs", ".d.cts"],
]);

/** The declaration extensions. Match them whole: `util.d.ts` has the stem
 * `util`, not `util.d`. */
const DECLARATION_EXTENSIONS = [...new Set(DECLARATION_EXTENSION.values())];

/** @return `name` without its extension: a declaration extension (`.d.ts`,
 * `.d.mts`, `.d.cts`) whole, else any of {@link SOURCE_EXTENSIONS} (the `.js`
 * spellings included, as an ES-module source names a TypeScript file); `name`
 * as it is where it has none. */
export function sourceStem(name: string): string {
  const dropped =
    DECLARATION_EXTENSIONS.find(extension => name.endsWith(extension)) ??
    SOURCE_EXTENSIONS.find(extension => name.endsWith(extension));
  return dropped === undefined ? name : name.slice(0, -dropped.length);
}

/** The extensions resolution tries after a relative specifier, in the order it
 * tries them. */
const PROBED_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** @return `name` with its `.` and empty segments dropped and each `..` applied
 * (a leading `..` is kept). Names are `/`-separated on every platform. */
export function normalizeName(name: string): string {
  const segments: string[] = [];
  for (const segment of name.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/**
 * Resolve a relative specifier written in `from` against the names `isMember`
 * accepts, trying candidates in resolution's order: the path as written, then
 * with each of {@link PROBED_EXTENSIONS} (after dropping a `.js`, `.mjs` or
 * `.cjs` extension, since an ES-module specifier names the emitted file), then
 * as a directory's `index` file with each extension.
 *
 * @return the first candidate that is a member, or undefined for a bare
 *   specifier or where no candidate is one.
 */
export function membershipTarget(from: string, specifier: string, isMember: (name: string) => boolean): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const directory = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const base = normalizeName(directory === "" ? specifier : `${directory}/${specifier}`);
  /* An ES-module specifier names the emitted file (`./util.js` for `util.ts`). */
  const written = base.replace(/\.[cm]?js$/, "");
  for (const candidate of [
    base,
    ...PROBED_EXTENSIONS.map(extension => `${written}${extension}`),
    ...PROBED_EXTENSIONS.map(extension => `${written}/index${extension}`),
  ]) {
    if (isMember(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * One edge of the memo's graph: an import a file makes. `specifier` is as the
 * source wrote it (`./foo`, never the `./foo.js` the ES-module rewrite emits).
 * `target` is the node name it resolved to, recorded only where
 * {@link membershipTarget} cannot recover it: a bare specifier, or a
 * package's reference to itself through its `exports`.
 */
export interface IMemoEdge {
  specifier: string;
  target?: string;
}

/** What the memo records of one file after the last green build. */
export interface IMemoFile {
  /** true if the file's declarations affect global scope. */
  global: boolean;
  /** The imports of the file's body. */
  use: IMemoEdge[];
  /** The imports its emitted declarations make, which a consumer of the file
   * depends on in turn. A declaration file's imports are all forwarding edges. */
  forwarding: IMemoEdge[];
  /** The outputs the last build that emitted this file wrote for it, as the
   * entry names them: what to delete once the file is gone. */
  outputs?: string[];
  /** Each package lookup the file made that found nothing, named by the path it
   * took ending at the manifest (`thing package.json`), as the read set names
   * the absence. A change list naming it means the package appeared, and the
   * file must be checked again. */
  failed?: string[];
}

/** The driver's memo: each file of the last green build, by node name. */
export type DriverMemo = Map<string, IMemoFile>;

/** The memo's header: magic and format version. Bump the version on any change
 * to what a line means; a memo of another version reads as none. */
const MEMO_MAGIC = "!tscmemo";
const MEMO_VERSION = 2;
/** The field marking a file whose declarations affect global scope. */
const GLOBAL_FLAG = "!g";
/** The field separating a line's sections: use edges, forwarding edges, then
 * the outputs and the failed lookups. A trailing section is written only where
 * it or a later one has members. Every other field is encoded, so a bare `|`
 * is always a separator. */
const EDGE_SEPARATOR = "|";

/** @return the memo as text: the header, then one line per file, sorted by
 * name. It carries no checksum; fabr's record of it does. */
export function serializeDriverMemo(files: DriverMemo): string {
  return [`${MEMO_MAGIC} ${MEMO_VERSION}`, ...[...files.keys()].sort().map(name => fileLine(name, files.get(name)!)), ""].join("\n");
}

/**
 * Read a memo. Never throws: anything that is not exactly a memo of this
 * version (a wrong header, a torn line, a field that does not decode) reads as
 * undefined.
 */
export function parseDriverMemo(data: string): DriverMemo | undefined {
  const lines = data.split("\n");
  if (lines[0] !== `${MEMO_MAGIC} ${MEMO_VERSION}`) {
    return undefined;
  }
  const memo: DriverMemo = new Map();
  try {
    for (const line of lines.slice(1)) {
      if (line.length === 0) {
        continue;
      }
      const parsed = parseFileLine(line);
      if (parsed === undefined) {
        return undefined;
      }
      memo.set(parsed.name, parsed.file);
    }
  } catch {
    /* A field that does not decode (a truncated escape). */
    return undefined;
  }
  return memo;
}

/**
 * What to compile. The **wave** is the set of files a run checks and emits,
 * grown from the seeds over the memo's edges (see Wave.ts); the **bound** is
 * the set of project files the program is rooted at, which holds every file
 * the wave can reach.
 */
export interface ICompilePlan {
  /** The names the wave grows from: the changed and deleted names, plus the
   * importers an added file may now resolve to. Undefined for a full compile
   * of every project file. */
  readonly seeds: ReadonlySet<string> | undefined;
  /** The bound. Undefined to root the program at every project file; an empty
   * set means nothing needs checking. */
  readonly roots: ReadonlySet<string> | undefined;
  /** The base build's memo; empty for a cold compile. */
  readonly memo: DriverMemo;
  /** The names fabr reported deleted, whose memo lines are dropped and whose
   * recorded outputs are stale. */
  readonly deleted: ReadonlySet<string>;
  /** Present for a full compile: why. The driver then starts the emit
   * directory from nothing rather than from the base build's outputs. */
  readonly fresh?: { reason: string; cause?: string };
}

/**
 * Plan the compile from the names fabr reports changed and deleted since the
 * base build.
 *
 * Every changed and deleted name is a seed, and so is each file whose import
 * an added file may now resolve to ({@link rebound}). The bound is what the
 * seeds can reach backwards over the memo's edges, plus every file affecting
 * global scope; it is every project file where a seed affected global scope.
 *
 * The plan is a full compile (`seeds` undefined, `fresh` set) where:
 * - there is no base build (`changes` undefined), or `memo` is undefined (the
 *   driver could not read its memo);
 * - a changed name is no file of the graph: not a dependency's file, nor a
 *   source under `sourceRoot` (the generated configuration, the tool's mount);
 * - an added dependency's file is claimed by no edge or failed lookup of the
 *   memo, and nothing else of its package changed (a `@typescript/lib-*`
 *   replacement or a type directive's package appearing).
 *
 * A deleted name with no memo line seeds nothing.
 *
 * @param projectFiles the project files on disk, by node name.
 * @param sourceRoot the source root as a node-name prefix (`src`), or undefined
 *   where the project states none, in which case every changed project file
 *   makes a full compile.
 */
export function planCompile(
  changes: IChangeLists | undefined,
  memo: DriverMemo | undefined,
  projectFiles: ReadonlySet<string>,
  sourceRoot: string | undefined
): ICompilePlan {
  if (changes === undefined) {
    return coldPlan("no base build");
  }
  if (memo === undefined) {
    /* A base build, but a memo this driver cannot read. The deleted names are
     * still kept, for their stale outputs. */
    return coldPlan("unreadable memo", undefined, changes.deleted);
  }
  const seeds = new Set<string>();
  const added: string[] = [];
  for (const name of changes.changed) {
    if (!isNode(name, sourceRoot)) {
      return coldPlan(`'${name}' is no file of the graph`, memo, changes.deleted);
    }
    seeds.add(name);
    if (!memo.has(name)) {
      added.push(name);
    }
  }
  for (const name of changes.deleted) {
    seeds.add(name);
  }
  const { importers, explained } = rebound(memo, added);
  for (const importer of importers) {
    seeds.add(importer);
  }
  /* An added dependency's file that no memo edge or failed lookup claims, with
   * no other change in its package, was asked for by the program as a whole: a
   * `@typescript/lib-*` replacement or a type directive's package appearing, or
   * a manifest edited with its files unchanged. It can change the global types
   * or what any import resolves to, so compile everything. An added project
   * file needs no such check: what it can change, {@link rebound} finds. */
  const moved = [...changes.changed, ...changes.deleted];
  for (const name of added) {
    if (isDependencyName(name) && !explained.has(name) && !moved.some(other => other !== name && sharesRoute(name, other))) {
      return coldPlan(`nothing bounds '${name}'`, memo, changes.deleted);
    }
  }
  return { seeds, roots: boundFor(memo, seeds, projectFiles), memo, deleted: new Set(changes.deleted) };
}

/** @return true if `other` is in the same package as the dependency's file
 * `name` (it shares the path up to `name`'s last segment), otherwise false. */
function sharesRoute(name: string, other: string): boolean {
  return other.startsWith(name.substring(0, name.lastIndexOf(" ") + 1));
}

/**
 * @return the stems an added file could take for `edge` (an import of
 * `importer`) to resolve to it; empty where no added file can.
 *
 * A **relative** specifier gives the stem of the path it names, extension
 * dropped (`./util.js` gives `util`, as it resolves to `util.ts`).
 *
 * A **bare** specifier gives the stems of its recorded `target` (a package's
 * reference to itself): `mypkg/util` resolving to `util/index.ts` gives
 * `util/index` and `util`, so an added `util.ts` beside it is found. A bare
 * specifier with no recorded target gives none.
 */
function probeBases(importer: string, edge: IMemoEdge): string[] {
  if (!edge.specifier.startsWith(".")) {
    return edge.target === undefined ? [] : bindableBases(edge.target);
  }
  const directory = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  return [sourceStem(normalizeName(directory === "" ? edge.specifier : `${directory}/${edge.specifier}`))];
}

/** @return the stems a specifier resolving to `name` could have: its own, and,
 * for an `index.*`, its directory's. */
function bindableBases(name: string): string[] {
  const stem = sourceStem(name);
  const directory = stem.endsWith("/index") ? [stem.slice(0, -"/index".length)] : [];
  return [stem, ...directory];
}

/**
 * @return the memo to keep after a run: the base's lines, less the `deleted`
 * names, with each line the run `learned` replacing the base's. A learned line
 * with no `outputs` keeps the base line's.
 */
export function mergeMemo(base: DriverMemo, deleted: Iterable<string>, learned: DriverMemo): DriverMemo {
  const merged = new Map(base);
  for (const name of deleted) {
    merged.delete(name);
  }
  for (const [name, file] of learned) {
    const outputs = file.outputs ?? base.get(name)?.outputs;
    merged.set(name, { ...file, ...(outputs !== undefined && outputs.length > 0 ? { outputs: [...outputs] } : {}) });
  }
  return merged;
}

/** A diagnostic as the run report records it. Its rendered form goes to
 * stdout. */
export interface IDriverDiagnostic {
  file?: string;
  code: number;
  category: string;
  message: string;
  line?: number;
  character?: number;
}

/** What a run reports of its own compile, under the report's `compile` field.
 * Read by tests comparing runs; fabr does not read it. */
export interface ICompileTelemetry {
  /** Every file the wave came to hold, in the order it grew. */
  wave: string[];
  /** Present where the wave became every project file because a file affecting
   * global scope changed: why, and that file. */
  expanded?: { reason: string; cause?: string };
  /** The files written, under the names they were written as. */
  emitted: string[];
  /** true if the run was abandoned and redone rooted at every project file. */
  fellBack?: boolean;
  diagnostics: IDriverDiagnostic[];
  /** How many project files the run rooted at, of how many; absent where it
   * rooted at every one. */
  bound?: { roots: number; project: number };
}

/** Read the `compile` field of a run report; undefined for a report with none.
 * Checks only that it is an object. */
export function toCompileTelemetry(json: unknown): ICompileTelemetry | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("expected a JSON object");
  }
  const compile = (json as { compile?: unknown }).compile;
  if (compile === undefined) {
    return undefined;
  }
  if (typeof compile !== "object" || compile === null || Array.isArray(compile)) {
    throw new Error("expected 'compile' to be an object");
  }
  return compile as ICompileTelemetry;
}

/*
 * Module-private implementation below this point.
 */

/**
 * @return `text` escaped as a memo line's field: `encodeURI` (which escapes the
 * space and `|`, and leaves `/`, `:`, `@` and `&`), plus `=` (the split
 * between an edge's specifier and target) and a leading `!` (which could
 * otherwise spell the `!g` field or the header).
 */
function encodeField(text: string): string {
  const encoded = encodeURI(text).replace(/=/g, "%3D");
  return encoded.startsWith("!") ? `%21${encoded.slice(1)}` : encoded;
}

function decodeField(field: string): string {
  return decodeURIComponent(field);
}

/** @return an edge as one field: `spec`, or `spec=target` where the memo
 * recorded one. */
function edgeField(edge: IMemoEdge): string {
  return edge.target === undefined ? encodeField(edge.specifier) : `${encodeField(edge.specifier)}=${encodeField(edge.target)}`;
}

function fileLine(name: string, file: IMemoFile): string {
  const outputs = file.outputs ?? [];
  const failed = file.failed ?? [];
  return [
    encodeField(name),
    ...(file.global ? [GLOBAL_FLAG] : []),
    ...file.use.map(edgeField),
    EDGE_SEPARATOR,
    ...file.forwarding.map(edgeField),
    ...(outputs.length > 0 || failed.length > 0 ? [EDGE_SEPARATOR, ...outputs.map(encodeField)] : []),
    ...(failed.length > 0 ? [EDGE_SEPARATOR, ...failed.map(encodeField)] : []),
  ].join(" ");
}

function parseFileLine(line: string): { name: string; file: IMemoFile } | undefined {
  const fields = line.split(" ");
  if (fields.length < 2) {
    return undefined;
  }
  let at = 1;
  const global = fields[at] === GLOBAL_FLAG;
  if (global) {
    at++;
  }
  const split = fields.indexOf(EDGE_SEPARATOR, at);
  if (split < 0) {
    return undefined;
  }
  /* The trailing sections are optional: a line with one separator is a file
   * with no outputs and no failed lookups. */
  const emitted = fields.indexOf(EDGE_SEPARATOR, split + 1);
  const failedAt = emitted < 0 ? -1 : fields.indexOf(EDGE_SEPARATOR, emitted + 1);
  const outputsEnd = failedAt < 0 ? undefined : failedAt;
  const outputs = emitted < 0 ? [] : fields.slice(emitted + 1, outputsEnd).map(decodeField);
  const failed = failedAt < 0 ? [] : fields.slice(failedAt + 1).map(decodeField);
  return {
    name: decodeField(fields[0]),
    file: {
      global,
      use: fields.slice(at, split).map(parseEdge),
      forwarding: fields.slice(split + 1, emitted < 0 ? undefined : emitted).map(parseEdge),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    },
  };
}

function parseEdge(field: string): IMemoEdge {
  const split = field.indexOf("=");
  return split < 0
    ? { specifier: decodeField(field) }
    : { specifier: decodeField(field.substring(0, split)), target: decodeField(field.substring(split + 1)) };
}

/** @return a full-compile plan over `memo` (empty where omitted), keeping the
 * `deleted` names. */
function coldPlan(reason: string, memo?: DriverMemo, deleted?: Iterable<string>): ICompilePlan {
  return { seeds: undefined, roots: undefined, memo: memo ?? new Map(), deleted: new Set(deleted ?? []), fresh: { reason } };
}

/** @return true if `name` is a dependency's file, otherwise false: its name
 * (the packages it was reached through, then the file) contains a space, which
 * no staged path does. */
function isDependencyName(name: string): boolean {
  return name.indexOf(" ") > 0;
}

/** @return true if `name` can be a file of the graph (a dependency's file, or a
 * source under `sourceRoot`), otherwise false. */
function isNode(name: string, sourceRoot: string | undefined): boolean {
  if (isDependencyName(name)) {
    return true;
  }
  return (
    sourceRoot !== undefined && name.startsWith(`${sourceRoot}/`) && SOURCE_EXTENSIONS.some(extension => name.endsWith(extension))
  );
}

/**
 * @return the bound: the project files on disk among the seeds, the files
 * importing a seed (directly or through other files, over either kind of
 * edge), and the files the memo marks as affecting global scope. Undefined
 * (every file) where a seed's memo line affects global scope.
 *
 * Always include the global-scope files: nothing imports them, and a program
 * without one loses its declarations.
 */
function boundFor(memo: DriverMemo, seeds: ReadonlySet<string>, projectFiles: ReadonlySet<string>): Set<string> | undefined {
  for (const name of seeds) {
    if (memo.get(name)?.global === true) {
      return undefined;
    }
  }
  const bound = new Set<string>();
  /* Project files on disk only. A dependency's file can be a seed but never a
   * root: the compiler reaches it through resolution. */
  const root = (name: string): void => {
    if (projectFiles.has(name)) {
      bound.add(name);
    }
  };
  for (const name of potentialWave(memo, seeds)) {
    root(name);
  }
  for (const [name, file] of memo) {
    if (file.global) {
      root(name);
    }
  }
  return bound;
}

/** @return `seeds` and every file of the memo importing one of them, directly
 * or through other files, over either kind of edge. */
function potentialWave(memo: DriverMemo, seeds: ReadonlySet<string>): Set<string> {
  const dependers = new Map<string, string[]>();
  const record = (target: string, depender: string): void => {
    const held = dependers.get(target) ?? [];
    dependers.set(target, held);
    held.push(depender);
  };
  for (const [name, file] of memo) {
    for (const edge of [...file.use, ...file.forwarding]) {
      record(edge.target ?? edge.specifier, name);
      const derived = membershipTarget(name, edge.specifier, other => memo.has(other));
      if (derived !== undefined && derived !== edge.target) {
        record(derived, name);
      }
    }
  }
  const reached = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reached.has(name)) {
      continue;
    }
    reached.add(name);
    for (const depender of dependers.get(name) ?? []) {
      pending.push(depender);
    }
  }
  return reached;
}

/**
 * Find the files of the memo whose imports an `added` file may now resolve to.
 * An import matches an added file where the stems it could resolve to
 * ({@link probeBases}) include one the added file has ({@link bindableBases});
 * a failed lookup matches an added name equal to it (`thing package.json`).
 * Matching ignores which extension resolution would prefer: an added `foo.tsx`
 * beside `foo.ts` matches `./foo`'s importer though `foo.ts` still wins.
 *
 * @return `importers`, the files matched, and `explained`, the added names
 *   that matched any file.
 */
function rebound(memo: DriverMemo, added: ReadonlyArray<string>): { importers: Set<string>; explained: Set<string> } {
  const importers = new Set<string>();
  const explained = new Set<string>();
  if (added.length === 0) {
    return { importers, explained };
  }
  const index = new Map<string, Set<string>>();
  const claim = (base: string, importer: string): void => {
    const held = index.get(base) ?? new Set<string>();
    index.set(base, held);
    held.add(importer);
  };
  for (const [importer, file] of memo) {
    for (const edge of [...file.use, ...file.forwarding]) {
      for (const base of probeBases(importer, edge)) {
        claim(base, importer);
      }
    }
    for (const name of file.failed ?? []) {
      claim(name, importer);
    }
  }
  for (const name of added) {
    for (const base of [name, ...bindableBases(name)]) {
      for (const importer of index.get(base) ?? []) {
        explained.add(name);
        importers.add(importer);
      }
    }
  }
  return { importers, explained };
}
