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
 */

/**
 * Fabr's Sass driver: the runtime executed (standalone, under node) inside a
 * sass_compile build step. It reads the options document fabr staged (see
 * CSSCompile.ts / ISassOptions) and, per source, lowers it to plain CSS via
 * sass-embedded (one warm compiler, package loads answered from the dependency
 * table) — the `.module.` marker rides through untouched, since lowering is not
 * scoping. Beside each stylesheet it writes the source map, where the build
 * carries maps, and nothing else — shims and declarations belong to the
 * css_postcss step, which names them after the stylesheets it publishes.
 * `loadedUrls` is captured (the depfile hook for future discovered-deps) but
 * unused for now.
 *
 * **The driver names nothing.** Every output path arrives in the options
 * document; this file writes what it is told to.
 *
 * The lowered tree is a deliverable in its own right: its stylesheets are
 * annotated and its maps name their sources as the TARGET names them, spelled
 * relative to the map as a consumer resolves them. The css_postcss step chains
 * through those maps like any other consumer — it is not owed a special form.
 *
 * Usage: node sass-driver.js --manifest=<path-to-manifest.json>
 *
 * Runs in the *build* process, not in fabr: it `require`s sass-embedded from
 * its own staged node_modules and must not depend on @fabr-build/core at
 * runtime (the ISassOptions import is type-only, erased at compile).
 * sass-embedded is required lazily inside {@link main} so the pure helpers stay
 * importable (for the unit tests) without it installed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ISassOptions, ISassSource } from "../CSSCompile";
import { PnpResolver, splitSpecifier } from "../pnp/PnPResolver";
import { IRawSourceMap, parseManifestPath, relativeToMap, relocateCssSources, sourceMapComment, writeOut } from "./Support";

/* Minimal structural typing for the slice of sass-embedded's API we use — it is
 * not a fabr dependency (it is fetched at build time), so its own types are not
 * available here; this mirrors the documented shape. */
interface ISassResult {
  css: string;
  loadedUrls: Array<{ pathname?: string; href?: string }>;
  sourceMap?: IRawSourceMap;
}
/** What Sass hands a {@link ISassFileImporter}: which file the load is written
 * in, and whether it came from an `@import` (which alone may load
 * import-only files). */
interface ISassCanonicalizeContext {
  containingUrl: URL | null;
  fromImport: boolean;
}
/**
 * Sass's *file* importer: it answers with a location and Sass does the rest —
 * partials (`_x.scss`), index files, extensions, and the read itself. That is
 * the seam a package table needs for a package that publishes no `exports`,
 * whose answer is a DIRECTORY with ordinary Sass file resolution below it; a
 * package that publishes a map answers with the file, which Sass takes as given.
 */
interface ISassFileImporter {
  findFileUrl(url: string, context: ISassCanonicalizeContext): URL | null;
}
interface ISassCompiler {
  compileAsync(
    path: string,
    options?: { loadPaths?: string[]; importers?: ISassFileImporter[]; sourceMap?: boolean; sourceMapIncludeSources?: boolean }
  ): Promise<ISassResult>;
  dispose(): Promise<void>;
}
interface ISass {
  initAsyncCompiler(): Promise<ISassCompiler>;
}

/**
 * Resolve a package-shaped Sass load through the dependency table.
 *
 * Sass consults an importer only for a load its own relative resolution did not
 * answer, so what arrives here is either a package reference
 * (`@shorthand/design-system/colours`) or a bare name meant for a load path
 * (`variables`, resolved next to the importing file or under a loadPath). The
 * table answers the first — the package part to its location — and declines the
 * second, which leaves Sass's own machinery in charge of it.
 *
 * Below the package root this follows dart-sass's own `NodePackageImporter`
 * rather than node's rules, because that is the resolver a stylesheet author
 * expects and the one they get everywhere else. The differences are real:
 *
 * - An `exports` map is a FIRST CHOICE, not a gate. Where it publishes the
 *   load, it answers; where it does not, the load falls through to the ordinary
 *   directory search rather than failing. `exports` encapsulates a package's
 *   JavaScript; Sass never agreed to that, and treating it as a boundary stops
 *   stylesheets compiling that compile under plain Sass.
 * - The package's legacy `sass` and `style` FIELDS answer for the root, in that
 *   order, when the map does not — the stylesheet counterpart of `types`/`main`,
 *   and root-only for the same reason: a field describes one entry point.
 *
 * A webpack-style `~pkg` prefix is refused rather than silently stripped: it is
 * a bundler convention, not a Sass one, and quietly accepting it here would
 * make stylesheets that only build under fabr.
 */
export function packageImporter(resolver: PnpResolver): ISassFileImporter {
  return {
    findFileUrl(url: string, context: ISassCanonicalizeContext): URL | null {
      if (url.startsWith("~")) {
        throw new Error(
          `css: '${url}' uses the webpack '~' prefix, which Sass does not define — write the package name directly ('${url.slice(1)}')`
        );
      }
      const split = splitSpecifier(url);
      if (split === undefined || context.containingUrl === null) {
        return null;
      }
      const issuer = context.containingUrl.pathname;
      const location = resolver.locationOf(split.name, issuer);
      if (location === undefined) {
        return null;
      }
      /* Three sources, in dart-sass's own order. The map first, but only where
       * the package HAS one — the resolver answers a mapless package with its
       * directory, which is the last of the three and not the first. */
      const manifest = stylesheetManifest(location);
      const published = manifest.publishes ? resolver.resolveSpecifier(url, issuer) : undefined;
      if (published !== undefined) {
        return pathToFileURL(published);
      }
      if (split.subpath === "" && manifest.entry !== undefined) {
        return pathToFileURL(manifest.entry);
      }
      /* A DIRECTORY where nothing named the file: Sass appends the partial,
       * index and extension candidates to it, so `@use "pkg/colours"` finds
       * `_colours.scss` exactly as it would under a load path. */
      return pathToFileURL(split.subpath ? path.join(location, split.subpath) : location);
    },
  };
}

/**
 * The world a stylesheet compilation resolves in. `sass` is the ecosystem's
 * condition for "the Sass source, not the compiled CSS"; `style` is the older
 * spelling, which packages predating `sass` still publish under. Neither is
 * ordered here — the package's own map decides which of its faces wins when it
 * offers both.
 */
export const SASS_CONDITIONS = ["sass", "style"];

/** The package's own fields naming its stylesheet entry point, in the order
 * dart-sass reads them. Pre-`exports` metadata, and still what many published
 * design systems carry instead of a map. */
const STYLESHEET_FIELDS = ["sass", "style"];

/** As much of a package's manifest as a stylesheet load reads: whether it
 * publishes a map at all, and the entry point its legacy fields name. */
interface IStylesheetManifest {
  readonly publishes: boolean;
  readonly entry: string | undefined;
}

/**
 * A package's stylesheet metadata. An unreadable manifest carries none — this
 * asks a question about a dependency, and whoever builds that dependency is the
 * one to report what is wrong with it.
 */
export function stylesheetManifest(location: string): IStylesheetManifest {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(location, "package.json"), "utf8")) as Record<string, unknown>;
    const named = STYLESHEET_FIELDS.map(field => manifest[field]).find(value => typeof value === "string");
    return {
      publishes: manifest.exports !== undefined && manifest.exports !== null,
      entry: named === undefined ? undefined : path.resolve(location, named as string),
    };
  } catch {
    return { publishes: false, entry: undefined };
  }
}

/**
 * Attribute a Sass failure to the file being lowered. The driver processes
 * every styled source in one run, and sass does not name the input in the error
 * it throws — so an unattributed failure leaves the reader bisecting by hand
 * (and reading whichever file the last *warning* happened to mention, which is
 * worse than nothing). Where sass reported a position (a sass-embedded
 * Exception carries `span`, whose `start` line/column are 0-based), it is a
 * position in the user's own file, rendered 1-based as `rel:line:column`.
 */
export function sassFailure(rel: string, err: unknown): Error {
  const reported = err as { message?: string; span?: { start?: { line?: number; column?: number } } };
  const start = reported?.span?.start;
  const at = start?.line === undefined ? rel : `${rel}:${start.line + 1}:${(start.column ?? 0) + 1}`;
  return new Error(`${at}: sass: ${reported?.message ?? String(err)}`);
}

interface ISassTools {
  compiler: ISassCompiler;
  importers?: ISassFileImporter[];
}

/** Lower one Sass source and write everything the options document names for
 * it: the CSS, and its map where the build carries them. */
async function processFile(source: ISassSource, options: ISassOptions, tools: ISassTools): Promise<void> {
  const inputPath = path.join(options.srcRoot, source.path);
  const wantsMap = source.map !== undefined;
  let css: string;
  let map: IRawSourceMap | undefined;
  try {
    /* loadedUrls is available on `result` for future discovered-deps;
     * intentionally unused for now. */
    const lowered = await tools.compiler.compileAsync(inputPath, {
      loadPaths: options.loadPaths,
      importers: tools.importers,
      ...(wantsMap ? { sourceMap: true, sourceMapIncludeSources: true } : {}),
    });
    css = lowered.css;
    map = lowered.sourceMap;
  } catch (err) {
    throw sassFailure(source.path, err);
  }
  if (source.map !== undefined && map !== undefined) {
    /* Named as the TARGET names them, and annotated: this step's output is a
     * deliverable tree in its own right, not a form only the next step can
     * read. Sass reports its sources as absolute `file://` URLs, which relocate
     * against the staged root like any other. */
    const where = { root: process.cwd(), srcRoot: options.srcRoot, mapDir: path.dirname(path.join(options.outdir, source.css)) };
    writeOut(options.outdir, source.map, JSON.stringify(relativeToMap(relocateCssSources(map, where), source.map)));
    writeOut(options.outdir, source.css, css + sourceMapComment(source.map));
    return;
  }
  writeOut(options.outdir, source.css, css);
}

export async function main(argv: string[]): Promise<void> {
  // sass-embedded is fetched at build time and mounted in this step's
  // node_modules, so it is required (not imported) — its types are not
  // available to compile.
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const sass = require("sass-embedded") as ISass;

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv, "sass-driver"), "utf8")) as ISassOptions;
  /* Where the dependencies are: a table beside the sources (nothing mounted),
   * or — with no manifest — the load paths fabr staged, which is the classic
   * layout and needs no importer at all. */
  const resolver = PnpResolver.load(process.cwd(), SASS_CONDITIONS);
  const importers = resolver ? [packageImporter(resolver)] : undefined;
  const compiler = await sass.initAsyncCompiler();
  try {
    /* Sequential for now — correctness first; the warm compiler already
     * amortizes startup.
     *
     * Sass partials (`_foo.scss`) are absent from this list by construction:
     * they exist to be `@use`d/`@import`ed and fail compiled on their own, so
     * the rule names no outputs for them. They are still STAGED, because the
     * stylesheets that include them need them on disk. */
    for (const source of options.sources) {
      await processFile(source, options, { compiler, importers });
    }
  } finally {
    await compiler.dispose();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
