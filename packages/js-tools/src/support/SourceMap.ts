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

/*
 * Naming the sources in a tool's source maps by the fabr reference that
 * resolves to each (`fabr:./packages/core/src/Fabr.ts`, `fabr:gen:out/x.ts`),
 * an absolute entry that a tool composing maps keeps as it is. The step running
 * a tool stages a table of the source path of each file it staged: a row per
 * file, or per directory (`dir/` → a prefix) whose files are all named
 * `<prefix><path within>`. A source the table lacks keeps the entry the tool
 * wrote for it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { posixRelative } from "./Paths";

/** The file the step stages the table as. */
export const SOURCE_PATHS_FILE = ".fabr-source-paths.json";
/** The flag naming the table on a tool's command line. */
export const SOURCE_PATHS_FLAG = "--source-paths";

/** The file in which a test installation records where it staged each source,
 *  by source path: how a runner finds the source a map entry names. */
export const SOURCE_LOCATIONS_FILE = ".fabr-source-locations.json";

/** The scheme of a map entry fabr writes. */
const FABR_SCHEME = "fabr:";

/** @return true if a map entry is an absolute URL (`fabr:…`, `webpack://…`),
 *  otherwise false. On Windows a one-letter scheme is a drive (`C:\…`), a path. */
export function isAbsoluteEntry(entry: string): boolean {
  return (path.sep === "\\" ? /^[a-zA-Z][a-zA-Z0-9+.-]+:/ : /^[a-zA-Z][a-zA-Z0-9+.-]*:/).test(entry);
}

/** Read the table's rows: a staged file's name to its source path, or a staged
 *  directory's name, ending in `/`, to the prefix of its files' source paths. */
export function readSourcePaths(file: string): ReadonlyMap<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: not a table of source paths`);
  }
  return new Map(
    Object.entries(parsed).map(([name, sourcePath]): [string, string] => {
      if (typeof sourcePath !== "string") {
        throw new Error(`${file}: the source path of '${name}' is not a string`);
      }
      return [name, sourcePath];
    })
  );
}

/**
 * Rewrite `text`, the map at `mapFile`, so every relative `sources` entry is a
 * fabr reference: resolved against the map's directory and `sourceRoot`, and
 * named by `referenceOf` from its path relative to `root`, or left as it is
 * where that gives undefined. An absolute entry is kept. `sourceRoot` is
 * dropped. A map with no `sources` array is returned unchanged.
 */
export function withReferencedSources(
  text: string,
  mapFile: string,
  root: string,
  referenceOf: (staged: string) => string | undefined
): string {
  const map = JSON.parse(text) as { sources?: unknown; sourceRoot?: unknown };
  if (!Array.isArray(map.sources)) {
    return text;
  }
  const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  map.sources = map.sources.map((entry: unknown) => {
    if (typeof entry !== "string" || isAbsoluteEntry(entry)) {
      return entry;
    }
    const staged = posixRelative(root, path.resolve(path.dirname(mapFile), sourceRoot, entry));
    const reference = referenceOf(staged);
    return reference === undefined ? entry : FABR_SCHEME + reference;
  });
  delete map.sourceRoot;
  return JSON.stringify(map);
}

/** How {@link stagedReferences} names what the table does not list. */
export interface IStagedReferenceOptions {
  /** Name a staged path inside a package the table lists files of by that
   *  package's reference and the path within it — a source the package's own
   *  map names but the package does not ship. */
  withinPackages?: boolean;
}

/**
 * Make the function a tool names a staged source with, from the table `argv`
 * names ({@link SOURCE_PATHS_FLAG}, as `--flag value` or `--flag=value`,
 * relative to `root`): by the table's row for the source or for the innermost
 * directory holding it, or else, with `withinPackages`, by a package holding
 * it. The function gives undefined for a source none of these names; the
 * result is undefined where `argv` names no table.
 */
export function stagedReferences(
  argv: string[],
  root: string,
  options: IStagedReferenceOptions = {}
): ((staged: string) => string | undefined) | undefined {
  const named = flagValue(argv, SOURCE_PATHS_FLAG);
  if (named === undefined) {
    return undefined;
  }
  const paths = readSourcePaths(path.resolve(root, named));
  const within = options.withinPackages === true ? packageReferences(paths) : undefined;
  return staged => paths.get(staged) ?? inDirectory(paths, staged) ?? within?.(staged);
}

/** Name a staged path by the row of the innermost directory holding it. */
function inDirectory(paths: ReadonlyMap<string, string>, staged: string): string | undefined {
  for (let at = staged.lastIndexOf("/"); at > 0; at = staged.lastIndexOf("/", at - 1)) {
    const prefix = paths.get(staged.slice(0, at + 1));
    if (prefix !== undefined) {
      return prefix + staged.slice(at + 1);
    }
  }
  return undefined;
}

/**
 * Name a staged path by the package whose files the table lists under a
 * directory containing it: `<package reference>:<path within>`. A package is
 * found by a row whose source path names its file under the package's
 * reference (`../.fabr-tree/<hash>/lib/x.js` → `@npm:pkg:1.0.0:lib/x.js`), so a
 * project file, named by its path, contributes none.
 */
function packageReferences(paths: ReadonlyMap<string, string>): (staged: string) => string | undefined {
  const mounts = new Map<string, string>();
  for (const [staged, sourcePath] of paths) {
    const at = sourcePath.lastIndexOf(":");
    const file = at < 0 ? "" : sourcePath.slice(at + 1);
    if (file !== "" && staged.endsWith(`/${file}`)) {
      const mount = staged.slice(0, staged.length - file.length - 1);
      if (!mounts.has(mount)) {
        mounts.set(mount, sourcePath.slice(0, at));
      }
    }
  }
  return staged => {
    for (let at = staged.lastIndexOf("/"); at > 0; at = staged.lastIndexOf("/", at - 1)) {
      const reference = mounts.get(staged.slice(0, at));
      if (reference !== undefined) {
        return `${reference}:${staged.slice(at + 1)}`;
      }
    }
    return undefined;
  };
}

/** Get the value of `flag` on a command line, as `--flag value` or
 * `--flag=value`. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) {
    return argv[at + 1];
  }
  return argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** Get the reference a fabr map entry names, without its scheme; undefined for
 *  any other entry. */
export function referenceOfEntry(entry: string): string | undefined {
  return entry.startsWith(FABR_SCHEME) ? entry.slice(FABR_SCHEME.length) : undefined;
}

/**
 * Get the source a compiled file's own map (`<compiled>.map`) names first —
 * the file it was compiled from, where fabr's drivers wrote the map — as a
 * fabr reference as written, or a relative entry resolved against the map's
 * `sourceRoot`, absolute. Undefined where there is no readable map or it names
 * no source.
 */
export function getMapSource(compiled: string): string | undefined {
  let map: unknown;
  try {
    map = JSON.parse(fs.readFileSync(`${compiled}.map`, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof map !== "object" || map === null) {
    return undefined;
  }
  const { sources, sourceRoot } = map as { sources?: unknown; sourceRoot?: unknown };
  const first: unknown = Array.isArray(sources) ? sources[0] : undefined;
  if (typeof first !== "string") {
    return undefined;
  }
  return referenceOfEntry(first) !== undefined
    ? first
    : path.resolve(path.dirname(compiled), typeof sourceRoot === "string" ? sourceRoot : "", first);
}
