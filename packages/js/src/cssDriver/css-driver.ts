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
 * Fabr's CSS driver: the runtime executed (standalone, under node) inside a
 * css_compile build step. It reads the options document fabr staged (see
 * CSSCompile.ts / ICssOptions) and lowers styled sources to plain CSS — Sass
 * (sass-embedded) and nothing else: .scss/.sass → plain CSS, one warm compiler,
 * loadPaths = the mounted scss deps. `loadedUrls` is captured (the depfile hook
 * for future discovered-deps) but unused for now.
 *
 * css-modules are NOT scoped here: a `.module.scss` lowers to a `.module.css`
 * and stops. The bundler's local-css loader scopes it and hands the importing JS
 * its class-name map — one engine, so one css-modules dialect.
 *
 * Usage: node css-driver.js --manifest=<path-to-manifest.json>
 *
 * Like the bundle driver, this file runs in the *build* process, not in fabr:
 * it `require`s sass-embedded from its own staged node_modules and must not
 * depend on @fabr-build/core at runtime (the ICssOptions import is type-only,
 * erased at compile). Sass is required lazily inside {@link main} so the pure
 * helpers stay importable (for the unit tests) without it installed.
 *
 * The bundler stays dumb about CSS: this driver produces plain CSS; esbuild
 * concatenates/orders/splits it via the JS import graph. The driver never
 * concatenates or orders CSS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ICssOptions } from "../CSSCompile";
import { PnpResolver, splitSpecifier } from "../pnp/PnPResolver";

/* Minimal structural typing for the slice of sass-embedded's API we use — it is
 * not a fabr dependency (it is fetched at build time), so its own types are not
 * available here; this mirrors the documented shape. */
interface ISassResult {
  css: string;
  loadedUrls: Array<{ pathname?: string; href?: string }>;
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
 * exactly the seam a package table needs, since the table's answer is a
 * DIRECTORY and everything below it is ordinary Sass file resolution.
 */
interface ISassFileImporter {
  findFileUrl(url: string, context: ISassCanonicalizeContext): URL | null;
}
interface ISassCompiler {
  compileAsync(path: string, options?: { loadPaths?: string[]; importers?: ISassFileImporter[] }): Promise<ISassResult>;
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
 * first is answered from the table — the package part to its location, the rest
 * appended for Sass to finish — and the second is declined, which leaves Sass's
 * own machinery in charge of it.
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
      const location = resolver.locationOf(split.name, context.containingUrl.pathname);
      if (location === undefined) {
        return null;
      }
      /* A directory, deliberately: Sass appends the partial/index/extension
       * candidates to it, so `@use "pkg/colours"` finds `_colours.scss` exactly
       * as it would under a load path. */
      return pathToFileURL(split.subpath ? path.join(location, split.subpath) : location);
    },
  };
}

/** Whether a source is Sass (the ones this driver compiles; anything else is
 * already plain CSS and passes through). */
export function isSass(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/** Whether a styled source is a Sass PARTIAL (`_foo.scss`) — included by
 * another stylesheet rather than compiled in its own right. */
export function isPartial(name: string): boolean {
  return name.split("/").pop()?.startsWith("_") === true;
}

/** The plain-CSS output name for a non-module Sass source (`x.scss` → `x.css`). */
export function plainCssName(name: string): string {
  return name.replace(/\.(scss|sass)$/i, ".css");
}

/** Write a file, creating parent directories as needed. */
function writeOut(outdir: string, rel: string, contents: string | Uint8Array): void {
  const dest = path.join(outdir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
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

/**
 * Lower one styled source to its output under `outdir`, co-located at the
 * source's relative path: a Sass source compiles to `.css`, a plain `.css`
 * passes through verbatim. A `.module.scss` is no different here — it lowers to
 * `.module.css` and stops, the scoping being esbuild's (see the file header).
 */
async function lowerFile(rel: string, options: ICssOptions, compiler: ISassCompiler, importers?: ISassFileImporter[]): Promise<void> {
  const inputPath = path.join(options.srcRoot, rel);
  if (!isSass(rel)) {
    writeOut(options.outdir, rel, fs.readFileSync(inputPath));
    return;
  }
  /* loadedUrls is available on `result` for future discovered-deps;
   * intentionally unused for now. */
  let css: string;
  try {
    css = (await compiler.compileAsync(inputPath, { loadPaths: options.loadPaths, importers })).css;
  } catch (err) {
    throw sassFailure(rel, err);
  }
  writeOut(options.outdir, plainCssName(rel), css);
}

function parseManifestPath(argv: string[]): string {
  const flag = argv.find(arg => arg.startsWith("--manifest="));
  if (!flag) {
    throw new Error("css-driver: missing --manifest=<path>");
  }
  return flag.substring("--manifest=".length);
}

export async function main(argv: string[]): Promise<void> {
  // Sass is fetched at build time and mounted in this step's node_modules, so
  // it is required (not imported) — its types are not available to compile.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sass = require("sass-embedded") as ISass;

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv), "utf8")) as ICssOptions;
  /* Where the dependencies are: a table beside the sources (nothing mounted),
   * or — with no manifest — the load paths fabr staged, which is the classic
   * layout and needs no importer at all. */
  const resolver = PnpResolver.load(process.cwd());
  const importers = resolver ? [packageImporter(resolver)] : undefined;
  const compiler = await sass.initAsyncCompiler();
  try {
    // Sequential for now — correctness first; the warm compiler already
    // amortizes startup. Concurrency is a later throughput tweak.
    for (const rel of options.files) {
      /* Sass's own convention: a leading underscore marks a PARTIAL — a
       * fragment meant to be `@use`d/`@import`ed, never compiled on its own.
       * Compiled standalone it fails on whatever its importer was supposed to
       * define first (a variable, a mixin), so sass skips partials when
       * compiling a directory and so do we. They are still staged, because the
       * stylesheets that include them need them on disk. */
      if (isPartial(rel)) {
        continue;
      }
      await lowerFile(rel, options, compiler, importers);
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
