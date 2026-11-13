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
 * Fabr's postcss driver (`fabr-postcss`), run in a css_postcss build step. Its
 * inputs are plain CSS (a Sass source arrives lowered by the sass_compile step,
 * its `.module.` marker kept), each run through css-modules where it is a
 * css-module, then autoprefixer for the browsers the options list, where they
 * list any. Every output path and each stylesheet's scope come from the
 * options document (see CSSCompile.ts and IPostcssOptions).
 *
 * - A css-module is scoped (each local class renamed `<local>_<scope>`) and
 *   written beside a TypeScript shim holding and typing its class-name map. Any
 *   other stylesheet keeps its class names.
 * - Where an input arrived with a source map (`prev`), the output map is
 *   chained through it, so a position in the output maps back to the line the
 *   author wrote. Every `sourceMappingURL` annotation an input carried is
 *   removed, and the step's own written where it writes a map.
 * - `composes: x from '<specifier>'` resolves a relative specifier against the
 *   importer, and any other against the dependency stylesheets the options
 *   list, located through the step's PnP table. A specifier naming a Sass
 *   source (`./b.module.scss`) names its lowered input. Every class is scoped
 *   with its own file's scope, and a plain stylesheet is composable too: its
 *   rules arrive in the importer as a scoped copy. A specifier naming no such
 *   stylesheet (a Sass partial, a file no dependency provides) is an error.
 *
 * The driver never concatenates or orders CSS: esbuild does, by the JS import
 * graph.
 *
 * Usage: fabr-postcss --manifest=<options.json> [--deps-report <file>]
 * [--source-paths <file>]
 *
 * Runs in the step's own process: do not depend on @fabr-build/core at
 * runtime. postcss, postcss-modules and autoprefixer come from the step's own
 * installation and are required only inside {@link main}, so the other exports
 * load without them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IPostcssOptions, IPostcssSource } from "./Options";
import { PnpResolver } from "../pnp/PnPResolver";
import { parseJson } from "../support/Json";
import { stagedReferences } from "../support/SourceMap";
import {
  annotationName,
  carriedReferences,
  IRawSourceMap,
  referencedCssSources,
  relativeToMap,
  relocateCssSources,
  sassLoweredName,
  sourceIdentity,
  toRawSourceMap,
  withoutAnnotations,
  withSourceFirst,
  writeDepsReport,
  writeOut,
} from "./Support";
import { parseManifestPath } from "../support/Main";
import { toPosix } from "../support/Paths";

/* The parts of postcss and postcss-modules the driver uses, typed structurally
 * from their documentation: they are no compile-time dependency of this
 * package. */
interface IPostcssResult {
  css: string;
  map?: { toJSON(): IRawSourceMap };
}
interface IPostcssProcessor {
  process(
    css: string,
    options: { from: string; to?: string; map?: { prev?: IRawSourceMap; inline: boolean; annotation: boolean | string } }
  ): Promise<IPostcssResult>;
}
type IPostcss = (plugins: unknown[]) => IPostcssProcessor;
/** The postcss-modules options this driver sets. Setting `getJSON` also stops
 * postcss-modules writing a `.json` beside the stylesheet; `resolve` resolves a
 * compose specifier. */
interface IModulesOptions {
  generateScopedName(local: string, filename: string, css: string): string;
  getJSON(filename: string, tokens: Record<string, string>): void;
  localsConvention: string;
  resolve(file: string, importer: string): string;
}
type IPostcssModules = (options: IModulesOptions) => unknown;
/** autoprefixer, given the browsers to prefix for. */
type IAutoprefixer = (options: { overrideBrowserslist: string }) => unknown;
/**
 * @return the TypeScript shim for a css-module: an ES module importing the
 * stylesheet it belongs to (`./<basename>`, so a bundler includes the CSS) and
 * default-exporting the class-name map, typed. It is an input of the compile,
 * which emits it in the compile's module format.
 */
export function cssModuleShim(cssName: string, tokens: Record<string, string>): string {
  const basename = cssName.split("/").pop() ?? cssName;
  const specifier = JSON.stringify(`./${basename}`);
  const locals = Object.keys(tokens).sort();
  const members = locals.map(local => `  readonly ${JSON.stringify(local)}: string;`);
  const entries = locals.map(local => `  ${JSON.stringify(local)}: ${JSON.stringify(tokens[local])},`);
  return [`import ${specifier};`, "const styles: {", ...members, "} = {", ...entries, "};", "export default styles;", ""].join("\n");
}

/**
 * Make the error reporting a postcss failure processing `rel`, at the position
 * the author wrote: `<file>:<line>:<column>: css-modules: <message>`. Where the
 * error has an `input` origin (a CssSyntaxError's position mapped through the
 * input's source map) and `where` is given, that origin names it: the `.scss`
 * file where Sass ran first, relative to the staged root, or its basename
 * outside it. Otherwise `rel` and the error's own position, where it has one.
 */
export function scopeFailure(rel: string, err: unknown, where?: { root: string; srcRoot: string }): Error {
  const reported = err as {
    reason?: string;
    message?: string;
    line?: number;
    column?: number;
    input?: { file?: string; line?: number; column?: number };
  };
  const message = reported?.reason ?? reported?.message ?? String(err);
  const origin = reported?.input;
  if (where !== undefined && origin?.file !== undefined && origin.line !== undefined) {
    const staged = `${toPosix(path.resolve(where.root, where.srcRoot))}/`;
    const resolved = toPosix(path.resolve(origin.file));
    const name = resolved.startsWith(staged) ? resolved.substring(staged.length) : path.posix.basename(resolved);
    return new Error(`${name}:${origin.line}:${origin.column ?? 1}: css-modules: ${message}`);
  }
  const at = reported?.line === undefined ? rel : `${rel}:${reported.line}:${reported.column ?? 1}`;
  return new Error(`${at}: css-modules: ${message}`);
}

/** The scope of every stylesheet a step may scope, by absolute path: each of
 * its inputs, and each dependency stylesheet a compose may name. A plain
 * stylesheet is among them, since a compose may name it. */
export type ScopeTable = Map<string, string>;

/** A dependency's stylesheet by the specifier naming it (`<package>/<path>`),
 * as the file the step staged for it. */
export type PackageStylesheets = ReadonlyMap<string, string>;

/** @return the specifier naming a composable stylesheet of a dependency. */
export function composableSpecifier(entry: IPostcssOptions["composable"][number]): string {
  return `${entry.package}/${entry.path}`;
}

/** Make the scope table for `options`, the dependency stylesheets located in
 * `packages`; one `packages` does not locate is left out. */
export function scopeTableOf(options: IPostcssOptions, packages: PackageStylesheets = new Map()): ScopeTable {
  return new Map([
    ...options.sources.map((source): [string, string] => [path.resolve(options.srcRoot, source.path), source.scope]),
    /* A dependency's stylesheet, which a compose may reach but the step does
     * not write. */
    ...options.composable.flatMap((entry): [string, string][] => {
      const file = packages.get(composableSpecifier(entry));
      return file === undefined ? [] : [[path.resolve(file), entry.scope]];
    }),
  ]);
}

/**
 * @return the scoped name of one local class: `<local>_<scope>`, the scope of
 * `filename`, the file postcss-modules is naming (while resolving a compose,
 * the composed file, not the one being processed). Throws where `filename` is
 * not in the table.
 */
export function scopedNameOf(table: ScopeTable, srcRoot: string, local: string, filename: string): string {
  const scope = table.get(path.resolve(filename));
  if (scope === undefined) {
    throw new Error(
      `composes: '${displayName(filename, srcRoot)}' is not a stylesheet of this compilation — ` +
        `a class can only compose from a stylesheet built in the same target`
    );
  }
  return `${local}_${scope}`;
}

/**
 * Resolve a compose specifier (`composes: x from '<specifier>'`) to the file it
 * names, a Sass source's name taken as its lowered one ({@link sassLoweredName}):
 * a relative specifier against the importer's directory, any other in
 * `packages`. Throws, naming the specifier and the importer, where the file is
 * not in the scope table (a Sass partial, a file no dependency provides).
 */
export function resolveComposePath(
  table: ScopeTable,
  srcRoot: string,
  file: string,
  importer: string,
  packages: PackageStylesheets
): string {
  const lowered = sassLoweredName(file);
  /* A relative specifier names a sibling of the importer; anything else names
   * a dependency's stylesheet. */
  const resolved = lowered.startsWith(".") ? path.resolve(path.dirname(path.resolve(importer)), lowered) : packages.get(lowered);
  if (resolved === undefined || !table.has(resolved)) {
    throw new Error(
      `composes: '${file}' (in '${displayName(importer, srcRoot)}') does not name a stylesheet this target can reach — ` +
        `a class composes from a stylesheet of the same target, or one a package dependency delivers`
    );
  }
  return resolved;
}

/** @return a file's display name: its path relative to the staged root where it
 * lies under it, otherwise its basename. */
function displayName(filename: string, srcRoot: string): string {
  const staged = `${toPosix(path.resolve(srcRoot))}/`;
  const resolved = toPosix(path.resolve(filename));
  return resolved.startsWith(staged) ? resolved.substring(staged.length) : path.posix.basename(resolved);
}

/** What processing a stylesheet uses, made once per run. */
interface IPostcssTools {
  postcss: IPostcss;
  modules: IPostcssModules;
  /** autoprefixer configured for the build's browsers, or empty where it names
   * none: the last plugin every stylesheet runs. */
  prefixer: unknown[];
  /** How a staged source is named in a map, where the step staged a table. */
  referenceOf?: (staged: string, own?: string) => string | undefined;
  /** The dependencies' stylesheets a compose may name. */
  packages: PackageStylesheets;
  /** Called with each stylesheet a compose resolved to. */
  onCompose?: (resolved: string) => void;
}

/**
 * Process one stylesheet input and write everything the options document names
 * for it: the stylesheet, its map where one is named (chained through the
 * input's `prev` map where it has one), and a css-module's shim. Rejects with
 * {@link scopeFailure}'s error where postcss fails.
 */
async function processFile(source: IPostcssSource, options: IPostcssOptions, tools: IPostcssTools, table: ScopeTable): Promise<void> {
  const inputPath = path.join(options.srcRoot, source.path);
  const css = fs.readFileSync(inputPath, "utf8");
  const wantsMap = source.map !== undefined;
  /* The map the input arrived with, where Sass ran before this step; read only
   * where the step writes a map. */
  const prev =
    !wantsMap || source.prev === undefined
      ? undefined
      : parseJson(fs.readFileSync(path.join(options.srcRoot, source.prev), "utf8"), source.prev, toRawSourceMap);
  /* Carry the input map's fabr references past postcss (see
   * carriedReferences). */
  const chained = prev === undefined || tools.referenceOf === undefined ? prev : carriedReferences(prev);
  let exported: Record<string, string> = {};
  const scoping = source.module
    ? [
        tools.modules({
          generateScopedName: (local: string, filename: string): string => scopedNameOf(table, options.srcRoot, local, filename),
          getJSON: (_file: string, json: Record<string, string>): void => {
            exported = json;
          },
          /* Both spellings, literal and camelCase (`.header-bar` read as
           * `styles.headerBar`). */
          localsConvention: "camelCase",
          resolve: (file: string, importer: string): string => {
            const resolved = resolveComposePath(table, options.srcRoot, file, importer || inputPath, tools.packages);
            tools.onCompose?.(resolved);
            return resolved;
          },
        }),
      ]
    : [];
  let scoped: IPostcssResult;
  try {
    scoped = await tools.postcss([...scoping, ...tools.prefixer]).process(css, {
      from: inputPath,
      to: path.join(options.outdir, source.css),
      /* Name the annotation, not `false`: only then does postcss remove every
       * annotation in the root (a composed stylesheet's included) and write
       * this step's own. */
      ...(wantsMap ? { map: { ...(chained ? { prev: chained } : {}), inline: false, annotation: annotationName(source.map!) } } : {}),
    });
  } catch (err) {
    throw scopeFailure(source.path, err, { root: process.cwd(), srcRoot: options.srcRoot });
  }

  const outMap = scoped.map?.toJSON();
  if (source.map !== undefined && outMap !== undefined) {
    const where = { root: process.cwd(), srcRoot: options.srcRoot, mapDir: path.dirname(path.join(options.outdir, source.css)) };
    /* A chained input is an intermediate: name its entry as the output. */
    const ownInput = prev === undefined ? undefined : { path: source.path, rename: source.css };
    /* postcss lists the sources in the order the output first reaches each:
     * put the stylesheet compiled first, which is the input map's first
     * source, or with no input map the input itself. */
    const compiled =
      chained === undefined
        ? path.resolve(where.root, inputPath)
        : chained.sources[0] === undefined
          ? undefined
          : sourceIdentity(chained.sources[0], where.root, path.dirname(path.join(options.srcRoot, source.prev!)));
    const ordered = compiled === undefined ? outMap : withSourceFirst(outMap, compiled, where.root, where.mapDir);
    const finished =
      tools.referenceOf === undefined
        ? relativeToMap(relocateCssSources(ordered, where, ownInput), source.map)
        : referencedCssSources(ordered, source.map, where, tools.referenceOf, ownInput);
    writeOut(options.outdir, source.map, JSON.stringify(finished));
  }
  /* With no map, postcss was asked for no annotation and removed none: remove
   * the inputs' here. */
  writeOut(options.outdir, source.css, source.map === undefined ? withoutAnnotations(scoped.css) : scoped.css);
  if (source.shim !== undefined) {
    writeOut(options.outdir, source.shim, cssModuleShim(source.css, exported));
  }
}

/** Process every stylesheet the options document lists, then write the deps
 * report where `argv` asks for one. Rejects with the first failure. */
export async function main(argv: string[]): Promise<void> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const postcss = require("postcss") as IPostcss;
  const modules = require("postcss-modules") as IPostcssModules;
  const autoprefixer = require("autoprefixer") as IAutoprefixer;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv, "postcss-driver"), "utf8")) as IPostcssOptions;
  /* Silence browserslist's warning that its data is old: the data is a pinned
   * input. */
  process.env.BROWSERSLIST_IGNORE_OLD_DATA = "1";
  const prefixer = options.browsers === "" ? [] : [autoprefixer({ overrideBrowserslist: options.browsers })];
  /* Locate each composable stylesheet through the step's PnP table: `packages`
   * holds its physical path, which is read, and `located` maps that back to
   * the location the table gives it, which is reported. */
  const resolver = PnpResolver.load(process.cwd(), []);
  const issuer = `${process.cwd()}${path.sep}`;
  const packages = new Map<string, string>();
  const located = new Map<string, string>();
  for (const entry of options.composable) {
    const at = resolver?.resolveToUnqualified(composableSpecifier(entry), issuer, { considerBuiltins: false });
    if (at !== undefined && at !== null) {
      const file = path.resolve(resolver?.resolveVirtual(at) ?? at);
      packages.set(composableSpecifier(entry), file);
      located.set(file, at);
    }
  }
  const table = scopeTableOf(options, packages);
  /* Where the step staged a source-paths table, maps name each source by its
   * reference. */
  const referenceOf = stagedReferences(argv, process.cwd());
  /* The run's reads of its packages: the dependency stylesheets a compose
   * reached. */
  const reads = new Set<string>();
  const onCompose = (resolved: string): void => {
    const at = located.get(resolved);
    if (at !== undefined) {
      reads.add(at);
    }
  };
  for (const source of options.sources) {
    await processFile(source, options, { postcss, modules, prefixer, referenceOf, packages, onCompose }, table);
  }
  writeDepsReport(argv, resolver?.readSetOf(reads) ?? [], resolver?.edges());
}
