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
 * The driver's incremental planning: everything between "these names changed"
 * and "compile exactly this" (see DESIGN-file-deps.md).
 *
 * The division of facts is the design: fabr's native facts are bytes and
 * hashes, so fabr diffs the staged inputs against its own manifest triples and
 * hands over two name lists. Everything *graph*-shaped — which change reaches
 * what, which file roots global scope, what an addition can re-bind, which
 * outputs a vanished source leaves stale — is compiler-domain knowledge, and
 * lives here, beside the compiler that produces it.
 *
 * The **memo** this module reads and writes is the driver's own section of the
 * build memo: fabr stores it, pairs it with the entry it describes, and never
 * reads inside, so its format — and the format-version-mismatch-means-cold
 * rule — is private to this module. Damage or an unreadable version costs one
 * cold compile of that target key, exactly what a missing memo costs.
 *
 * This module is the driver's and must not import fabr; the vocabulary it
 * shares with the step (instance names, surface entries, the changes document)
 * comes from pnp/ReadSet.ts, which is shared source with no core dependency.
 */

import { IChangeLists, IResolutionEdge } from "../pnp/ReadSet";

/** The extensions a TypeScript program can hold — everything else staged under
 * the source root is content the compiler never opens. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** The extensions of a declaration file, which end in `.ts`/`.mts`/`.cts` and
 * so must be recognized whole: stripping one segment of `util.d.ts` leaves
 * `util.d`, a base no import ever probes. */
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];

/** A source name with its extension removed — including the emitted spellings,
 * which is how an ES-module source names a TypeScript file, and the compound
 * declaration extensions as units. */
export function sourceStem(name: string): string {
  const dropped =
    DECLARATION_EXTENSIONS.find(extension => name.endsWith(extension)) ??
    SOURCE_EXTENSIONS.find(extension => name.endsWith(extension));
  return dropped === undefined ? name : name.slice(0, -dropped.length);
}

/**
 * The extensions a relative specifier may have been written without, in the
 * order resolution probes them — and the ES-module spelling, where `./util.js`
 * is how a source names `util.ts`.
 */
const PROBED_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** A logical name with its `.` and `..` segments applied — names are always
 * `/`-separated, whatever the platform. */
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
 * What a relative specifier names against a bare list of names — resolution's
 * probe order, replayed. The planner walks the memo's edges backwards with it,
 * and the wave answers an edge whose target has been deleted (the one case
 * live resolution cannot).
 */
export function membershipTarget(from: string, specifier: string, isMember: (name: string) => boolean): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const directory = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const base = normalizeName(directory === "" ? specifier : `${directory}/${specifier}`);
  /* An ES-module specifier names the file the compile EMITS; the source it
   * resolves to is the one the extension was substituted for. */
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
 * One outgoing edge. `specifier` is the authored form (`./foo`, never the
 * `./foo.js` an ES-module rewrite emits), since a later build re-resolves it.
 * `target` rides along only where membership could not replay the resolution —
 * a bare name, or a self-reference through a package's `exports`.
 */
export interface IMemoEdge {
  specifier: string;
  target?: string;
}

/**
 * What the memo knows about one file: whether its declarations affect global
 * scope, its outgoing edges of both kinds, the outputs attributed to it, and
 * the lookups it tried that found nothing.
 *
 * Use edges live in the file's body (its imports); forwarding edges appear in
 * its own emitted interface, and are what a consumer transitively depends on.
 * A declaration file has no body, so its imports are its forwarding edges.
 * `outputs` is what the build that last emitted this source wrote FOR it, as
 * the entry names them — recorded rather than derived, because only the
 * compiler knows its own source→output mapping, and it is what lets a later
 * build delete the stale outputs of a source that has gone.
 *
 * `failed` is each package lookup this file made that nothing answered, named
 * by the path it took ending at the manifest (`thing package.json`) — the same
 * name the read set reports the absence under, so a later change list's
 * appearance of that name matches it verbatim. Recorded because the failure is
 * an edge to nothing: whether tsc settled for the `@types` sidecar or reported
 * the import unresolvable, no resolved edge names the package that was asked
 * for, so without this line the one change that must re-check the file — that
 * package appearing — reaches it through nothing (see {@link rebound}).
 */
export interface IMemoFile {
  global: boolean;
  use: IMemoEdge[];
  forwarding: IMemoEdge[];
  outputs?: string[];
  failed?: string[];
}

/** The driver's memo: what it knew of each file after the last green build,
 * keyed by node name (a project file by staged path, a dependency's file by
 * its instance name — see ReadSet.ts). */
export type DriverMemo = Map<string, IMemoFile>;

/** The memo format's version, in the header. A change to what the lines mean
 * is a bump: an older memo then parses as malformed, is ignored, and that
 * target key compiles cold once. */
const MEMO_MAGIC = "!tscmemo";
const MEMO_VERSION = 2;
/** The per-file flag: this file's declarations affect global scope, so a
 * change to it bounds nothing. */
const GLOBAL_FLAG = "!g";
/** Separates a line's sections: use edges, then forwarding edges, then — where
 * the file emitted any — the outputs attributed to it, then — where any lookup
 * found nothing — the failed lookups. Every field is encoded, so a bare one of
 * these can only ever be a separator. A trailing section is present only where
 * it has members, and an earlier empty one is held open by its separator when
 * a later one follows. */
const EDGE_SEPARATOR = "|";

/** The memo's bytes. Lines are name-sorted, so identical memos give identical
 * bytes; integrity is the enclosing record's business (fabr checksums the
 * whole memo it stores), so there is none here. */
export function serializeDriverMemo(files: DriverMemo): string {
  return [`${MEMO_MAGIC} ${MEMO_VERSION}`, ...[...files.keys()].sort().map(name => fileLine(name, files.get(name)!)), ""].join("\n");
}

/**
 * Read a memo, or **undefined for anything that is not exactly one**: a wrong
 * magic, an unsupported version, a torn line, a field that does not decode. It
 * never throws — a memo this driver cannot read means a cold compile, the same
 * price a missing one costs.
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
    /* A field that does not decode (a truncated escape) is the same answer as
     * any other damage. */
    return undefined;
  }
  return memo;
}

/**
 * What to compile, planned from what fabr said changed.
 *
 * `seeds` is what the wave grows from — the changed and deleted names, plus
 * the importers an addition may have re-bound; undefined means every project
 * file, the answer whenever nothing bounds the change's reach (no base, an
 * unreadable memo, a non-node input moved).
 * `roots` is the bound — the project files the program is rooted at;
 * undefined roots at everything, and an empty bound is a legitimate answer
 * (nothing to check), so the two must not share a spelling.
 */
export interface ICompilePlan {
  readonly seeds: ReadonlySet<string> | undefined;
  readonly roots: ReadonlySet<string> | undefined;
  /** The base build's graph — empty for a cold compile. */
  readonly memo: DriverMemo;
  /** The names fabr reported gone, which the merged memo drops and whose
   * recorded outputs are stale. */
  readonly deleted: ReadonlySet<string>;
  /** Present where the plan is a full compile: the carried output tree cannot
   * be incrementally corrected, so the driver starts the emit from nothing. */
  readonly fresh?: { reason: string; cause?: string };
}

/**
 * Plan the compile from fabr's diff.
 *
 * The classification: a changed name the graph can bound — a project source or
 * a dependency's file — seeds the wave; anything else that moved (the
 * generated configuration, the tool's own mount) is a change whose reach no
 * edge can bound, so the answer is every file.
 *
 * A **deleted** name is an ordinary seed: its shape is nothing, which differs
 * from whatever it was, so the wave reaches its dependers through the memo's
 * edges exactly as any other change does. A deleted DISCOVERABLE DEP is half of a
 * dependency bump — instance names carry the node's reference, so a dependency
 * whose content moved is a delete plus an add — and an instance's surface
 * entry vanishes only with the instance itself, so it carries nothing the
 * vanished files' lines do not.
 */
/**
 * @param projectFiles the project files on disk, by node name.
 * @param sourceRoot the source root as a node-name prefix (`src`) — which
 *   decides which staged names can be files of the graph — or undefined where
 *   the project states none, in which case no project-space change can be
 *   classified and every change costs a full compile.
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
    /* Fabr had a base but this driver cannot read its own section — a format
     * bump, or a different driver's bytes. Cold, but the deleted names still
     * mean what they mean. */
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
  /* An added DEPENDENCY-space name the graph cannot explain — no memo line, no
   * failed lookup or probe that claims it, and no sibling change of its own
   * package to carry the reach (a bump's manifest row rides its files' lines) —
   * was asked for at PROGRAM level: a `@typescript/lib-*` replacement or a type
   * directive's package appearing, or a manifest edited with its files
   * untouched (an `exports` edit re-binding by content no row carries). Those
   * move the global type environment or the binding of anything that asks, so
   * no wave bounds them; left in the seeds they would wave nothing at all. A
   * workspace addition is exempt: a new source nothing imports yet is benign,
   * and rebound covers what one can capture. Deletions need no counterpart —
   * a vanished lib or ambient package had HELD files, whose global-flagged
   * lines already unbound the plan. */
  const moved = [...changes.changed, ...changes.deleted];
  for (const name of added) {
    if (isDependencyName(name) && !explained.has(name) && !moved.some(other => other !== name && sharesRoute(name, other))) {
      return coldPlan(`nothing bounds '${name}'`, memo, changes.deleted);
    }
  }
  return { seeds, roots: boundFor(memo, seeds, projectFiles), memo, deleted: new Set(changes.deleted) };
}

/** Whether `other` is a change within the same package `name` names — sharing
 * the route up to `name`'s own file segment. */
function sharesRoute(name: string, other: string): boolean {
  return other.startsWith(name.substring(0, name.lastIndexOf(" ") + 1));
}

/**
 * The paths an edge's specifier probes from — empty for one no in-tree addition
 * can capture.
 *
 * A **relative** specifier probes from the path it names, with the resolution
 * mode's substitution applied: a specifier authored `./util.js` (the ES-module
 * spelling) binds `util.ts`, so indexing the raw text would miss the re-bind.
 *
 * A **bare** specifier is the package table's business and no addition can
 * capture it — except where it already resolved into this compile's own tree (a
 * package's reference to itself, which the table answers with a source file),
 * and there what could be captured is every name that could have produced the
 * file it landed on: `mypkg/util` resolving to `util/index.ts` is captured by a
 * `util.ts` appearing beside it, which offers the directory's own name.
 */
function probeBases(importer: string, edge: IMemoEdge): string[] {
  if (!edge.specifier.startsWith(".")) {
    return edge.target === undefined ? [] : bindableBases(edge.target);
  }
  const directory = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  return [sourceStem(normalizeName(directory === "" ? edge.specifier : `${directory}/${edge.specifier}`))];
}

/** The names an added file could be probed as: its own stem, and — for an
 * `index.*` — the directory that resolves to it. */
function bindableBases(name: string): string[] {
  const stem = sourceStem(name);
  const directory = stem.endsWith("/index") ? [stem.slice(0, -"/index".length)] : [];
  return [stem, ...directory];
}

/**
 * The memo to remember: the base's, with this run's knowledge over the top.
 *
 * The rule is what a run's account means — it says what it looked at, and says
 * nothing about what it had no reason to open. So a file the run reported
 * replaces its line, a file it did not keeps the base's, and a file fabr said
 * is gone loses its line. One field falls back apart: a line's `outputs` is
 * the last build that EMITTED the file, so a fresh line that emitted nothing
 * keeps the base's attribution.
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

/** A diagnostic, structured — so a caller can compare two runs' outcomes
 * without parsing rendered text. The human rendering is unchanged and still
 * goes to stdout. */
export interface IDriverDiagnostic {
  file?: string;
  code: number;
  category: string;
  message: string;
  line?: number;
  character?: number;
}

/**
 * What an incremental run says about itself in its report — observation for a
 * caller comparing runs (the test suites), never read by fabr, whose whole
 * interest in the report is the reads and the memo.
 */
export interface ICompileTelemetry {
  /** Every file the wave came to hold, in the order it grew. */
  wave: string[];
  /** Present when the wave was expanded to the whole project rather than
   * computed, with the file that forced it — global scope is all-or-nothing. */
  expanded?: { reason: string; cause?: string };
  /** The files written, under the names they were written as. */
  emitted: string[];
  /** Whether the run was abandoned and redone rooted at every project file. */
  fellBack?: boolean;
  diagnostics: IDriverDiagnostic[];
  /** How much of the project the run rooted at — absent where it rooted at
   * everything. */
  bound?: { roots: number; project: number };
}

/**
 * The run's report file: what it READ and how its names RESOLVED (the
 * discovered-dependency halves, which the step joins into the walks the entry
 * is keyed on — see ReadSet.ts), plus its own telemetry, as sections of one
 * document. The driver's memo is not in here: it is a file, written into the
 * state directory the caller named.
 */
export function serializeRunReport(
  reads: Iterable<string>,
  edges: ReadonlyArray<IResolutionEdge>,
  compile?: ICompileTelemetry
): string {
  return `${JSON.stringify(
    {
      reads: [...new Set(reads)].sort(),
      /* Sorted, so a report is a function of what the run resolved and not of
       * the order it happened to ask. */
      edges: [...edges].sort((left, right) => compareEdges(left, right)),
      ...(compile === undefined ? {} : { compile }),
    },
    undefined,
    2
  )}\n`;
}

/** Edge order for the report: by requirer then name, in code-unit order —
 * never a locale comparison, the point being one spelling on every machine
 * (core's compareText, which the driver cannot import). */
function compareEdges(left: IResolutionEdge, right: IResolutionEdge): number {
  const l = `${left.from}\0${left.name}`;
  const r = `${right.from}\0${right.name}`;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** The telemetry half of a run report, for a test comparing runs; undefined
 * for a run that had none. The document is this driver's own output, so the
 * read is a shape check rather than a validation pass. */
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
 * A field, escaped so a space-separated line's structure is unambiguous.
 * `encodeURI` does the bulk — it escapes the space and the `|` separator while
 * leaving a path's `/` and a specifier's `:@&` legible. Two more characters
 * are escaped by hand because the line's own grammar gives them meaning:
 * `=` (an edge's spec/target split) and a LEADING `!` (which would otherwise
 * let a name spell the `!g` flag or the header). Defined here independently
 * of fabr's own manifest escaping BY RULE, not by drift: this module runs in
 * the build's child process and must not import core, and the two formats
 * never read each other's bytes.
 */
function encodeField(text: string): string {
  const encoded = encodeURI(text).replace(/=/g, "%3D");
  return encoded.startsWith("!") ? `%21${encoded.slice(1)}` : encoded;
}

function decodeField(field: string): string {
  return decodeURIComponent(field);
}

/** An edge as one field: `spec`, or `spec=target` where the memo recorded one. */
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
  /* The trailing sections are optional, so their absence is not damage: a line
   * with one separator is a file that emitted nothing and failed no lookup. */
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

/** The cold plan: no base to diff against, so the wave is every project file,
 * the emit starts from nothing, and this run's memo is the first. */
function coldPlan(reason: string, memo?: DriverMemo, deleted?: Iterable<string>): ICompilePlan {
  return { seeds: undefined, roots: undefined, memo: memo ?? new Map(), deleted: new Set(deleted ?? []), fresh: { reason } };
}

/** Whether a name is a dependency's file: named by the path it was reached by
 * — the packages an edge chain calls it through, then the file — so a space is
 * what tells one from a staged path (which is refused those names). See
 * PnpResolver.pathNameOf. */
function isDependencyName(name: string): boolean {
  return name.indexOf(" ") > 0;
}

/** Whether a name can be a node of the graph: a dependency's file, or a source
 * of this compile. */
function isNode(name: string, sourceRoot: string | undefined): boolean {
  if (isDependencyName(name)) {
    return true;
  }
  return (
    sourceRoot !== undefined && name.startsWith(`${sourceRoot}/`) && SOURCE_EXTENSIONS.some(extension => name.endsWith(extension))
  );
}

/**
 * The project files this compile roots its program at: the reverse closure of
 * `seeds` over both edge kinds, plus every file affecting global scope. The
 * wave is a subset of it by construction, expanding over those same edges.
 *
 * Global scope is rooted UNCONDITIONALLY, whatever the change was — a
 * project's ambient declarations are imported by nothing, so the closure never
 * reaches them and leaving one out deletes its declarations from the
 * compilation. Undefined means root at everything, the answer when a changed
 * file was itself global.
 */
function boundFor(memo: DriverMemo, seeds: ReadonlySet<string>, projectFiles: ReadonlySet<string>): Set<string> | undefined {
  for (const name of seeds) {
    if (memo.get(name)?.global === true) {
      return undefined;
    }
  }
  const bound = new Set<string>();
  /* Project files alone, and only ones still on disk. A dependency's file is
   * in the graph and can be the START of a wave, but it is never a root: the
   * compiler reaches it through resolution, and rooting it would compile
   * somebody else's package. */
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

/** The transitive reverse closure of `seeds` over both edge kinds — every
 * file that could come to depend on something that moved. */
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
 * The importers an **added** file may have captured — the one change that
 * reaches files with no edge to it at all.
 *
 * Resolution's probe order is invertible: a specifier probes a fixed list of
 * candidate paths, so an added file can only re-bind specifiers whose list
 * contains it, and that is computable from its path alone. The memo's edges
 * are indexed by the base each specifier probes from; an added file offers the
 * bases it could be probed *as*; an importer in both is re-checked and
 * re-emitted (its emitted specifier can move too — the ES-module rewrite names
 * the file this compile emits).
 *
 * Conservative where priority is subtle: an added `foo.tsx` beside an existing
 * `foo.ts` does not actually win, but it lands in the index and its importer is
 * re-checked anyway. Re-checking one file needlessly is a cost; missing one is
 * a wrong answer.
 *
 * A file's FAILED lookups are the same capture through the package table: the
 * package appearing is what re-binds them, and it arrives under exactly the
 * name the failure was recorded as (`thing package.json` — the base recorded
 * the absence, so the diff reports the appearance under the path the lookup
 * took), so they are indexed verbatim and the added name is looked up verbatim
 * alongside its bases.
 *
 * Alongside the importers, answers which of the added names found ANY claim in
 * the index — what tells an addition the graph accounts for from one it cannot
 * (see the program-level arm in {@link planCompile}).
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
