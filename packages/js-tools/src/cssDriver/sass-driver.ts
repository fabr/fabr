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
 * Fabr's Sass driver (`fabr-sass`), run in a sass_compile build step. It reads
 * the options document fabr staged (see CSSCompile.ts and ISassOptions) and
 * lowers each source to plain CSS with one sass-embedded compiler, package
 * loads resolved through the step's PnP table, where there is one, by
 * @fabr-build/sass-pnp-importer. It writes each stylesheet at the path the
 * options document names, and its source map where one is named: the map's
 * sources named as the target names them, relative to the map, and the
 * stylesheet annotated with it. Shims and declarations are the css_postcss
 * step's.
 *
 * Usage: fabr-sass --manifest=<options.json> [--deps-report <file>]
 * [--source-paths <file>]
 *
 * Runs in the step's own process: do not depend on @fabr-build/core at
 * runtime. sass-embedded and the importer come from the step's own
 * installation and are required only inside {@link main}, so the other exports
 * load without them (for the unit tests).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ISassOptions, ISassSource } from "./Options";
import { PnpResolver } from "../pnp/PnPResolver";
import { stagedReferences } from "../support/SourceMap";
import {
  IRawSourceMap,
  referencedCssSources,
  relativeToMap,
  relocateCssSources,
  sourceMapComment,
  withSourceFirst,
  writeDepsReport,
  writeOut,
} from "./Support";
import { parseManifestPath } from "../support/Main";

/* The parts of sass-embedded's API the driver uses, typed structurally from
 * its documentation: it is no compile-time dependency of this package. */
interface ISassResult {
  css: string;
  loadedUrls: Array<{ pathname?: string; href?: string }>;
  sourceMap?: IRawSourceMap;
}
/** A Sass importer, as sass-embedded takes one; opaque to the driver. */
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
 * Make the error reporting a Sass failure lowering `rel`, which sass's own
 * error does not name: `rel: sass: <message>`, or `rel:line:column: …` (1-based)
 * where sass reported a position (a sass-embedded Exception's `span.start`,
 * 0-based).
 */
export function sassFailure(rel: string, err: unknown): Error {
  const reported = err as { message?: string; span?: { start?: { line?: number; column?: number } } };
  const start = reported?.span?.start;
  const at = start?.line === undefined ? rel : `${rel}:${start.line + 1}:${(start.column ?? 0) + 1}`;
  return new Error(`${at}: sass: ${reported?.message ?? String(err)}`);
}

/** What lowering a source uses, made once per run. */
interface ISassTools {
  compiler: ISassCompiler;
  importers?: ISassImporter[];
  /** How a staged source is named in a map, where the step staged a table. */
  referenceOf?: (staged: string, own?: string) => string | undefined;
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
    /* Sass names its sources by absolute `file://` URLs, in the order the
     * output first reaches each: put the stylesheet compiled first, then name
     * each as the target does. */
    const where = { root: process.cwd(), srcRoot: options.srcRoot, mapDir: path.dirname(path.join(options.outdir, source.css)) };
    const ordered = withSourceFirst(map, path.resolve(where.root, inputPath), where.root, where.mapDir);
    const finished =
      tools.referenceOf === undefined
        ? relativeToMap(relocateCssSources(ordered, where), source.map)
        : referencedCssSources(ordered, source.map, where, tools.referenceOf);
    writeOut(options.outdir, source.map, JSON.stringify(finished));
    writeOut(options.outdir, source.css, css + sourceMapComment(source.map));
    return;
  }
  writeOut(options.outdir, source.css, css);
}

/** @return @fabr-build/sass-pnp-importer's module. Call it only where there is
 * a PnP table to resolve through. */
function pnpImporter(): ISassPnpImporterModule {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  return require("@fabr-build/sass-pnp-importer") as ISassPnpImporterModule;
}

/** Lower every source the options document lists, then write the deps report
 * where `argv` asks for one. Rejects with the first failure. */
export async function main(argv: string[]): Promise<void> {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const sass = require("sass-embedded") as ISass;

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv, "sass-driver"), "utf8")) as ISassOptions;
  /* The step's PnP table, if it staged one; with none, packages are found
   * through the staged load paths alone, and no importer is installed. */
  const resolver = PnpResolver.load(process.cwd(), []);
  /* Record every file the importer probes or reads (a stylesheet, a partial it
   * tries, a package's manifest): it passes each through `resolveVirtual`
   * first. */
  const touched: string[] = [];
  if (resolver !== undefined) {
    const resolveVirtual = resolver.resolveVirtual.bind(resolver);
    resolver.resolveVirtual = (file: string): string | null => {
      touched.push(file);
      return resolveVirtual(file);
    };
  }
  const importers = resolver ? [pnpImporter().sassPnpImporter({ pnpApi: resolver })] : undefined;
  /* Where the step staged a source-paths table, maps name each source by its
   * reference. */
  const referenceOf = stagedReferences(argv, process.cwd());
  const compiler = await sass.initAsyncCompiler();
  try {
    /* The list holds no partial (`_foo.scss`): a partial is staged for the
     * stylesheets that `@use` or `@import` it, but is not compiled itself. */
    for (const source of options.sources) {
      await processFile(source, options, { compiler, importers, referenceOf });
    }
    writeDepsReport(argv, resolver?.readSetOf(touched) ?? [], resolver?.edges());
  } finally {
    await compiler.dispose();
  }
}
