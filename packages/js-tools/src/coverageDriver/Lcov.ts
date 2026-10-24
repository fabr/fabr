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
 * The coverage driver's pure half: istanbul's file coverage as the converter
 * yields it, turned into lcov records named by source reference.
 */

/** A position in a source, as istanbul spells one (1-based line, 0-based column). */
interface IPosition {
  line: number;
  column: number;
}

interface IRange {
  start: IPosition;
  end: IPosition;
}

/** As much of istanbul's per-file coverage data as lcov reads. */
export interface IFileCoverageData {
  path: string;
  statementMap: Record<string, IRange>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; decl?: IRange; loc: IRange }>;
  f: Record<string, number>;
  branchMap: Record<string, { loc: IRange; locations: IRange[] }>;
  b: Record<string, number[]>;
}

/** One source's coverage, in lcov's terms. */
export interface ICoverageRecord {
  /** The source, as the fabr reference naming it without the `fabr:` scheme
   * (`./src/a.ts`), or as the map names it where that is no fabr reference. */
  source: string;
  /** Each function's count, by name and the line it starts on. */
  functions: Array<{ name: string; line: number; count: number }>;
  /** Each executable line's count. */
  lines: Map<number, number>;
  /** Each branch arm's count, by its line, its branch's index and its own. */
  branches: Array<{ line: number; block: number; arm: number; count: number }>;
}

const FABR_SCHEME = "fabr:";

/**
 * Get the source a converted file's path names. A source-map entry is resolved
 * against the map's directory, so a `fabr:` reference comes back joined onto it
 * (`/install/build/fabr:./src/a.ts`); `mapDir` is that directory.
 */
export function sourceOf(convertedPath: string, mapDir: string): string {
  const prefix = mapDir.endsWith("/") ? mapDir : `${mapDir}/`;
  const entry = convertedPath.startsWith(prefix) ? convertedPath.slice(prefix.length) : convertedPath;
  return entry.startsWith(FABR_SCHEME) ? entry.slice(FABR_SCHEME.length) : entry;
}

/**
 * Get one file's coverage as an lcov record of `source`. A line's count is the
 * highest of the statements starting on it, as istanbul counts lines.
 */
export function recordOf(source: string, data: IFileCoverageData): ICoverageRecord {
  const lines = new Map<number, number>();
  for (const [key, range] of Object.entries(data.statementMap)) {
    const count = data.s[key] ?? 0;
    const held = lines.get(range.start.line);
    if (held === undefined || held < count) {
      lines.set(range.start.line, count);
    }
  }
  const functions = Object.entries(data.fnMap).map(([key, fn]) => ({
    name: fn.name,
    line: (fn.decl ?? fn.loc).start.line,
    count: data.f[key] ?? 0,
  }));
  const branches = Object.entries(data.branchMap).flatMap(([key, branch], block) =>
    branch.locations.map((_, arm) => ({ line: branch.loc.start.line, block, arm, count: data.b[key]?.[arm] ?? 0 }))
  );
  return { source, functions, lines, branches };
}

/** Add `other`'s counts into `into`, which records the same source. */
export function mergeRecord(into: ICoverageRecord, other: ICoverageRecord): void {
  for (const [line, count] of other.lines) {
    into.lines.set(line, (into.lines.get(line) ?? 0) + count);
  }
  const fns = new Map(into.functions.map(fn => [`${fn.line} ${fn.name}`, fn]));
  for (const fn of other.functions) {
    const held = fns.get(`${fn.line} ${fn.name}`);
    if (held === undefined) {
      into.functions.push({ ...fn });
    } else {
      held.count += fn.count;
    }
  }
  const arms = new Map(into.branches.map(arm => [`${arm.line} ${arm.block} ${arm.arm}`, arm]));
  for (const arm of other.branches) {
    const held = arms.get(`${arm.line} ${arm.block} ${arm.arm}`);
    if (held === undefined) {
      into.branches.push({ ...arm });
    } else {
      held.count += arm.count;
    }
  }
}

/** Write records as an lcov document, sources and lines in order. */
export function lcovOf(records: Iterable<ICoverageRecord>): string {
  const sorted = [...records].sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0));
  return sorted
    .map(record => {
      const out = ["TN:", `SF:${record.source}`];
      const functions = [...record.functions].sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const fn of functions) {
        out.push(`FN:${fn.line},${fn.name}`);
      }
      out.push(`FNF:${functions.length}`, `FNH:${functions.filter(fn => fn.count > 0).length}`);
      for (const fn of functions) {
        out.push(`FNDA:${fn.count},${fn.name}`);
      }
      const lines = [...record.lines].sort(([a], [b]) => a - b);
      for (const [line, count] of lines) {
        out.push(`DA:${line},${count}`);
      }
      out.push(`LF:${lines.length}`, `LH:${lines.filter(([, count]) => count > 0).length}`);
      for (const arm of record.branches) {
        out.push(`BRDA:${arm.line},${arm.block},${arm.arm},${arm.count}`);
      }
      out.push(`BRF:${record.branches.length}`, `BRH:${record.branches.filter(arm => arm.count > 0).length}`);
      out.push("end_of_record");
      return out.join("\n");
    })
    .join("\n")
    .concat(sorted.length > 0 ? "\n" : "");
}
