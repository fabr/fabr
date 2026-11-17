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
 * The coverage driver, in two modes, each given an options document
 * ({@link ICoverageOptions}):
 *
 * - `prepare` writes the module a measured run's test processes load first,
 *   which records each process's coverage of the measured files
 *   (`Collect.ts`), and the table naming each measured file it records.
 * - `convert` turns what the processes recorded into one lcov document over
 *   the sources of the compiled files it is given. Each compiled file is
 *   parsed (acorn) and handed with its V8 counts, summed over every process,
 *   and its source map to `ast-v8-to-istanbul`, which takes istanbul's
 *   statements, functions and branches from the parse and their counts from
 *   V8, and maps them to the original sources. No original source is read. A
 *   measured file no process loaded is converted as a single range run zero
 *   times, so its code is reported as not run.
 *
 * Usage: node coverage-driver.js --manifest=<options document>
 *
 * Its libraries come from its own install and are loaded in {@link convert},
 * so the exported helpers can be imported without them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseManifestPath } from "../support/Main";
import { physicalPaths } from "./Collect";
import type { ICoverageConvertOptions, ICoverageOptions, ICoveragePrepareOptions } from "./Options";
import { ICoverageRecord, IFileCoverageData, lcovOf, mergeRecord, recordOf, sourceOf } from "./Lcov";

/* As much of V8's coverage format as the driver reads. */
interface IRangeCoverage {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface IFunctionCoverage {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: IRangeCoverage[];
}
interface IScriptCoverage {
  url: string;
  functions: IFunctionCoverage[];
}

/** An ESTree node, as far as the driver adjusts one. */
interface INode {
  type: string;
  start: number;
  static?: boolean;
  key?: INode;
  loc?: { start: unknown };
}

/* As much of each library as the driver uses, typed locally. */
interface IAcorn {
  parse(code: string, options: Record<string, unknown>): INode;
}
interface IV8Coverage {
  mergeProcessCovs(processes: Array<{ result: IScriptCoverage[] }>): { result: IScriptCoverage[] };
}
type Convert = (options: {
  code: string;
  ast: INode;
  coverage: IScriptCoverage;
  sourceMap: unknown;
  ignoreNode?: (node: INode, type: "function" | "statement" | "branch") => boolean | void;
}) => Promise<Record<string, IFileCoverageData>>;

/* A real `import()`: compiled as CommonJS, the keyword would become `require`,
 * which cannot load an ES module. */
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

/**
 * Move each static class member's start to its key. V8's range for a static
 * method begins at its name, after `static`; a node starting at `static` would
 * take its count from the class's range instead of its own.
 */
export function startStaticMembersAtKey(node: unknown): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(startStaticMembersAtKey);
    return;
  }
  const at = node as INode;
  if ((at.type === "MethodDefinition" || at.type === "PropertyDefinition") && at.static && at.key !== undefined) {
    at.start = at.key.start;
    if (at.loc !== undefined && at.key.loc !== undefined) {
      at.loc = { ...at.loc, start: at.key.loc.start };
    }
  }
  for (const [key, value] of Object.entries(at)) {
    if (key !== "loc" && key !== "key") {
      startStaticMembersAtKey(value);
    }
  }
}

/** @return true if `node` is a branch V8 cannot count — a parameter's default,
 * evaluated with no counter of its own — otherwise false. */
function uncountableBranch(node: INode, type: string): boolean {
  return type === "branch" && node.type === "AssignmentPattern";
}

/** Read the source map a compiled file names in its `sourceMappingURL`
 * comment (inline as a `data:` URL, or a file beside it), with the directory
 * its entries are relative to; undefined where it names none or the file is
 * missing. */
function sourceMapOf(file: string, code: string): { map: unknown; dir: string } | undefined {
  const comment = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(code);
  if (comment === null) {
    return undefined;
  }
  const url = comment[1];
  if (url.startsWith("data:")) {
    const base64 = url.slice(url.indexOf(",") + 1);
    return { map: JSON.parse(Buffer.from(base64, "base64").toString("utf8")), dir: path.dirname(file) };
  }
  const mapFile = path.resolve(path.dirname(file), decodeURIComponent(url));
  return fs.existsSync(mapFile) ? { map: JSON.parse(fs.readFileSync(mapFile, "utf8")), dir: path.dirname(mapFile) } : undefined;
}

/** Parse `code` as a script, or as a module where that fails. */
function parse(acorn: IAcorn, code: string): INode {
  const options = { ecmaVersion: "latest", locations: true, allowHashBang: true };
  try {
    return acorn.parse(code, { ...options, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ...options, sourceType: "module" });
  }
}

/** Run the driver in the mode its options document (`--manifest=<path>`) names. */
export async function main(argv: string[]): Promise<void> {
  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv, "coverage-driver"), "utf8")) as ICoverageOptions;
  if (options.kind === "prepare") {
    prepare(options);
  } else {
    await convert(options);
  }
}

/** Write the preload module and the table of measured files that `options` names. */
function prepare(options: ICoveragePrepareOptions): void {
  const physical = physicalPaths();
  const names = new Map<string, string>();
  for (const name of [...options.measured].sort().reverse()) {
    names.set(physical(path.resolve(name)), name);
  }
  const table = path.resolve(options.table);
  fs.writeFileSync(table, JSON.stringify(Object.fromEntries([...names].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))));
  fs.writeFileSync(
    path.resolve(options.preload),
    `require(${JSON.stringify(path.join(__dirname, "Collect.js"))}).collectCoverage(${JSON.stringify(table)}, __filename);\n`
  );
}

/** @return every coverage document under `directories`, at any depth, each read for the scripts of `measured` alone. */
function recordedCoverage(directories: string[], measured: ReadonlySet<string>): Array<{ result: IScriptCoverage[] }> {
  return directories
    .filter(directory => fs.existsSync(directory))
    .flatMap(directory =>
      (fs.readdirSync(directory, { recursive: true }) as string[])
        .filter(name => name.endsWith(".json"))
        .sort()
        .map(name => path.join(directory, name))
    )
    .map(file => {
      const { result } = JSON.parse(fs.readFileSync(file, "utf8")) as { result: IScriptCoverage[] };
      return { result: result.filter(script => measured.has(script.url)) };
    });
}

/**
 * Convert what the run's processes recorded under `options.raw` into one lcov
 * document over the sources of `options.measured`, written to its `output`. A
 * measured file with no source map is left out. The records of one source
 * from several compiled files are summed.
 */
async function convert(options: ICoverageConvertOptions): Promise<void> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const acorn = require("acorn") as IAcorn;
  const { mergeProcessCovs } = require("@bcoe/v8-coverage") as IV8Coverage;
  /* eslint-enable @typescript-eslint/no-var-requires */
  const convertScript = ((await importModule(pathToFileURL(require.resolve("ast-v8-to-istanbul")).href)) as { default: Convert })
    .default;

  const measured = new Set(options.measured);
  /* Sum the counts of a script every process loaded before converting anything. */
  const merged = mergeProcessCovs(recordedCoverage(options.raw.map(directory => path.resolve(directory)), measured));
  const byName = new Map(merged.result.map(script => [script.url, script]));

  const physical = physicalPaths();
  const records = new Map<string, ICoverageRecord>();
  for (const name of [...measured].sort()) {
    const file = physical(path.resolve(name));
    const code = fs.readFileSync(file, "utf8");
    const sourceMap = sourceMapOf(file, code);
    if (sourceMap === undefined) {
      continue;
    }
    const ast = parse(acorn, code);
    startStaticMembersAtKey(ast);
    const coverage = {
      url: pathToFileURL(file).href,
      functions: byName.get(name)?.functions ?? [
        { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }] },
      ],
    };
    const converted = await convertScript({ code, ast, coverage, sourceMap: sourceMap.map, ignoreNode: uncountableBranch });
    for (const data of Object.values(converted)) {
      const record = recordOf(sourceOf(data.path, sourceMap.dir), data);
      const held = records.get(record.source);
      if (held === undefined) {
        records.set(record.source, record);
      } else {
        mergeRecord(held, record);
      }
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
  fs.writeFileSync(path.resolve(options.output), lcovOf(records.values()));
}
