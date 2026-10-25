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
 * Fabr's postcss driver: the runtime executed (standalone, under node) inside a
 * css_postcss build step. Its inputs are plain CSS — Sass sources arrive
 * already lowered by the sass_compile step, `.module.` marker intact — and it
 * runs the postcss chain over them, of which css-modules is the first plugin:
 * a css-module is scoped (every local renamed `<local>_<scope>`) and written
 * under its final name beside a TypeScript shim carrying its class-name map —
 * which types the map as well as holding it, so nothing declares it twice; any
 * other stylesheet is copied through unchanged. Source maps chain: the map an input arrived with
 * rides the options document as `prev`, so a position in the scoped output
 * resolves through the rename AND through Sass's nesting expansion, back to
 * the line the author wrote. A step ships only annotations it wrote: whatever
 * an input carried names ITS map, which is a different file from the one
 * published here, so it is cleared and this step's own written in its place.
 *
 * **The driver names nothing.** Every output path, and each module's scope
 * suffix, arrives in the options document (see CSSCompile.ts /
 * IPostcssOptions); this file writes what it is told to.
 *
 * Cross-file `composes` resolves against this step's own inputs, or — for a
 * package-shaped specifier — against the dependency stylesheets the options
 * list, located through the PnP table the step stages beside the sources. A
 * specifier naming a Sass source (`composes: x from './b.module.scss'`) maps to
 * the lowered input beside the importer, and every class is scoped with its own
 * file's scope — whichever file's run names it. Any reachable stylesheet is
 * composable, a plain one included: its rules arrive in the importer as a
 * scoped private copy, while its own output keeps its names as written. A
 * specifier naming nothing reachable — a Sass partial, a file no dependency
 * delivers — fails loudly.
 *
 * Usage: fabr-postcss --manifest=<options.json> [--deps-report <file>]
 * [--source-paths <file>]
 *
 * Runs in the *build* process, not in fabr: it `require`s postcss and
 * postcss-modules from its own staged node_modules and must not depend on
 * @fabr-build/core at runtime (the IPostcssOptions import is type-only, erased
 * at compile). The tools are required lazily inside {@link main} so the pure
 * helpers stay importable without them installed.
 *
 * The bundler stays dumb about CSS: this driver produces plain, already-scoped
 * CSS; esbuild concatenates/orders/splits it via the JS import graph. The
 * driver never concatenates or orders CSS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IPostcssOptions, IPostcssSource } from "./Options";
import { PnpResolver } from "../pnp/PnPResolver";
import { stagedReferences } from "../support/SourceMap";
import {
  annotationName,
  carriedReferences,
  IRawSourceMap,
  parseManifestPath,
  referencedCssSources,
  relativeToMap,
  relocateCssSources,
  sassLoweredName,
  sourceMapComment,
  withoutAnnotations,
  writeDepsReport,
  writeOut,
} from "./Support";

/* Minimal structural typing for the slice of postcss and postcss-modules this
 * driver uses — they are not fabr dependencies (fetched at build time), so
 * their own types are not available here; this mirrors the documented shape. */
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
/** The subset of postcss-modules' options this driver sets. `getJSON` doubles as
 * the suppression of its default behaviour, which is to write a `.json` beside
 * the stylesheet; `resolve` is the compose-specifier seam. */
interface IModulesOptions {
  generateScopedName(local: string, filename: string, css: string): string;
  getJSON(filename: string, tokens: Record<string, string>): void;
  localsConvention: string;
  resolve(file: string, importer: string): string;
}
type IPostcssModules = (options: IModulesOptions) => unknown;

/**
 * @return the JS shim for a css-module: the class-name map as an ES module,
 * plus a side-effect import of the stylesheet it belongs to.
 *
 * The import is how a bundler learns the CSS belongs in the output, and how a
 * test runner's asset stub knows to ignore it. Emitted as ESM: the shim is a
 * compile INPUT, not a delivered artifact, so tsc restates it in whatever module
 * system the compile emits and the stylesheet import goes through the same
 * specifier machinery as everything else.
 */
export function cssModuleShim(cssName: string, tokens: Record<string, string>): string {
  const basename = cssName.split("/").pop() ?? cssName;
  const specifier = JSON.stringify(`./${basename}`);
  const locals = Object.keys(tokens).sort();
  const members = locals.map(local => `  readonly ${JSON.stringify(local)}: string;`);
  const entries = locals.map(local => `  ${JSON.stringify(local)}: ${JSON.stringify(tokens[local])},`);
  return [
    `import ${specifier};`,
    "const styles: {",
    ...members,
    "} = {",
    ...entries,
    "};",
    "export default styles;",
    "",
  ].join("\n");
}

/**
 * Attribute a scoping failure to the stylesheet's author. postcss's
 * CssSyntaxError carries, beside the position in the text it parsed, an
 * `input` member holding the ORIGIN — the position mapped through the input's
 * own source map — so where Sass ran first the failure names the `.scss` file
 * and line the author wrote. Without an origin (an authored stylesheet, or an
 * unpositioned error) the input's own name and position stand.
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
    const staged = `${path.resolve(where.root, where.srcRoot)}/`;
    const resolved = path.resolve(origin.file);
    const name = resolved.startsWith(staged) ? resolved.substring(staged.length) : path.basename(resolved);
    return new Error(`${name}:${origin.line}:${origin.column ?? 1}: css-modules: ${message}`);
  }
  const at = reported?.line === undefined ? rel : `${rel}:${reported.line}:${reported.column ?? 1}`;
  return new Error(`${at}: css-modules: ${message}`);
}

/** The staged-path → scope table: every stylesheet input of this step and
 * every dependency stylesheet a compose may name, keyed by resolved path,
 * carrying the scope its classes take when they are scoped. What both compose
 * hooks consult — a plain stylesheet is composable too, its rules
 * arriving in the importer as a scoped private copy. */
export type ScopeTable = Map<string, string>;

/** A dependency's stylesheet by the specifier naming it (`<package>/<path>`),
 * as the file the step staged for it. */
export type PackageStylesheets = ReadonlyMap<string, string>;

/** @return the specifier naming a composable stylesheet of a dependency. */
export function composableSpecifier(entry: IPostcssOptions["composable"][number]): string {
  return `${entry.package}/${entry.path}`;
}

export function scopeTableOf(options: IPostcssOptions, packages: PackageStylesheets = new Map()): ScopeTable {
  return new Map([
    ...options.sources.map((source): [string, string] => [path.resolve(options.srcRoot, source.path), source.scope]),
    /* A dependency's stylesheets are readable but never published here: they
     * are in the table so a compose can reach them, and absent from `sources`
     * so this step writes nothing for them. */
    ...options.composable.flatMap((entry): [string, string][] => {
      const file = packages.get(composableSpecifier(entry));
      return file === undefined ? [] : [[path.resolve(file), entry.scope]];
    }),
  ]);
}

/**
 * @return the scoped name of one local class: `<local>_<scope of the file that
 * declares it>`, the scope looked up by the file postcss-modules is naming —
 * which during compose resolution is the *composed* file, not the one whose
 * run this is. A file absent from the table is no stylesheet of this
 * compilation at all.
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
 * Resolve a compose specifier (`composes: x from '<specifier>'`) to the staged
 * input it names: a specifier written against a Sass source maps to the
 * lowered input beside the importer ({@link sassLoweredName}, the rule the
 * resolve rules encode). The mapped path must be in the scope table — a
 * stylesheet of this step, or one a package dependency hands this step; anything
 * else (a Sass partial, a file no dependency provides) is refused with the
 * specifier and the importer named, never a bare ENOENT.
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

/** @return a file's display name: its staged-root-relative path where it has
 * one, its basename otherwise. */
function displayName(filename: string, srcRoot: string): string {
  const staged = `${path.resolve(srcRoot)}/`;
  const resolved = path.resolve(filename);
  return resolved.startsWith(staged) ? resolved.substring(staged.length) : path.basename(resolved);
}

/** What the tools this driver runs are, resolved once and passed down. */
interface IPostcssTools {
  postcss: IPostcss;
  modules: IPostcssModules;
  /** How a staged source is named in a map, where the step staged a table. */
  referenceOf?: (staged: string, own?: string) => string | undefined;
  /** The dependencies' stylesheets a compose may name. */
  packages: PackageStylesheets;
  /** Told each stylesheet a compose resolved to. */
  onCompose?: (resolved: string) => void;
}

/**
 * Process one stylesheet input and write everything the options document names
 * for it. A css-module is scoped (its map chained through the input map the
 * options name as `prev`); anything else is copied through unchanged, its map
 * carried beside it.
 */
async function processFile(source: IPostcssSource, options: IPostcssOptions, tools: IPostcssTools, table: ScopeTable): Promise<void> {
  const inputPath = path.join(options.srcRoot, source.path);
  if (!source.module) {
    /* Copied through, with the annotation restated for the map this step
     * writes — never the input's, which named the input's own map. */
    const copied = withoutAnnotations(fs.readFileSync(inputPath, "utf8"));
    if (source.map !== undefined) {
      const carried = JSON.parse(fs.readFileSync(path.join(options.srcRoot, source.map), "utf8")) as IRawSourceMap;
      const mapDir = path.dirname(path.join(options.srcRoot, source.map));
      const where = { root: process.cwd(), srcRoot: options.srcRoot, mapDir };
      const finished =
        tools.referenceOf === undefined
          ? relativeToMap(relocateCssSources(carried, where), source.map)
          : referencedCssSources(carried, source.map, where, tools.referenceOf);
      writeOut(options.outdir, source.map, JSON.stringify(finished));
      writeOut(options.outdir, source.css, copied + sourceMapComment(source.map));
    } else {
      writeOut(options.outdir, source.css, copied);
    }
    return;
  }

  const css = fs.readFileSync(inputPath, "utf8");
  const wantsMap = source.map !== undefined;
  /* Whether Sass ran before this step: the lowered input arrives with its map
   * beside it, named by the options document for the output map to chain
   * through. Read only where an output map will carry the chain. */
  const prev =
    !wantsMap || source.prev === undefined
      ? undefined
      : (JSON.parse(fs.readFileSync(path.join(options.srcRoot, source.prev), "utf8")) as IRawSourceMap);
  /* postcss would mangle the input map's fabr references while composing it
   * (see carriedReferences), so they cross it carried. */
  const chained = prev === undefined || tools.referenceOf === undefined ? prev : carriedReferences(prev);
  let scoped: IPostcssResult;
  let exported: Record<string, string> = {};
  try {
    scoped = await tools
      .postcss([
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
      ])
      .process(css, {
        from: inputPath,
        to: path.join(options.outdir, source.css),
        /* Naming the annotation (rather than `false`) is what makes postcss
         * CLEAR the annotations its inputs carried — every one in the root, so
         * a composed stylesheet's rides out with the rules it inlined — and
         * write this step's own in their place. */
        ...(wantsMap ? { map: { ...(chained ? { prev: chained } : {}), inline: false, annotation: annotationName(source.map!) } } : {}),
      });
  } catch (err) {
    throw scopeFailure(source.path, err, { root: process.cwd(), srcRoot: options.srcRoot });
  }

  const outMap = scoped.map?.toJSON();
  if (source.map !== undefined && outMap !== undefined) {
    const where = { root: process.cwd(), srcRoot: options.srcRoot, mapDir: path.dirname(path.join(options.outdir, source.css)) };
    /* Chained, the input is an intermediate whose name never ships; unchained,
     * the input IS the authored source and keeps its name. */
    const ownInput = prev === undefined ? undefined : { path: source.path, rename: source.css };
    const finished =
      tools.referenceOf === undefined
        ? relativeToMap(relocateCssSources(outMap, where, ownInput), source.map)
        : referencedCssSources(outMap, source.map, where, tools.referenceOf, ownInput);
    writeOut(options.outdir, source.map, JSON.stringify(finished));
  }
  /* With no map of its own to name, postcss is not asked for an annotation and
   * so clears none: whatever the inputs carried is stripped here instead. */
  writeOut(options.outdir, source.css, source.map === undefined ? withoutAnnotations(scoped.css) : scoped.css);
  if (source.shim !== undefined) {
    writeOut(options.outdir, source.shim, cssModuleShim(source.css, exported));
  }
}

export async function main(argv: string[]): Promise<void> {
  // The tools are fetched at build time and mounted in this step's
  // node_modules, so they are required (not imported) — their types are not
  // available to compile.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const postcss = require("postcss") as IPostcss;
  const modules = require("postcss-modules") as IPostcssModules;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv, "postcss-driver"), "utf8")) as IPostcssOptions;
  /* The dependencies are a table beside the sources, nothing mounted: each
   * composable stylesheet is located through it, as the sources see it. A file
   * is read where its bytes are, and reported as the table locates it. */
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
  /* Its maps name each source by the reference resolving to it, where the step
   * staged their table. */
  const referenceOf = stagedReferences(argv, process.cwd());
  /* A dependency's stylesheet is read only where a compose reaches it, so those
   * are the run's reads of the packages it was given. */
  const reads = new Set<string>();
  const onCompose = (resolved: string): void => {
    const at = located.get(resolved);
    if (at !== undefined) {
      reads.add(at);
    }
  };
  for (const source of options.sources) {
    await processFile(source, options, { postcss, modules, referenceOf, packages, onCompose }, table);
  }
  writeDepsReport(argv, resolver?.readSetOf(reads) ?? [], resolver?.edges());
}
