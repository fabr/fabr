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

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { isJsonObject } from "@fabr-build/core";

/** The compiler options of a tsconfig that say what its sources import. */
export interface TsconfigOptions {
  /** The `@types` packages, by the names `types` lists, that are included
   * without an import; undefined where `types` is not set, and every visible
   * `@types` package is. */
  readonly types?: ReadonlyArray<string>;
  /** `baseUrl`, absolute, where it is set. */
  readonly baseUrl?: string;
  /** `paths`: each pattern, with its targets, absolute. */
  readonly paths: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** Read the tsconfig in `file` with the options it inherits through relative
 * `extends`; undefined where it cannot be read. An `extends` naming a package is
 * not followed. */
export function readTsconfig(file: string, seen = new Set<string>()): TsconfigOptions | undefined {
  if (seen.has(file) || !fs.existsSync(file)) {
    return undefined;
  }
  seen.add(file);
  /* tsconfig is JSON with comments and trailing commas, read as tsc reads it. */
  const { config: doc, error } = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, "utf8"));
  if (error !== undefined || !isJsonObject(doc)) {
    return undefined;
  }
  const dir = path.dirname(file);
  const parents = (Array.isArray(doc.extends) ? doc.extends : [doc.extends])
    .filter((each): each is string => typeof each === "string" && each.startsWith("."))
    .map(each => readTsconfig(path.resolve(dir, each.endsWith(".json") ? each : `${each}.json`), seen))
    .filter((each): each is TsconfigOptions => each !== undefined);
  const inherited = parents.reduce<TsconfigOptions>((held, parent) => ({ ...held, ...parent }), { paths: new Map() });
  const options = isJsonObject(doc.compilerOptions) ? doc.compilerOptions : {};
  const baseUrl = typeof options.baseUrl === "string" ? path.resolve(dir, options.baseUrl) : inherited.baseUrl;
  const types = Array.isArray(options.types) ? options.types.filter((each): each is string => typeof each === "string") : inherited.types;
  let paths = inherited.paths;
  if (isJsonObject(options.paths)) {
    /* Targets are relative to baseUrl where it is set, else to this file. */
    const base = baseUrl ?? dir;
    paths = new Map(
      Object.entries(options.paths).map(([pattern, targets]): [string, string[]] => [
        pattern,
        (Array.isArray(targets) ? targets : []).filter((each): each is string => typeof each === "string").map(each => path.resolve(base, each)),
      ])
    );
  }
  return { ...(types === undefined ? {} : { types }), ...(baseUrl === undefined ? {} : { baseUrl }), paths };
}

/** Read every `tsconfig*.json` in `dir` (absolute), by file name. */
export function readTsconfigs(dir: string): Map<string, TsconfigOptions> {
  const read = new Map<string, TsconfigOptions>();
  for (const name of fs.readdirSync(dir).filter(each => /^tsconfig(\..+)?\.json$/.test(each)).sort()) {
    const options = readTsconfig(path.join(dir, name));
    if (options !== undefined) {
      read.set(name, options);
    }
  }
  return read;
}

const LOCAL_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** @return true if `file` names a file or directory outside every `node_modules`, with one of the extensions a module is found by. */
function isLocalModule(file: string): boolean {
  return !file.split(path.sep).includes("node_modules") && LOCAL_EXTENSIONS.some(ext => fs.existsSync(`${file}${ext}`));
}

/** @return true if `specifier` imports one of the project's own files through
 * `options`' `baseUrl` or `paths`, otherwise false. */
export function importsLocalFile(specifier: string, options: TsconfigOptions): boolean {
  for (const [pattern, targets] of options.paths) {
    const star = pattern.indexOf("*");
    const prefix = star < 0 ? pattern : pattern.slice(0, star);
    const suffix = star < 0 ? "" : pattern.slice(star + 1);
    const matches = star < 0 ? specifier === pattern : specifier.startsWith(prefix) && specifier.endsWith(suffix);
    if (matches) {
      const captured = star < 0 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length);
      if (targets.some(target => isLocalModule(target.replace("*", captured)))) {
        return true;
      }
    }
  }
  return options.baseUrl !== undefined && isLocalModule(path.join(options.baseUrl, specifier));
}
