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
 * CSSCompile.ts / ICssOptions) and, per source, lowers it (Sass via
 * sass-embedded, one warm compiler, loadPaths = the mounted scss deps) and —
 * where the source is a css-module — scopes it with **postcss-modules**, writing
 * the scoped CSS, a JS shim carrying the class-name map, and the TypeScript
 * declarations that type an import of it. `loadedUrls` is captured (the depfile
 * hook for future discovered-deps) but unused for now.
 *
 * **The driver names nothing.** Every output path, and each module's scope
 * suffix, arrives in the options document; this file writes what it is told to.
 *
 * Usage: node css-driver.js --manifest=<path-to-manifest.json>
 *
 * Like the bundle driver, this file runs in the *build* process, not in fabr:
 * it `require`s its tools from its own staged node_modules and must not
 * depend on @fabr-build/core at runtime (the ICssOptions import is type-only,
 * erased at compile). Sass and postcss are required lazily inside {@link main}
 * so the pure helpers stay importable (for the unit tests) without them
 * installed.
 *
 * The bundler stays dumb about CSS: this driver produces plain, already-scoped
 * CSS; esbuild concatenates/orders/splits it via the JS import graph. The driver
 * never concatenates or orders CSS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ICssOptions, ICssSource } from "../CSSCompile";
import { PnpResolver, splitSpecifier } from "../pnp/PnPResolver";

/* Minimal structural typing for the slice of sass-embedded's API we use — it is
 * not a fabr dependency (it is fetched at build time), so its own types are not
 * available here; this mirrors the documented shape. */
interface ISassResult {
  css: string;
  loadedUrls: Array<{ pathname?: string; href?: string }>;
  sourceMap?: IRawSourceMap;
}
/** The slice of a source map this driver reads: the source list it has to
 * rewrite, and the embedded contents it must keep aligned with it. */
interface IRawSourceMap {
  sources: string[];
  sourcesContent?: Array<string | null>;
  [member: string]: unknown;
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

/* The same for postcss and postcss-modules: fetched at build time, mounted in
 * this step's node_modules, so their own types are not available here. */
interface IPostcssResult {
  css: string;
  map?: { toJSON(): IRawSourceMap };
}
interface IPostcssProcessor {
  process(
    css: string,
    options: { from: string; to?: string; map?: { prev?: IRawSourceMap | string; inline: boolean; annotation: boolean } }
  ): Promise<IPostcssResult>;
}
type IPostcss = (plugins: unknown[]) => IPostcssProcessor;
/** The subset of postcss-modules' options this driver sets. `getJSON` doubles as
 * the suppression of its default behaviour, which is to write a `.json` beside
 * the stylesheet. */
interface IModulesOptions {
  generateScopedName(local: string, filename: string, css: string): string;
  getJSON(filename: string, tokens: Record<string, string>): void;
  localsConvention: string;
}
type IPostcssModules = (options: IModulesOptions) => unknown;

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

/** Whether a source is Sass (the ones this driver compiles; anything else is
 * already plain CSS and passes through). A processing question — which tool
 * handles this file — and so the driver's, unlike every naming question, which
 * the options document answers. */
export function isSass(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/** Write a file, creating parent directories as needed. */
function writeOut(outdir: string, rel: string, contents: string | Uint8Array): void {
  const dest = path.join(outdir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
}

/**
 * The JS shim for a css-module: the class-name map as an ES module, plus a
 * side-effect import of the stylesheet it belongs to.
 *
 * The import is deliberate and is what every css-modules toolchain emits — it is
 * how a bundler learns the CSS belongs in the output, and how a test runner's
 * asset stub knows to ignore it. Emitted as ESM because the shim is an ordinary
 * compile INPUT, not a delivered artifact: tsc restates it in whatever module
 * system the compile emits, so a dual package gets both copies for free and the
 * stylesheet import goes through the same specifier machinery as everything
 * else.
 */
export function cssModuleShim(cssName: string, tokens: Record<string, string>): string {
  const basename = cssName.split("/").pop() ?? cssName;
  const specifier = JSON.stringify(`./${basename}`);
  const entries = Object.keys(tokens)
    .sort()
    .map(local => `  ${JSON.stringify(local)}: ${JSON.stringify(tokens[local])},`);
  return [`import ${specifier};`, "const styles = {", ...entries, "};", "export default styles;", ""].join("\n");
}

/**
 * The TypeScript declaration for a stylesheet import: the class-name map's shape
 * for a css-module, an empty module for a plain stylesheet (which exports
 * nothing but must still resolve, so a side-effect import typechecks).
 *
 * A default-export object type with **quoted keys**, never named exports: a
 * class name is not required to be a valid TypeScript identifier, and named
 * exports would force dropping every one that isn't (which is exactly what
 * typed-css-modules does). Quoted keys keep the whole set.
 */
export function cssModuleDeclaration(tokens: Record<string, string> | undefined): string {
  if (tokens === undefined) {
    return "export {};\n";
  }
  const members = Object.keys(tokens)
    .sort()
    .map(local => `  readonly ${JSON.stringify(local)}: string;`);
  return ["declare const styles: {", ...members, "};", "export default styles;", ""].join("\n");
}

/**
 * A source map's `sources`, rewritten from where the files were staged to what
 * the target calls them: the target's own source under its own name
 * (`Card.module.scss`, staging root stripped), anything outside the staged
 * sources under its working-root-relative path. No absolute path survives.
 *
 * `intermediate` names what postcss calls its own input where Sass ran before
 * it; see the call site.
 */
export interface ISourceMapLocation {
  /** The step's working directory, which every path is made relative to. */
  root: string;
  /** Where the styled sources are staged, stripped from the target's own files. */
  srcRoot: string;
  /** The directory the map is written to, which is what its relative source
   * entries are resolved against. */
  mapDir: string;
}

export function relocateSources(map: IRawSourceMap, where: ISourceMapLocation, intermediate?: string): IRawSourceMap {
  const { root, srcRoot, mapDir } = where;
  const staged = `${path.resolve(root, srcRoot)}/`;
  const workingRoot = `${path.resolve(root)}/`;
  return {
    ...map,
    sources: map.sources.map(source => {
      /* Where Sass ran, postcss additionally names its OWN input — the lowered
       * CSS — and names it after the file it was told the content came from, so
       * it would otherwise land on the source's name carrying the source's
       * content's replacement. Sass spells its sources as `file://` URLs and
       * postcss spells its own as a path, which is what tells them apart. The
       * few mappings that reference it are the ones Sass does not map at all
       * (closing braces), so this is about the entry being HONEST rather than
       * about where anything resolves. */
      if (intermediate !== undefined && !source.startsWith("file://")) {
        return intermediate;
      }
      /* Sass gives absolute URLs; postcss gives paths relative to the map's own
       * directory, which is where `to` put it. */
      const absolute = source.startsWith("file://") ? fileURLToPath(source) : path.resolve(root, mapDir, source);
      if (absolute.startsWith(staged)) {
        return absolute.substring(staged.length);
      }
      return absolute.startsWith(workingRoot) ? absolute.substring(workingRoot.length) : path.basename(absolute);
    }),
  };
}

/** The `sourceMappingURL` comment naming a map that sits beside its stylesheet.
 * Written here rather than by postcss so the Sass-only path (a plain stylesheet,
 * which never reaches postcss) produces the identical annotation. */
export function sourceMapComment(mapName: string): string {
  return `\n/*# sourceMappingURL=${path.basename(mapName)} */\n`;
}

/** Attribute a scoping failure to the file being processed: the driver runs
 * every styled source in one go, and postcss names only the text it was handed,
 * which under Sass is no file on disk. */
export function scopeFailure(rel: string, err: unknown): Error {
  const reported = err as { reason?: string; message?: string; line?: number; column?: number };
  const at = reported?.line === undefined ? rel : `${rel}:${reported.line}:${reported.column ?? 1}`;
  return new Error(`${at}: css-modules: ${reported?.reason ?? reported?.message ?? String(err)}`);
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

/** What the tools this driver runs are, resolved once and passed down. */
interface ICssTools {
  compiler: ISassCompiler;
  importers?: ISassFileImporter[];
  postcss: IPostcss;
  modules: IPostcssModules;
}

/**
 * Lower one styled source and write everything the options document names for
 * it: the CSS, and — for a css-module — the JS shim and the declarations.
 *
 * The order is Sass, then scoping: the class names only exist once Sass has
 * evaluated the stylesheet, which is exactly why scoping cannot be left to a
 * bundler if anything upstream of the bundle needs to know them.
 *
 * A plain stylesheet is not run through postcss at all. That is not an
 * optimization but the dialect: `:global`/`:local` and local-by-default apply to
 * modules, and a global sheet's names are its own.
 */
async function processFile(source: ICssSource, options: ICssOptions, tools: ICssTools): Promise<void> {
  const inputPath = path.join(options.srcRoot, source.path);
  const wantsMap = source.map !== undefined;
  let css: string;
  /* Sass's map where Sass ran, which postcss then CHAINS rather than replaces —
   * so a position in the scoped output resolves through the rename AND through
   * Sass's nesting expansion, back to the line the author wrote. */
  let map: IRawSourceMap | undefined;
  /* Set once Sass has produced a map for postcss to chain — the one case where
   * the result carries an entry for the intermediate. */
  let chained = false;
  if (isSass(source.path)) {
    /* loadedUrls is available on `result` for future discovered-deps;
     * intentionally unused for now. */
    try {
      const lowered = await tools.compiler.compileAsync(inputPath, {
        loadPaths: options.loadPaths,
        importers: tools.importers,
        ...(wantsMap ? { sourceMap: true, sourceMapIncludeSources: true } : {}),
      });
      css = lowered.css;
      map = lowered.sourceMap;
      chained = map !== undefined;
    } catch (err) {
      throw sassFailure(source.path, err);
    }
  } else {
    css = fs.readFileSync(inputPath, "utf8");
  }

  let tokens: Record<string, string> | undefined;
  if (source.scope !== undefined) {
    const scope = source.scope;
    let exported: Record<string, string> = {};
    try {
      const scoped = await tools.postcss([
        tools.modules({
          /* The name is the rule's policy, delivered as a per-file suffix: a
           * function of the package and the path, never of a bundle or of where
           * the file was staged. */
          generateScopedName: (local: string): string => `${local}_${scope}`,
          getJSON: (_file: string, json: Record<string, string>): void => {
            exported = json;
          },
          /* Both spellings, literal and camelCase. Not a fabr invention: it is
           * what a Sass-and-css-modules project's sources are written against
           * (`.header-bar` read as `styles.headerBar`), and the alternative is
           * that those reads are silently `undefined`. */
          localsConvention: "camelCase",
        }),
      ]).process(css, {
        from: inputPath,
        to: path.join(options.outdir, source.css),
        /* `annotation: false` because this driver writes the comment itself, so
         * the Sass-only path produces an identical one. */
        ...(wantsMap ? { map: { ...(map ? { prev: map } : {}), inline: false, annotation: false } } : {}),
      });
      css = scoped.css;
      map = scoped.map?.toJSON() ?? map;
    } catch (err) {
      throw scopeFailure(source.path, err);
    }
    tokens = exported;
  }

  if (source.map !== undefined && map !== undefined) {
    const where = { root: process.cwd(), srcRoot: options.srcRoot, mapDir: path.dirname(path.join(options.outdir, source.css)) };
    writeOut(options.outdir, source.map, JSON.stringify(relocateSources(map, where, chained ? source.css : undefined)));
    css += sourceMapComment(source.map);
  }
  writeOut(options.outdir, source.css, css);
  if (source.shim !== undefined && tokens !== undefined) {
    writeOut(options.outdir, source.shim, cssModuleShim(source.css, tokens));
  }
  for (const declaration of source.declarations) {
    writeOut(options.outdir, declaration, cssModuleDeclaration(tokens));
  }
}

function parseManifestPath(argv: string[]): string {
  const flag = argv.find(arg => arg.startsWith("--manifest="));
  if (!flag) {
    throw new Error("css-driver: missing --manifest=<path>");
  }
  return flag.substring("--manifest=".length);
}

export async function main(argv: string[]): Promise<void> {
  // The tools are fetched at build time and mounted in this step's
  // node_modules, so they are required (not imported) — their types are not
  // available to compile.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const sass = require("sass-embedded") as ISass;
  const postcss = require("postcss") as IPostcss;
  const modules = require("postcss-modules") as IPostcssModules;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv), "utf8")) as ICssOptions;
  /* Where the dependencies are: a table beside the sources (nothing mounted),
   * or — with no manifest — the load paths fabr staged, which is the classic
   * layout and needs no importer at all. */
  const resolver = PnpResolver.load(process.cwd(), SASS_CONDITIONS);
  const importers = resolver ? [packageImporter(resolver)] : undefined;
  const compiler = await sass.initAsyncCompiler();
  try {
    /* Sequential for now — correctness first; the warm compiler already
     * amortizes startup. Concurrency is a later throughput tweak.
     *
     * Sass partials (`_foo.scss`) are absent from this list by construction:
     * they exist to be `@use`d/`@import`ed and fail compiled on their own, so
     * the rule names no outputs for them. They are still STAGED, because the
     * stylesheets that include them need them on disk. */
    for (const source of options.sources) {
      await processFile(source, options, { compiler, importers, postcss, modules });
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
