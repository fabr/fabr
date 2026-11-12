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
 * The names a driver and the step that runs it share for what a run read: the
 * discovered-dependency report, which the step's cache entry is keyed on in
 * place of the whole staged package closure.
 *
 * A read is named by the path the run took to it: the names a chain of
 * dependency requirements calls its packages by, then the file within the last
 * package, in the flat spelling of core's DepsPath ({@link joinDepsPath}). The
 * path's first name is a direct dependency of the compilation, each later name
 * one the package before it declares, so the step replays a read by walking the
 * current package graph, never by resolving. A driver whose answer came from
 * elsewhere (the fallback pool) reports it in these terms itself. The recorded
 * base and the `--changes` lists use the same names.
 *
 * Each package lookup adds two rows: the requirer's route, the name, then
 * `package.json` (the answering package's manifest, or an absent one), which
 * records the requirement's binding where the files' own names, each on its
 * package's one canonical route, cannot; and, for a lookup the requirer's own
 * requirements did not answer, `<name> package.json`, the top-level lookup
 * that decided it, found or not.
 *
 * Runs in the drivers, so it must not depend on @fabr-build/core.
 */

/** Where a driver writes its report, relative to the staged working directory.
 * The action collects it with the output (`NodeExecAction`'s `collectedWith`). */
export const DEPS_REPORT_FILE = ".fabr-deps.json";

/** The flag asking a driver for a report: `--deps-report <file>`. A driver not
 * given it reports nothing, and its entry is keyed on the whole deps input. */
export const DEPS_REPORT_FLAG = "--deps-report";

/**
 * @return the flat spelling of a dependency path (core's `DepsPath`): its parts
 * (package names, then the file) each `encodeURI`-encoded, joined with single
 * spaces. Convert between parts and the flat string only through this pair: a
 * raw join cannot tell a space in a file's name from the separator.
 *
 * Mirrors core's Manifest.ts `joinDepsPath`/`splitDepsPath`; keep the two in
 * sync by hand.
 */
export function joinDepsPath(parts: ReadonlyArray<string>): string {
  return parts.map(part => encodeURI(part)).join(" ");
}

/** @return the parts of a flat dependency path, the inverse of
 * {@link joinDepsPath}. A part with no `%` is taken as it is. */
export function splitDepsPath(name: string): string[] {
  return name.split(" ").map(part => (part.includes("%") ? decodeURI(part) : part));
}

/**
 * The flags asking a driver to build incrementally. `--state-dir <dir>` names a
 * directory whose contents the driver owns: the step stages the last green
 * build's state back into it and keeps whatever is there when the run ends.
 * A driver given it plans the build itself and is responsible for removing
 * stale output.
 *
 * `--changes <file>` names the changes document ({@link parseChangesDocument})
 * listing what moved since the last green build. The flag is always given with
 * `--state-dir`, but the file may be missing: read a missing file as "no base",
 * and compile cold. An empty state directory with a changes file (a first
 * build, or lost state) also compiles cold. A driver given neither flag runs
 * as the tool's own CLI does.
 */
export const STATE_DIR_FLAG = "--state-dir";
export const CHANGES_FLAG = "--changes";

/** The locations fabr's own rules pass with {@link STATE_DIR_FLAG} and
 * {@link CHANGES_FLAG}, relative to the staged working directory. A rule may
 * pass others. */
export const STATE_DIR = ".fabr-state";
export const CHANGES_FILE = ".fabr-changes";

/**
 * What moved since the base build, by content hash: the names whose content
 * differs (additions included) and the names that are gone. A dependency's file
 * is named by its path name, the compile's own by its staged path.
 */
export interface IChangeLists {
  changed: string[];
  deleted: string[];
}

/** Read a changes document (core's `toChangesDocument`: one `<status>\t<name>`
 * line per name, `A`/`M`/`D`), folding an addition into `changed`. Throws on a
 * malformed line. */
export function parseChangesDocument(text: string): IChangeLists {
  const lists: IChangeLists = { changed: [], deleted: [] };
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const tab = line.indexOf("\t");
    const status = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (tab < 0 || name === "" || !["A", "M", "D"].includes(status)) {
      throw new Error(`malformed changes line ${JSON.stringify(line)}`);
    }
    (status === "D" ? lists.deleted : lists.changed).push(name);
  }
  return lists;
}

/**
 * One package lookup a run made: the requirer's instance name (`""` for the
 * compilation itself), the name it asked for, and the instance name the name
 * bound to.
 *
 * `via` says how it resolved: `own` (the requirer declared the name),
 * `fallback` (it did not, and the fallback pool answered), or `absent`
 * (nothing answered, and `to` is empty). An absent lookup need not be an
 * error: tsc asks for `thing` and settles for `@types/thing`.
 */
export interface IResolutionEdge {
  from: string;
  name: string;
  to: string;
  via: "own" | "fallback" | "absent";
}

/**
 * A run report as the step reads it: the path names of the files the run read,
 * and the lookups it made ({@link IResolutionEdge}). Other sections of the
 * document are ignored.
 */
export interface IRunReport {
  reads: string[];
  edges: IResolutionEdge[];
}

/** Convert a run report document, throwing where `reads` or `edges` is malformed. */
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

/** Convert the `edges` section; absent, as from a driver that looks up no
 * package itself, it is an empty list. */
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

/**
 * @return the text of a run report: the names read (deduplicated and sorted),
 * the lookups (sorted by requirer and name), and any further `sections` the
 * driver adds.
 */
export function serializeRunReport(
  reads: Iterable<string>,
  edges: ReadonlyArray<IResolutionEdge>,
  sections: Record<string, unknown> = {}
): string {
  return `${JSON.stringify({ reads: [...new Set(reads)].sort(), edges: [...edges].sort(compareEdges), ...sections }, undefined, 2)}\n`;
}

/** Compare two edges by requirer then name, in code-unit order (core's
 * `compareText`). */
function compareEdges(left: IResolutionEdge, right: IResolutionEdge): number {
  const l = `${left.from}\0${left.name}`;
  const r = `${right.from}\0${right.name}`;
  return l < r ? -1 : l > r ? 1 : 0;
}
