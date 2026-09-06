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
 * The vocabulary a driver and the step that runs it share for **what the run
 * read** — the discovered-dependency report (see DESIGN-discovered-deps.md).
 *
 * A tool handed a package closure reads a small subset of it, so the step's
 * cache entry is keyed on that subset rather than on everything staged. Which
 * means the two sides must agree on exactly one thing: the **names** the subset
 * is spelled in. A read is named by the **path the run took to it** — the
 * names an edge chain calls its packages by, then the file within the last,
 * in the flat spelling ({@link joinDepsPath}) of core's DepsPath. The reads
 * ARE the paths; the step splits them and nothing else (no translation, no
 * join), and replay re-resolves each against the current delivery. The same
 * names are the incremental namespace: the recorded base and the `--changes`
 * lists arrive in them, so a driver reads its own vocabulary back.
 *
 * Two rows state a lookup wherever one cannot: every resolution contributes
 * its access path ending at the answering package's manifest (pinning that
 * edge's binding, since a shared instance's files ride ONE canonical route),
 * and a fallback resolution adds the pool's answer pinned at the winning
 * instance's own canonical route. Every path indexes PLAINLY through the
 * delivered graph — head a direct member, hops the requirer's own edges — so
 * replay is a walk, never a resolution; whatever ecosystem rule produced an
 * answer (the pool) is the reporter's to convert.
 *
 * This module is shared with the driver, which runs in the build's own process
 * and must not depend on @fabr-build/core: it holds names and a converter, and
 * nothing else.
 */

/** Where a driver writes its report, relative to the staged working directory
 * (the step reads it back from there). Not collected as output — the compile
 * collects its `build` tree alone. */
export const DEPS_REPORT_FILE = ".fabr-deps.json";

/** How a step asks for one: `--deps-report <file>`. A driver given no such flag
 * reports nothing and is keyed as it always was. */
export const DEPS_REPORT_FLAG = "--deps-report";

/**
 * The FLAT spelling of a dependency path (core's `DepsPath`): its parts — the
 * names an edge chain calls its packages by, then the file within the last —
 * each `encodeURI`-encoded, joined with single spaces. Every conversion
 * between parts and the flat string goes through this pair: a raw join would
 * make a space inside a file's name indistinguishable from the separator.
 *
 * Mirrors core's Manifest.ts `joinDepsPath`/`splitDepsPath` — kept in sync by
 * hand, since this module must not depend on core at runtime.
 */
export function joinDepsPath(parts: ReadonlyArray<string>): string {
  return parts.map(part => encodeURI(part)).join(" ");
}

/** The inverse of {@link joinDepsPath}. `encodeURI` only ever introduces `%`
 * escapes, so a part without one decodes to itself. */
export function splitDepsPath(name: string): string[] {
  return name.split(" ").map(part => (part.includes("%") ? decodeURI(part) : part));
}

/**
 * How a step asks a driver to compile incrementally: `--state-dir <dir>` names
 * a directory the driver owns the contents of — the step stages the last green
 * build's state back into it and keeps whatever is there when the run ends,
 * unread, however many files that is (zero included). Naming the directory IS
 * asking for incremental mode: a driver given one plans for itself and owns the
 * emitted tree's staleness.
 *
 * `--changes <file>` accompanies it and says what moved since the last green
 * build (see {@link toChangeLists}). The FILE is what is conditional, not the
 * flag: a step composes one invocation and only learns whether it has a base to
 * diff against once it has looked, so a driver reads the path and takes its
 * absence as "no base". The two are one-directional: state handed back with no
 * change lists is the step contradicting itself, while an empty state directory
 * beside readable changes is ordinary — a first build, or one whose state was
 * lost — and compiles cold. A driver given neither flag is the ordinary
 * CLI-parity invocation.
 */
export const STATE_DIR_FLAG = "--state-dir";
export const CHANGES_FLAG = "--changes";

/** The locations fabr's own rules pass for those two, relative to the staged
 * working directory. Defaults, not protocol: a rule names what it likes, and
 * these are what {@link STATE_DIR_FLAG}/{@link CHANGES_FLAG} carry. */
export const STATE_DIR = ".fabr-state";
export const CHANGES_FILE = ".fabr-changes.json";

/**
 * What moved since the base build, as the step's hash diff states it: the
 * names whose content differs (additions included) and the names that are
 * gone, both in this module's namespace — a dependency's file by its instance
 * name, the compile's own by its staged path. Bytes are the step's native
 * facts; what a change *reaches* is the driver's business.
 */
export interface IChangeLists {
  changed: string[];
  deleted: string[];
}

/** Read a changes document as what it claims to be. A driver reads this from a
 * file its caller wrote, and the two sides disagreeing about the contract is a
 * bug — so a malformed document is an error, never a silent full compile. */
export function toChangeLists(json: unknown): IChangeLists {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("expected a JSON object");
  }
  const lists = json as { changed?: unknown; deleted?: unknown };
  const names = (value: unknown, what: string): string[] => {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.some(name => typeof name !== "string")) {
      throw new Error(`expected '${what}' to be a list of names`);
    }
    return value as string[];
  };
  return { changed: names(lists.changed, "changed"), deleted: names(lists.deleted, "deleted") };
}

/**
 * One resolution a run performed: the requirer, the name it asked for, and the
 * instance that name bound to — all three in this module's names, with `""`
 * standing for the compilation itself.
 *
 * `via` says how it resolved: `own` (the requirer declared the name),
 * `fallback` (it did not, and the pool answered), or `absent` (nothing
 * answered, and `to` is empty). An unresolvable name is not necessarily an
 * error — tsc asks for `thing` and settles for `@types/thing`.
 */
export interface IResolutionEdge {
  from: string;
  name: string;
  to: string;
  via: "own" | "fallback" | "absent";
}

/**
 * A run report as the step reads it: the pool names the run READ and the
 * resolutions it performed ({@link IResolutionEdge}). A driver's own state is
 * not in here — it is files, written into the `--state-dir`. Anything else in
 * the document is not the step's business.
 */
export interface IRunReport {
  reads: string[];
  edges: IResolutionEdge[];
}

export function toRunReport(json: unknown): IRunReport {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("expected a JSON object");
  }
  const { reads, edges } = json as { reads?: unknown; edges?: unknown };
  if (!Array.isArray(reads) || reads.some(name => typeof name !== "string")) {
    throw new Error("expected 'reads' to be a list of names");
  }
  return { reads: reads as string[], edges: toResolutionEdges(edges) };
}

/** The edges section, absent from a driver that resolves nothing of its own; an
 * empty list leaves every read named by its place in the delivered graph. */
function toResolutionEdges(json: unknown): IResolutionEdge[] {
  if (json === undefined) {
    return [];
  }
  if (!Array.isArray(json)) {
    throw new Error("expected 'edges' to be a list of resolutions");
  }
  return json.map(entry => {
    const { from, name, to, via } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof from !== "string" ||
      typeof name !== "string" ||
      typeof to !== "string" ||
      (via !== "own" && via !== "fallback" && via !== "absent")
    ) {
      throw new Error("expected a resolution of {from, name, to, via: own|fallback|absent}");
    }
    return { from, name, to, via };
  });
}
