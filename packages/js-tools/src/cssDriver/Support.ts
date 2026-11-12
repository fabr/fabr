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
 * Shared support for the css drivers (sass-driver.ts, postcss-driver.ts). Runs
 * in the drivers' processes: do not depend on @fabr-build/core at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEPS_REPORT_FLAG, IResolutionEdge, serializeRunReport } from "../pnp/ReadSet";
import { resolveVirtual } from "../pnp/VirtualPath";
import { toJsonObject } from "../support/Json";

/** @return true if a name is a Sass source (one the driver compiles; a plain
 * `.css` passes through), otherwise false. */
export function isSassSource(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/**
 * @return the name a Sass source takes when the sass step lowers it: the
 * extension becomes `.css`, and a `.module.` marker is kept for the postcss
 * step, which scopes. A plain `.css` name is returned as it is.
 */
export function sassLoweredName(name: string): string {
  return name.replace(/\.(scss|sass)$/i, ".css");
}

/** The slice of a source map the drivers read: the source list they rewrite,
 * and the embedded contents kept aligned with it. */
export interface IRawSourceMap {
  sources: string[];
  sourcesContent?: Array<string | null>;
  [member: string]: unknown;
}

/** Convert a parsed source map to the slice the drivers read. */
export function toRawSourceMap(json: unknown): IRawSourceMap {
  const map = toJsonObject(json);
  const { sources, sourcesContent } = map;
  if (!Array.isArray(sources) || sources.some(source => typeof source !== "string")) {
    throw new Error("'sources' is not a list of strings");
  }
  if (
    sourcesContent !== undefined &&
    (!Array.isArray(sourcesContent) || sourcesContent.some(content => content !== null && typeof content !== "string"))
  ) {
    throw new Error("'sourcesContent' is not a list of strings");
  }
  return {
    ...map,
    sources: sources as string[],
    ...(sourcesContent === undefined ? {} : { sourcesContent: sourcesContent as Array<string | null> }),
  };
}

/** Write a file, creating parent directories as needed. */
export function writeOut(outdir: string, rel: string, contents: string | Uint8Array): void {
  const dest = path.join(outdir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
}

/** @return the `sourceMappingURL` comment naming a map that sits beside its
 * stylesheet. */
export function sourceMapComment(mapName: string): string {
  return `\n/*# sourceMappingURL=${path.basename(mapName)} */\n`;
}

/**
 * @return a relocated map with its entries made relative to the directory the
 * map sits in, `mapName` being the map's own target-relative path. A
 * `<no source>` entry is left as it is.
 */
export function relativeToMap(map: IRawSourceMap, mapName: string): IRawSourceMap {
  const home = path.dirname(mapName);
  return {
    ...map,
    sources: map.sources.map(source => (source === "<no source>" ? source : path.relative(home, source) || source)),
  };
}

/** @return the name a map is annotated under: its basename, since it sits
 * beside its stylesheet. */
export function annotationName(mapName: string): string {
  return path.basename(mapName);
}

/**
 * @return a stylesheet with every `sourceMappingURL` annotation removed. Apply
 * it to every input: an input's annotation names the input's own map, and a
 * composed stylesheet's arrives with the rules a `composes` inlines.
 */
export function withoutAnnotations(css: string): string {
  return css.replace(/\n?[ \t]*\/\*#[ \t]*sourceMappingURL=[^*]*\*\/[ \t]*/g, "");
}

/**
 * Write the deps report (the files the run read of the packages it was given,
 * and the resolution edges it took) where `argv` asks for one
 * (`--deps-report <file>`, relative to the working dir); nothing where it does
 * not. Throws where the flag has no value.
 */
export function writeDepsReport(argv: string[], reads: Iterable<string>, edges: ReadonlyArray<IResolutionEdge> = []): void {
  const at = argv.indexOf(DEPS_REPORT_FLAG);
  if (at < 0) {
    return;
  }
  const file = argv[at + 1];
  if (file === undefined) {
    throw new Error(`${DEPS_REPORT_FLAG} needs a value`);
  }
  fs.writeFileSync(path.resolve(file), serializeRunReport(reads, edges));
}

/** Where a css step's map and its inputs sit, for reading the map's entries. */
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

/**
 * The scheme a fabr reference is carried under in an input map handed to
 * postcss (`fabr-reference://<encoded reference>`). postcss composes the map
 * through `source-map-js`, which counts only `scheme://…` as absolute and
 * would join `fabr:./src/a.scss` onto the input map's directory.
 * {@link referencedCssSources} restores the reference, so the scheme never
 * appears in a map the step ships.
 */
const CARRIED_REFERENCE = "fabr-reference://";

/** @return an input map to hand postcss as `map.prev`, its fabr references
 * carried under {@link CARRIED_REFERENCE} so that postcss leaves them as they
 * are. */
export function carriedReferences(map: IRawSourceMap): IRawSourceMap {
  return {
    ...map,
    sources: map.sources.map(source =>
      source.startsWith("fabr:") ? `${CARRIED_REFERENCE}${encodeURIComponent(source.slice("fabr:".length))}` : source
    ),
  };
}

/**
 * @return a css step's map with each source named by its fabr reference where
 * it has one, otherwise as {@link relocateCssSources} names it relative to the
 * map at `mapName`:
 * - a `fabr:` entry is kept;
 * - an entry {@link carriedReferences} carried is restored to its `fabr:` form;
 * - a staged file (a `file://` URL, or a path relative to `where.mapDir`) is
 *   named `fabr:<referenceOf(staged)>` where `referenceOf` answers, `staged`
 *   being its path relative to `where.root`, a virtual path resolved to the
 *   physical one first.
 */
export function referencedCssSources(
  map: IRawSourceMap,
  mapName: string,
  where: ISourceMapLocation,
  referenceOf: (staged: string) => string | undefined,
  ownInput?: { path: string; rename: string }
): IRawSourceMap {
  const { root, mapDir } = where;
  const relocated = relativeToMap(relocateCssSources(map, where, ownInput), mapName).sources;
  return {
    ...map,
    sources: map.sources.map((source, at) => {
      if (source.startsWith("fabr:")) {
        return source;
      }
      /* An input map's reference, as carriedReferences carried it. */
      if (source.startsWith(CARRIED_REFERENCE)) {
        return `fabr:${decodeURIComponent(source.slice(CARRIED_REFERENCE.length))}`;
      }
      if (source === "<no source>") {
        return relocated[at];
      }
      const absolute = source.startsWith("file://") ? fileURLToPath(source) : path.resolve(root, mapDir, source);
      const staged = toPosix(path.relative(root, resolveVirtual(absolute)));
      const reference = referenceOf(staged);
      return reference === undefined ? relocated[at] : `fabr:${reference}`;
    }),
  };
}

/**
 * @return how a map entry is identified wherever the map is read: an absolute
 * URL other than a file's (a fabr reference, carried or not) as it is written,
 * and a `file://` URL or a path relative to `mapDir` as the absolute path it
 * names.
 */
export function sourceIdentity(entry: string, root: string, mapDir: string): string {
  if (entry.startsWith("file://")) {
    return fileURLToPath(entry);
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entry) ? entry : path.resolve(root, mapDir, entry);
}

/**
 * @return the map with the source `entry` identifies (see {@link
 * sourceIdentity}, its entries read against `mapDir`) moved to the front of its
 * sources, its embedded contents and the source indices of its mappings
 * renumbered to match; the map as it is where it names no such source, names it
 * first, or has no mappings string. A css driver puts the stylesheet it
 * compiled first, where a reader of the map looks for it.
 */
export function withSourceFirst(map: IRawSourceMap, entry: string, root: string, mapDir: string): IRawSourceMap {
  const at = map.sources.findIndex(source => source !== "<no source>" && sourceIdentity(source, root, mapDir) === entry);
  if (at <= 0 || typeof map.mappings !== "string") {
    return map;
  }
  const moved = <T>(list: T[]): T[] => [list[at], ...list.slice(0, at), ...list.slice(at + 1)];
  const renumbered = (index: number): number => (index === at ? 0 : index < at ? index + 1 : index);
  /* A segment's source index is a delta from the previous segment's, across
   * lines; every other field is unchanged by renumbering sources. */
  let source = 0;
  let written = 0;
  const mappings = map.mappings
    .split(";")
    .map(line =>
      line
        .split(",")
        .map(segment => {
          if (segment === "") {
            return segment;
          }
          const fields = decodeVlqs(segment);
          if (fields.length >= 4) {
            source += fields[1];
            const index = renumbered(source);
            fields[1] = index - written;
            written = index;
          }
          return fields.map(encodeVlq).join("");
        })
        .join(",")
    )
    .join(";");
  return {
    ...map,
    sources: moved(map.sources),
    ...(map.sourcesContent === undefined ? {} : { sourcesContent: moved(map.sourcesContent) }),
    mappings,
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode a mappings segment's base64 VLQ fields. */
function decodeVlqs(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) {
      throw new Error(`'${segment}' is not a source map segment`);
    }
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/** Encode one mappings field as base64 VLQ. */
function encodeVlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let text = "";
  do {
    const digit = rest & 31;
    rest >>>= 5;
    text += BASE64[rest > 0 ? digit | 32 : digit];
  } while (rest > 0);
  return text;
}

/** @return the path with POSIX separators. */
function toPosix(name: string): string {
  return name.split(path.sep).join("/");
}

/**
 * @return a source map with its `sources` renamed from where the files were
 * staged to what the target calls them: a file under the staged source root by
 * its path relative to that root (for a chained map, the author's own `.scss`
 * name), any other file under the working root by its path relative to that,
 * and a file outside the working root by its basename. No absolute path is
 * left. A `<no source>` entry is kept.
 *
 * `ownInput`, given where the step's input is an intermediate (Sass ran before
 * this step), renames the entry naming the input (`path`, relative to the
 * source root) to `rename`, the stylesheet this step publishes.
 */
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
       * inline parsed with no `from`). */
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
