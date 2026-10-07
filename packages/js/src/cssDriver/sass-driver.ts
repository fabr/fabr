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
 * table by @fabr-build/sass-pnp-importer) — the `.module.` marker rides through untouched, since lowering is not
 * scoping. Beside each stylesheet it writes the source map, where the build
 * carries maps, and nothing else — shims and declarations belong to the
 * css_postcss step, which names them after the stylesheets it publishes.
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
 * Runs in the *build* process, not in fabr: it `require`s sass-embedded and the
 * importer from its own staged node_modules and must not depend on
 * @fabr-build/core at runtime (the ISassOptions import is type-only, erased at
 * compile). Both are required lazily inside {@link main} so the pure helpers
 * stay importable (for the unit tests) without them installed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ISassOptions, ISassSource } from "../CSSCompile";
import { PnpResolver } from "../pnp/PnPResolver";
import { IRawSourceMap, parseManifestPath, relativeToMap, relocateCssSources, sourceMapComment, writeOut } from "./Support";

/* Minimal structural typing for the slice of sass-embedded's API we use — it is
 * not a fabr dependency (it is fetched at build time), so its own types are not
 * available here; this mirrors the documented shape. */
interface ISassResult {
  css: string;
  loadedUrls: Array<{ pathname?: string; href?: string }>;
  sourceMap?: IRawSourceMap;
}
/** A Sass importer, as sass-embedded takes one — opaque here: the driver only
 * hands it over. */
type ISassImporter = object;
/** As much of @fabr-build/sass-pnp-importer as the driver uses. */
interface ISassPnpImporterModule {
  sassPnpImporter(options: { pnpApi: PnpResolver }): ISassImporter;
}
interface ISassCompiler {
  compileAsync(
    path: string,
    options?: { loadPaths?: string[]; importers?: ISassImporter[]; sourceMap?: boolean; sourceMapIncludeSources?: boolean }
  ): Promise<ISassResult>;
  dispose(): Promise<void>;
}
interface ISass {
  initAsyncCompiler(): Promise<ISassCompiler>;
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
  importers?: ISassImporter[];
}

/** Lower one Sass source and write everything the options document names for
 * it: the CSS, and its map where the build carries them. */
async function processFile(source: ISassSource, options: ISassOptions, tools: ISassTools): Promise<void> {
  const inputPath = path.join(options.srcRoot, source.path);
  const wantsMap = source.map !== undefined;
  let css: string;
  let map: IRawSourceMap | undefined;
  try {
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

/** The package-load importer, required only where there is a table to resolve
 * through. */
function pnpImporter(): ISassPnpImporterModule {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  return require("@fabr-build/sass-pnp-importer") as ISassPnpImporterModule;
}

export async function main(argv: string[]): Promise<void> {
  // sass-embedded and the importer are fetched at build time and mounted in
  // this step's node_modules, so they are required (not imported) — their
  // types are not available to compile.
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const sass = require("sass-embedded") as ISass;

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv, "sass-driver"), "utf8")) as ISassOptions;
  /* Where the dependencies are: a table beside the sources (nothing mounted),
   * or — with no manifest — the load paths fabr staged, which is the classic
   * layout and needs no importer at all. */
  const resolver = PnpResolver.load(process.cwd(), []);
  const importers = resolver ? [pnpImporter().sassPnpImporter({ pnpApi: resolver })] : undefined;
  const compiler = await sass.initAsyncCompiler();
  try {
    /* Sass partials (`_foo.scss`) are absent from this list by construction:
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
