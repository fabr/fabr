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
 * Shared support for the CSS driver entry points (sass-driver.ts,
 * postcss-driver.ts). Like the entry points themselves, this runs in the build
 * process and must not depend on @fabr-build/core at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The slice of a source map the drivers read: the source list they rewrite,
 * and the embedded contents kept aligned with it. */
/** Whether a name is a Sass source (the ones the driver compiles; a plain
 * `.css` passes through). */
export function isSassSource(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/**
 * The name a Sass source takes when the *sass step* lowers it: the extension
 * becomes `.css`, the `.module.` marker rides through — the marker means
 * "scope me", and lowering does not scope. Identity on a plain `.css`.
 */
export function sassLoweredName(name: string): string {
  return name.replace(/\.(scss|sass)$/i, ".css");
}

export interface IRawSourceMap {
  sources: string[];
  sourcesContent?: Array<string | null>;
  [member: string]: unknown;
}

/** Write a file, creating parent directories as needed. */
export function writeOut(outdir: string, rel: string, contents: string | Uint8Array): void {
  const dest = path.join(outdir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
}

/** The `sourceMappingURL` comment naming a map that sits beside its
 * stylesheet. */
export function sourceMapComment(mapName: string): string {
  return `\n/*# sourceMappingURL=${path.basename(mapName)} */\n`;
}

/**
 * A relocated map's entries, respelled relative to where the map itself sits —
 * which is how a consumer resolves them, and how this pipeline's next step
 * reads a map it chains through. `mapName` is the map's own target-relative
 * path.
 */
export function relativeToMap(map: IRawSourceMap, mapName: string): IRawSourceMap {
  const home = path.dirname(mapName);
  return {
    ...map,
    sources: map.sources.map(source => (source === "<no source>" ? source : path.relative(home, source) || source)),
  };
}

/** The name a map is annotated under — beside its stylesheet, so the basename
 * is the whole reference. */
export function annotationName(mapName: string): string {
  return path.basename(mapName);
}

/**
 * A stylesheet with every `sourceMappingURL` annotation removed.
 *
 * A step ships only annotations it wrote: an input's annotation names ITS map,
 * which is a different file from the one this step publishes, and a composed
 * stylesheet's rides along with the rules a `composes` inlines.
 */
export function withoutAnnotations(css: string): string {
  return css.replace(/\n?[ \t]*\/\*#[ \t]*sourceMappingURL=[^*]*\*\/[ \t]*/g, "");
}

/** The `--manifest=<path>` argument, the drivers' one piece of argv. */
export function parseManifestPath(argv: string[], driver: string): string {
  const flag = argv.find(arg => arg.startsWith("--manifest="));
  if (!flag) {
    throw new Error(`${driver}: missing --manifest=<path>`);
  }
  return flag.substring("--manifest=".length);
}

/**
 * A source map's `sources`, rewritten from where the files were staged to what
 * the target calls them: anything under the staged source root keeps its
 * root-relative name (which for a chained map is the author's own `.scss`
 * name), anything else its working-root-relative path. No absolute path
 * survives.
 *
 * `ownInput` names the step's own input where it is an intermediate (a chained
 * map — Sass ran before this step): postcss adds an entry for the content it
 * was handed, and left alone that entry would ship the never-shipped lowered
 * name; it is renamed to the stylesheet this step publishes. An unchained
 * run's input IS the source and keeps its own name through the ordinary
 * root-relative branch.
 */
export interface ISourceMapLocation {
  /** The step's working directory, which every path is made relative to. */
  root: string;
  /** Where the stylesheet inputs are staged, stripped from source names. */
  srcRoot: string;
  /** What the map's relative source entries are resolved against — the
   * directory the map sits in, whether it is being written there or was read
   * from there. */
  mapDir: string;
}

export function relocateCssSources(
  map: IRawSourceMap,
  where: ISourceMapLocation,
  ownInput?: { path: string; rename: string }
): IRawSourceMap {
  const { root, srcRoot, mapDir } = where;
  const staged = `${path.resolve(root, srcRoot)}/`;
  const workingRoot = `${path.resolve(root)}/`;
  const own = ownInput === undefined ? undefined : { path: path.resolve(root, srcRoot, ownInput.path), rename: ownInput.rename };
  return {
    ...map,
    sources: map.sources.map(source => {
      /* postcss's placeholder for content it could not attribute (a compose
       * inline parsed with no `from`) — no path to relocate. */
      if (source === "<no source>") {
        return source;
      }
      const absolute = source.startsWith("file://") ? fileURLToPath(source) : path.resolve(root, mapDir, source);
      if (own !== undefined && absolute === own.path) {
        return own.rename;
      }
      if (absolute.startsWith(staged)) {
        return absolute.substring(staged.length);
      }
      return absolute.startsWith(workingRoot) ? absolute.substring(workingRoot.length) : path.basename(absolute);
    }),
  };
}
