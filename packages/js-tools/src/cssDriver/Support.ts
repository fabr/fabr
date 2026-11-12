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
import { DEPS_REPORT_FLAG, IResolutionEdge, serializeRunReport } from "../pnp/ReadSet";
import { resolveVirtual } from "../pnp/VirtualPath";
import { toJsonObject } from "../support/Json";

/** @return true if a name is a Sass source (one the driver compiles; a plain
 * `.css` passes through), otherwise false. */
export function isSassSource(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/**
 * @return the name a Sass source takes when the *sass step* lowers it: the
 * extension becomes `.css`, the `.module.` marker rides through — the marker
 * means "scope me", and lowering does not scope. Identity on a plain `.css`.
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
 * @return a relocated map's entries, respelled relative to where the map itself
 * sits — which is how a consumer resolves them, and how this pipeline's next
 * step reads a map it chains through. `mapName` is the map's own
 * target-relative path.
 */
export function relativeToMap(map: IRawSourceMap, mapName: string): IRawSourceMap {
  const home = path.dirname(mapName);
  return {
    ...map,
    sources: map.sources.map(source => (source === "<no source>" ? source : path.relative(home, source) || source)),
  };
}

/** @return the name a map is annotated under — beside its stylesheet, so the
 * basename is the whole reference. */
export function annotationName(mapName: string): string {
  return path.basename(mapName);
}

/**
 * @return a stylesheet with every `sourceMappingURL` annotation removed.
 *
 * A step ships only annotations it wrote: an input's annotation names ITS map,
 * which is a different file from the one this step publishes, and a composed
 * stylesheet's rides along with the rules a `composes` inlines.
 */
export function withoutAnnotations(css: string): string {
  return css.replace(/\n?[ \t]*\/\*#[ \t]*sourceMappingURL=[^*]*\*\/[ \t]*/g, "");
}

/**
 * Write what the run read of the packages it was given, and how it resolved
 * them, where the step asked for it (`--deps-report <file>`, relative to the
 * working dir); nothing where it did not.
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
 * The scheme a fabr reference is carried under while postcss composes maps.
 *
 * A source-map entry is either relative to its map or an absolute URL, and a
 * fabr reference is written as an opaque URL (`fabr:./src/a.scss`, no `//`).
 * postcss composes an input map (`map.prev`) through `source-map-js`, which
 * counts only `scheme://…` as absolute: it reads `fabr:./src/a.scss` as a path
 * and joins it onto the input map's directory, so the composed map would name
 * `w/fabr:./src/a.scss`. Carried as `fabr-reference://<encoded reference>` the
 * entry passes through untouched, and {@link referencedCssSources} restores it.
 * The scheme never appears in a map the step ships.
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
 * @return a css step's map, its sources named as {@link relocateCssSources}
 * names them relative to the map at `mapName`, except that each the step's
 * table names is its fabr reference: an entry that already is one stays, and
 * one the step staged (a `file://` URL or a path relative to the map, a
 * package's reached through its virtual path) is named by `referenceOf`. A
 * reference an input map held arrives as {@link carriedReferences} carried it,
 * and is restored.
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
 * renumbered to match; the map as it is where it names no such source, or names
 * it first. A css driver writes the stylesheet it compiled first, so that a
 * reader of the map finds it there.
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
 * @return a source map's `sources`, rewritten from where the files were staged
 * to what the target calls them: anything under the staged source root keeps
 * its root-relative name (which for a chained map is the author's own `.scss`
 * name), anything else under the working root its working-root-relative path,
 * and anything outside the working root its basename. No absolute path
 * survives.
 *
 * `ownInput` names the step's own input where it is an intermediate (a chained
 * map — Sass ran before this step): postcss adds an entry for the content it
 * was handed, and left alone that entry would ship the never-shipped lowered
 * name; it is renamed to the stylesheet this step publishes. An unchained
 * run's input IS the source and keeps its own name through the ordinary
 * root-relative branch.
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
