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
 * How a tool's source maps name the sources they map: by the fabr reference
 * that resolves to each (`fabr:./packages/core/src/Fabr.ts`, `fabr:gen:out/x.ts`),
 * an absolute entry no composing tool re-resolves. The step running a tool
 * stages a table of the source path of each file it staged; the tool names a
 * source the table lacks by its declared owner and its name there.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where the step stages the table, and the flags that name it and the owner
 *  on a tool's command line. */
export const SOURCE_PATHS_FILE = ".fabr-source-paths.json";
export const SOURCE_PATHS_FLAG = "--source-paths";
export const SOURCE_OWNER_FLAG = "--source-owner";

/** Where a test installation stages the location of each source it holds, by
 *  its source path: what a runner opens a source a map entry names by. */
export const SOURCE_LOCATIONS_FILE = ".fabr-source-locations.json";

/** The scheme of a map entry fabr writes. */
const FABR_SCHEME = "fabr:";

/** Whether a map entry is an absolute URL (`fabr:…`, `webpack://…`), which a
 *  tool composing maps leaves as it is. */
function isAbsoluteEntry(entry: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entry);
}

/** The table of the source path of each staged file, by its staged name. */
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
 * The text of the map at `mapFile` with every relative `sources` entry
 * named as a fabr reference: resolved against the map, and named by
 * `referenceOf` from its path relative to `root` — or left as it is where
 * that names nothing. An absolute entry is kept, and `sourceRoot` is dropped,
 * every relative entry having been resolved through it.
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
    const staged = path.relative(root, path.resolve(path.dirname(mapFile), sourceRoot, entry)).split(path.sep).join("/");
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
 * How a tool names a source it staged, from the table a step staged and named
 * on its command line ({@link SOURCE_PATHS_FLAG}, written `--flag value` or
 * `--flag=value`): by the table's source path, or failing one (and, with
 * `withinPackages`, failing a package containing it), by the declared owner
 * ({@link SOURCE_OWNER_FLAG}) and the name `ownName` gives it there (the staged
 * path under the tool's own sources; undefined for a file not among them), or
 * the one a caller gives. Undefined where no table was staged.
 */
export function stagedReferences(
  argv: string[],
  root: string,
  ownName: (staged: string) => string | undefined,
  options: IStagedReferenceOptions = {}
): ((staged: string, own?: string) => string | undefined) | undefined {
  const named = flagValue(argv, SOURCE_PATHS_FLAG);
  if (named === undefined) {
    return undefined;
  }
  const paths = readSourcePaths(path.resolve(root, named));
  const owner = flagValue(argv, SOURCE_OWNER_FLAG);
  const within = options.withinPackages === true ? packageReferences(paths) : undefined;
  /* `own`, where given, is the owner's name for the file instead. */
  return (staged, own = ownName(staged)) => {
    const sourcePath = paths.get(staged) ?? within?.(staged);
    if (sourcePath !== undefined) {
      return sourcePath;
    }
    return owner === undefined || own === undefined ? undefined : `${owner}:${own}`;
  };
}

/**
 * Name a staged path by the package whose files the table lists under a
 * directory containing it: `<package reference>:<path within>`. A package is
 * found by a row whose source path names its file under the package's
 * reference (`.fabr-tree/<hash>/lib/x.js` → `@npm:pkg:1.0.0:lib/x.js`), so a
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

/** The value of `flag` on a command line, as `--flag value` or `--flag=value`. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) {
    return argv[at + 1];
  }
  return argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** The reference a fabr map entry names, without its scheme; undefined for any
 *  other entry. */
export function referenceOfEntry(entry: string): string | undefined {
  return entry.startsWith(FABR_SCHEME) ? entry.slice(FABR_SCHEME.length) : undefined;
}
