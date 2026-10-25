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
 * Coverage as a driver reports it: lcov documents from any number of results,
 * merged by source and line.
 */

import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { SourceRef } from "../core/Repository";
import { COVERAGE_REPORT_FILENAME } from "./TestResult";

/** One source's coverage. */
export interface ICoverageRecord {
  /** The source, as its lcov `SF:` names it. */
  source: string;
  /** Each executable line's count. */
  lines: Map<number, number>;
  /** Each function's count, by its line and name. */
  functions: Map<string, { line: number; name: string; count: number }>;
  /** Each branch arm's count, by `<line>,<block>,<arm>`; undefined where the
   * documents merged into the record numbered its branches differently. */
  branches: Map<string, number> | undefined;
}

/** Merged coverage, by source. */
export type Coverage = Map<string, ICoverageRecord>;

/** Read a count as lcov writes one: `-` is a branch whose block never ran. */
function countOf(text: string | undefined): number {
  const count = Number(text);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Read an lcov document's records: the source, function, line and branch
 * records of each; anything else (the totals, a test name) is derived or not
 * read.
 */
export function parseLcov(text: string): ICoverageRecord[] {
  const records: ICoverageRecord[] = [];
  let current: ICoverageRecord | undefined;
  const functionLines = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const colon = raw.indexOf(":");
    const tag = colon < 0 ? raw.trim() : raw.slice(0, colon);
    const value = colon < 0 ? "" : raw.slice(colon + 1);
    if (tag === "SF") {
      current = { source: value, lines: new Map(), functions: new Map(), branches: new Map() };
      functionLines.clear();
      records.push(current);
    } else if (current === undefined) {
      continue;
    } else if (tag === "FN") {
      const [line, ...name] = value.split(",");
      functionLines.set(name.join(","), Number(line));
    } else if (tag === "FNDA") {
      const [count, ...rest] = value.split(",");
      const name = rest.join(",");
      const line = functionLines.get(name) ?? 0;
      current.functions.set(`${line} ${name}`, { line, name, count: countOf(count) });
    } else if (tag === "DA") {
      const [line, count] = value.split(",");
      current.lines.set(Number(line), (current.lines.get(Number(line)) ?? 0) + countOf(count));
    } else if (tag === "BRDA") {
      const [line, block, arm, count] = value.split(",");
      current.branches!.set(`${line},${block},${arm}`, countOf(count));
    } else if (tag === "end_of_record") {
      current = undefined;
    }
  }
  return records;
}

/** @return true if two branch tables number the same branches, otherwise false. */
function sameBranches(left: Map<string, number>, right: Map<string, number>): boolean {
  return left.size === right.size && [...left.keys()].every(key => right.has(key));
}

/**
 * Merge each document's records into one coverage, by source: line and
 * function counts sum. Branches are numbered by whatever produced them, so they
 * merge only where every document numbers a source's branches alike; otherwise
 * that source keeps its lines and functions and loses its branch detail.
 */
export function mergeCoverage(documents: Iterable<ICoverageRecord[]>): Coverage {
  const merged: Coverage = new Map();
  for (const records of documents) {
    for (const record of records) {
      const held = merged.get(record.source);
      if (held === undefined) {
        merged.set(record.source, {
          source: record.source,
          lines: new Map(record.lines),
          functions: new Map([...record.functions].map(([key, fn]) => [key, { ...fn }])),
          branches: record.branches && new Map(record.branches),
        });
        continue;
      }
      for (const [line, count] of record.lines) {
        held.lines.set(line, (held.lines.get(line) ?? 0) + count);
      }
      for (const [key, fn] of record.functions) {
        const into = held.functions.get(key);
        if (into === undefined) {
          held.functions.set(key, { ...fn });
        } else {
          into.count += fn.count;
        }
      }
      if (held.branches !== undefined && record.branches !== undefined && sameBranches(held.branches, record.branches)) {
        for (const [key, count] of record.branches) {
          held.branches.set(key, held.branches.get(key)! + count);
        }
      } else {
        held.branches = undefined;
      }
    }
  }
  return merged;
}

/** Write coverage as an lcov document, sources and lines in order. */
export function lcovOf(coverage: Iterable<ICoverageRecord>): string {
  const sorted = [...coverage].sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0));
  return sorted
    .map(record => {
      const out = ["TN:", `SF:${record.source}`];
      const functions = [...record.functions.values()].sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      out.push(...functions.map(fn => `FN:${fn.line},${fn.name}`));
      out.push(`FNF:${functions.length}`, `FNH:${functions.filter(fn => fn.count > 0).length}`);
      out.push(...functions.map(fn => `FNDA:${fn.count},${fn.name}`));
      const lines = [...record.lines].sort(([a], [b]) => a - b);
      out.push(...lines.map(([line, count]) => `DA:${line},${count}`));
      out.push(`LF:${lines.length}`, `LH:${lines.filter(([, count]) => count > 0).length}`);
      const branches = [...(record.branches ?? [])];
      out.push(...branches.map(([key, count]) => `BRDA:${key},${count}`));
      out.push(`BRF:${branches.length}`, `BRH:${branches.filter(([, count]) => count > 0).length}`);
      out.push("end_of_record");
      return out.join("\n");
    })
    .join("\n")
    .concat(sorted.length > 0 ? "\n" : "");
}

/** How much of one kind of thing ran: lines, functions or branches. */
export interface ICoverageTotal {
  covered: number;
  total: number;
}

/** Total the lines, functions and branches of `coverage`. */
export function coverageTotals(coverage: Iterable<ICoverageRecord>): { lines: ICoverageTotal; functions: ICoverageTotal; branches: ICoverageTotal } {
  const lines = { covered: 0, total: 0 };
  const functions = { covered: 0, total: 0 };
  const branches = { covered: 0, total: 0 };
  const add = (into: ICoverageTotal, counts: Iterable<number>): void => {
    for (const count of counts) {
      into.total++;
      into.covered += count > 0 ? 1 : 0;
    }
  };
  for (const record of coverage) {
    add(lines, record.lines.values());
    add(functions, [...record.functions.values()].map(fn => fn.count));
    add(branches, record.branches?.values() ?? []);
  }
  return { lines, functions, branches };
}

/**
 * Get the lcov document a measured test target delivered beside its report, or
 * undefined where it delivered none.
 */
export function getCoverageReport(sources: SourceRef[]): Computable<string | undefined> {
  const sets = sources.filter((source): source is FileSet => source instanceof FileSet);
  return Computable.forAll(
    sets.map(set => set.get(COVERAGE_REPORT_FILENAME)),
    (...files): Computable<string | undefined> | undefined => {
      const file = files.find(f => f !== undefined);
      return file && file.getBuffer().then(buffer => buffer.toString("utf8"));
    }
  );
}
