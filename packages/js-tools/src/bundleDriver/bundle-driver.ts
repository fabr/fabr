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
 * Fabr's bundle driver (`fabr-bundle`), run in a js_bundle build step. It reads
 * the options document fabr staged (see JSBundle.ts and IBundleOptions), runs
 * esbuild's build with fabr's resolver plugin, and writes the bundle and its
 * metafile to the output directory, naming each source by its reference where
 * one is known: in the metafile and the outputs' module comments, and in the
 * maps where the step staged a source-paths table. A failed build's messages
 * are written to stderr, and the exit code set to 1.
 *
 * Usage: fabr-bundle --options=<options.json> [--source-paths <file>]
 *
 * The resolver plugin:
 *  - Externalizes a bare import of a declared dependency (its import is kept
 *    as written). A code import that resolves nowhere and names no dependency
 *    is left to esbuild, which decides whether it is fatal; a failure it
 *    reports gets fabr's srcs/deps advice. An asset reference (a CSS `url()`)
 *    that resolves nowhere is left as an external URL.
 *  - Resolves each package to one file whatever the importer's kind, so a
 *    package with both ESM and CommonJS entries is bundled once: a bare
 *    specifier resolves under the bundle's own format's kind first, and the
 *    answer is cached per importing directory (per package, under a PnP table)
 *    and reused for every kind.
 *
 * Runs in the step's own process: do not depend on @fabr-build/core at
 * runtime. esbuild comes from the step's own installation and is required only
 * inside {@link main}, so the other exports load without it (for the unit
 * tests).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SourceMap } from "node:module";
import { PNP_DATA_FILE, PnpResolver, readManifest } from "../pnp/PnPResolver";
import { resolveVirtual } from "../pnp/VirtualPath";
import { getMapSource, referenceOfEntry, stagedReferences, withReferencedSources } from "../support/SourceMap";
import { BUNDLE_METAFILE, type IBundleOptions } from "./BundleOptions";
import { type IMetafile, renameMetafilePaths } from "./Metafile";
import { posixRelative, toPosix } from "../support/Paths";

/* The parts of esbuild's API the driver uses, typed structurally from its
 * documentation: it is no compile-time dependency of this package. */
interface ILocation {
  file: string;
  namespace?: string;
  line: number;
  column: number;
  length?: number;
  lineText?: string;
  suggestion?: string;
}
interface IMessage {
  text: string;
  location?: ILocation | null;
  notes?: Array<{ text: string; location?: ILocation | null }>;
}
interface IOnResolveArgs {
  path: string;
  importer: string;
  kind: string;
  resolveDir: string;
  pluginData?: unknown;
}
interface IOnResolveResult {
  path?: string;
  external?: boolean;
  namespace?: string;
  errors?: IMessage[];
  pluginData?: unknown;
}
interface IResolveResult {
  path: string;
  external: boolean;
  namespace: string;
  errors: IMessage[];
}
interface IOnLoadArgs {
  path: string;
}
interface IOnLoadResult {
  contents?: string | Uint8Array;
  loader?: string;
}
interface IPluginBuild {
  onResolve(
    options: { filter: RegExp; namespace?: string },
    callback: (args: IOnResolveArgs) => IOnResolveResult | null | Promise<IOnResolveResult | null>
  ): void;
  onLoad(
    options: { filter: RegExp; namespace?: string },
    callback: (args: IOnLoadArgs) => IOnLoadResult | null | Promise<IOnLoadResult | null>
  ): void;
  resolve(
    specifier: string,
    options: { kind: string; importer?: string; resolveDir?: string; pluginData?: unknown }
  ): Promise<IResolveResult>;
}
interface IPlugin {
  name: string;
  setup(build: IPluginBuild): void;
}
interface IBuildResult {
  errors: IMessage[];
  warnings: IMessage[];
  /** Present on every build here, which sets `metafile: true`. */
  metafile?: IMetafile;
}
interface IEsbuild {
  build(options: Record<string, unknown>): Promise<IBuildResult>;
  formatMessages(messages: IMessage[], options: { kind: "error" | "warning"; color?: boolean }): Promise<string[]>;
}

/** The extensions esbuild loads itself, as code or text. A bundled file with
 * any other extension is emitted as a file asset (hashed, its import rewritten
 * to the URL). */
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".css", ".json", ".txt"]);

/** The conditions the bundle gives esbuild beside its own (see {@link toEsbuildOptions}). */
const EXTRA_CONDITIONS = ["module", "module-sync"];

/** The import kinds that reference an asset (a URL in a stylesheet) rather
 * than code: one that resolves nowhere is left as an external URL. */
const ASSET_KINDS = new Set(["url-token"]);

/** The import kinds written in a stylesheet rather than in JavaScript, whose
 * specifier names a stylesheet, never a JS module. */
const STYLESHEET_KINDS = new Set(["import-rule", "composes-from", "url-token"]);

/** Get the package name a bare specifier belongs to (`lodash/fp` → `lodash`,
 * `@scope/pkg/sub` → `@scope/pkg`). */
export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** @return true if a specifier is a bare package import (not a relative or
 * absolute path), otherwise false. */
export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

/**
 * @return the name the css steps give a Sass source's output: the Sass
 * extension becomes `.css`, and a `.module.` marker is dropped
 * (`x.module.scss` → `x.css`). Any other specifier is returned as it is.
 *
 * Only code the compile did not touch imports a Sass source by its own name:
 * hand-written JavaScript in a bundle's own `srcs`, and vendored code. The
 * compile renames a compiled source's imports itself.
 */
export function rewriteStyledImport(specifier: string): string {
  return specifier.replace(/\.module\.(scss|sass)$/i, ".css").replace(/\.(scss|sass)$/i, ".css");
}

/**
 * @return the shim (`<stylesheet>.js`) the css step wrote beside a scoped
 * stylesheet, holding its class-name map, or undefined where there is none.
 *
 * fabr's scoped output is named `x.css`, so esbuild's `local-css` loader never
 * scopes it again; a dependency's own `.module.css` has no shim, and that
 * loader scopes it.
 */
function scopedShimFor(cssPath: string): string | undefined {
  const shim = `${cssPath}.js`;
  return fs.existsSync(shim) ? shim : undefined;
}

/**
 * Make fabr's resolver plugin (see the file's doc). Bare specifiers resolve
 * under the kind of the bundle's own format first (`require-call` for `cjs`,
 * otherwise `import-statement`). Each bare specifier the plugin leaves to
 * esbuild unresolved is added to `unresolved`, for {@link unresolvedHelp}.
 */
function fabrResolverPlugin(options: IBundleOptions, unresolved: Set<string>): IPlugin {
  const external = new Set(options.external);
  const nativeKind = options.format === "cjs" ? "require-call" : "import-statement";
  const otherKind = nativeKind === "require-call" ? "import-statement" : "require-call";
  /* One answer per bare specifier, whatever the importer's kind, keyed by
   * what resolution depends on: the importing directory under node's own
   * search (two importers under nested installs may reach different copies),
   * or the importing package's tree under a PnP table, which answers a bare
   * specifier by package. */
  const byPackage = usesManifest();
  const variantCache = new Map<string, IOnResolveResult>();
  /* Read for which package directory each importer sees, and for
   * variantFromTable; {@link PnpResolver.locationOf} takes no conditions. */
  const manifest = byPackage ? PnpResolver.load(process.cwd(), []) : undefined;
  const kindMatters = new Map<string, boolean>();

  /**
   * @return true if the importer's kind may change which file the package a
   * specifier names answers with, otherwise false. It cannot where the package
   * has no `exports` map (esbuild then reads `mainFields`, whatever the kind),
   * or its map never mentions a kind's condition ({@link mentionsKind}). True
   * wherever it cannot tell: no PnP table, no location for the package, or an
   * unreadable `package.json`. Memoized per package location.
   */
  function kindCanMatter(specifier: string, importer: string): boolean {
    if (manifest === undefined) {
      return true;
    }
    const location = manifest.locationOf(packageOf(specifier), importer);
    if (location === undefined) {
      return true;
    }
    const known = kindMatters.get(location);
    if (known !== undefined) {
      return known;
    }
    const json = readManifest(location);
    const matters = json === undefined || (json.exports !== undefined && json.exports !== null && mentionsKind(json.exports));
    kindMatters.set(location, matters);
    return matters;
  }

  return {
    name: "fabr-resolver",
    setup(build: IPluginBuild): void {
      build.onResolve({ filter: /.*/ }, async (args): Promise<IOnResolveResult | null> => {
        /* build.resolve runs plugins again: leave this plugin's own calls,
         * marked `fabr`, to esbuild's resolution. */
        if (args.pluginData && (args.pluginData as { fabr?: boolean }).fabr) {
          return null;
        }

        /* An asset reference (a CSS `url()`) that names a file is esbuild's to
         * emit; any other is left as an external URL. */
        if (ASSET_KINDS.has(args.kind) && !isBareSpecifier(args.path)) {
          return assetOnDisk(args.path, args.resolveDir) ? null : { path: args.path, external: true };
        }
        if (ASSET_KINDS.has(args.kind)) {
          const probe = await build.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: { fabr: true },
          });
          return probe.errors.length ? { path: args.path, external: true } : null;
        }

        /* A relative or absolute import is esbuild's to resolve, bar a Sass
         * source's, which is redirected to the css steps' output. */
        if (!isBareSpecifier(args.path)) {
          const rewritten = rewriteStyledImport(args.path);
          if (rewritten === args.path) {
            return null;
          }
          return redirectStyledImport(build, args, rewritten);
        }

        /* In a browser bundle, resolve `node:<module>` as `<module>`, so a
         * substitute for the built-in bundled under that name answers both. */
        if (options.platform === "browser" && args.path.startsWith("node:")) {
          const unprefixed = await build.resolve(args.path.slice("node:".length), {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
          });
          if (unprefixed.errors.length) {
            /* Note the specifier as written, which is how esbuild reports it. */
            unresolved.add(args.path);
            return null;
          }
          return { path: unprefixed.path, external: unprefixed.external, namespace: unprefixed.namespace };
        }

        /* Externalize a declared dependency: its import is kept as written. */
        if (external.has(packageOf(args.path))) {
          return { path: args.path, external: true };
        }

        /* A Sass source named by a package subpath is redirected too. */
        const specifier = rewriteStyledImport(args.path);
        const variantKey = `${byPackage ? treeOf(args.resolveDir === undefined ? undefined : toPosix(args.resolveDir)) : args.resolveDir}\0${specifier}`;
        const cached = variantCache.get(variantKey);
        if (cached) {
          return cached;
        }

        if (specifier === args.path && !kindCanMatter(specifier, args.importer ?? args.resolveDir ?? "")) {
          /* esbuild's own resolution gives the same answer. */
          return null;
        }
        const resolved =
          (manifest !== undefined && specifier === args.path
            ? variantFromTable(manifest, specifier, args.importer || `${args.resolveDir}/`, [nativeKind, otherKind], options.platform)
            : undefined) ?? (await resolveSingleVariant(build, { ...args, path: specifier }, nativeKind, otherKind));
        /* Leave an answer that is no file to esbuild (a module a package's
         * `browser` field maps to false comes back as its bare name): esbuild
         * makes it an empty module. */
        if (
          resolved &&
          (!resolved.namespace || resolved.namespace === "file") &&
          resolved.path !== undefined &&
          !path.isAbsolute(resolved.path)
        ) {
          return null;
        }
        if (resolved) {
          variantCache.set(variantKey, resolved);
          return resolved;
        }

        /* A bare code import that resolves nowhere and names no declared
         * dependency. Return no error: esbuild decides whether it is fatal (it
         * leaves a `require` inside a try/catch to fail at runtime), and a
         * plugin cannot tell which call sites those are. Note it, for the
         * advice a failure esbuild does report gets. */
        unresolved.add(args.path);
        return null;
      });

      /* Load a bundled file with an extension esbuild does not load itself
       * (fonts, images, …) as a file asset: emitted, its import rewritten to the
       * URL. */
      build.onLoad({ filter: /.*/ }, async (args): Promise<IOnLoadResult | null> => {
        /* A module with no file (one a `browser` field disables) is esbuild's to load, as empty. */
        if (CODE_EXTENSIONS.has(path.extname(args.path).toLowerCase()) || !path.isAbsolute(args.path)) {
          return null;
        }
        return { contents: new Uint8Array(await fs.promises.readFile(resolveVirtual(args.path))), loader: "file" };
      });
    },
  };
}

/**
 * Resolve a Sass source's import to the css steps' output for it, `rewritten`:
 * from JavaScript, to the shim beside a scoped stylesheet where there is one
 * (the stylesheet itself exports no class-name map), otherwise to the
 * stylesheet. Resolution errors are returned as the plugin's result.
 */
async function redirectStyledImport(build: IPluginBuild, args: IOnResolveArgs, rewritten: string): Promise<IOnResolveResult | null> {
  const resolved = await build.resolve(rewritten, {
    kind: args.kind,
    importer: args.importer,
    resolveDir: args.resolveDir,
    pluginData: { fabr: true },
  });
  if (resolved.errors.length) {
    return { errors: resolved.errors };
  }
  /* A stylesheet's own `@import`, `composes` or `url()` gets the stylesheet.
   * A side-effect `import "./x.module.scss"` gets the shim, which imports the
   * stylesheet itself. */
  const shim = STYLESHEET_KINDS.has(args.kind) ? undefined : scopedShimFor(resolved.path);
  return { path: shim ?? resolved.path, external: resolved.external, namespace: resolved.namespace };
}

/**
 * Resolve a bare specifier through esbuild under `nativeKind`, then under
 * `otherKind` where that fails (a package with only one of the two entries),
 * so every importer of it gets the same file. Undefined where neither
 * resolves.
 */
async function resolveSingleVariant(
  build: IPluginBuild,
  args: IOnResolveArgs,
  nativeKind: string,
  otherKind: string
): Promise<IOnResolveResult | undefined> {
  for (const kind of [nativeKind, otherKind]) {
    const result = await build.resolve(args.path, {
      kind,
      importer: args.importer,
      resolveDir: args.resolveDir,
      pluginData: { fabr: true },
    });
    if (!result.errors.length) {
      return { path: result.path, external: result.external, namespace: result.namespace };
    }
  }
  return undefined;
}

/**
 * Get the conditions esbuild resolves a package's `exports` under, for an
 * import of `kind` on `platform`: `default`, the platform's, the kind's and
 * {@link EXTRA_CONDITIONS}.
 */
export function conditionsFor(kind: string, platform: IBundleOptions["platform"]): ReadonlySet<string> {
  const byKind = kind === "require-call" || kind === "require-resolve" ? "require" : "import";
  return new Set(["default", platform, byKind, ...EXTRA_CONDITIONS]);
}

/**
 * Resolve a bare specifier through the staged PnP table, under the first of
 * `kinds` that answers, to the file esbuild's own resolution under that kind
 * would give where the package's `exports` map decides it. Undefined where the
 * table answers no file that exists, or the `exports` map is invalid, for
 * esbuild to resolve (and report) itself.
 */
function variantFromTable(
  resolver: PnpResolver,
  specifier: string,
  issuer: string,
  kinds: string[],
  platform: IBundleOptions["platform"]
): IOnResolveResult | undefined {
  for (const kind of kinds) {
    let file: string | undefined;
    try {
      file = resolver.resolveAll(specifier, issuer, conditionsFor(kind, platform))[0];
    } catch {
      return undefined;
    }
    if (file !== undefined && fs.existsSync(resolveVirtual(file))) {
      return { path: file };
    }
  }
  return undefined;
}

/** @return true if a relative or absolute CSS `url()` names a file, as esbuild
 * resolves one: as written, or without a `?`/`#` suffix; otherwise false. */
function assetOnDisk(specifier: string, resolveDir: string): boolean {
  const unsuffixed = specifier.replace(/[?#].*$/, "");
  return [specifier, unsuffixed].some(candidate => fs.existsSync(resolveVirtual(path.resolve(resolveDir, candidate))));
}

/** @return true if an `exports` map names `import`, `require` or `module-sync`
 * anywhere within it, otherwise false. */
export function mentionsKind(exports: unknown): boolean {
  if (Array.isArray(exports)) {
    return exports.some(mentionsKind);
  }
  if (typeof exports !== "object" || exports === null) {
    return false;
  }
  return Object.entries(exports as Record<string, unknown>).some(
    ([key, value]) => key === "import" || key === "require" || key === "module-sync" || mentionsKind(value)
  );
}

/** Get the tree in the tree pool a staged path (`/`-separated) lies in (`.fabr-tree/<hash>`, or
 * a virtual location `.fabr-tree/__virtual__/<variant>/<n>/<hash>`), which
 * under a PnP table is the importing package; or the path itself where it lies
 * outside the pool (the workspace's own sources, staged at the bundle root). */
export function treeOf(dir: string | undefined): string {
  const match = /^(.*\.fabr-tree\/(?:__virtual__\/[^/]+\/[^/]+\/)?[^/]+)/.exec(dir ?? "");
  return match ? match[1] : (dir ?? "");
}

/** @return true if the step staged a PnP table, which esbuild reads itself,
 * otherwise false. */
function usesManifest(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), PNP_DATA_FILE));
}

/** Make esbuild's build options for `options`, the resolver plugin adding to
 * `unresolved`. */
function toEsbuildOptions(options: IBundleOptions, unresolved: Set<string>): Record<string, unknown> {
  return {
    entryPoints: options.entries,
    entryNames: options.entryNames,
    outdir: options.outdir,
    /* The options' paths are relative to the step's working directory. State
     * it: esbuild's service otherwise uses the directory it started in. */
    absWorkingDir: process.cwd(),
    bundle: true,
    write: true,
    platform: options.platform,
    format: options.format,
    splitting: options.splitting,
    ...(options.splitting ? { chunkNames: options.chunkNames } : {}),
    assetNames: options.assetNames,
    metafile: true,
    target: options.target,
    minify: options.minify,
    sourcemap: options.sourcemap,
    logLevel: "silent",
    plugins: [fabrResolverPlugin(options, unresolved)],
    /* A `.module.css` is scoped, its class-name map exported to the importing
     * JavaScript; every other stylesheet keeps its names. */
    loader: { ".module.css": "local-css", ".css": "global-css" },
    /* Added to `default`, the platform's and the kind's: `module`, which
     * esbuild applies by default only while no conditions are set, and
     * `module-sync`, which fabr's compiler resolves too. */
    conditions: EXTRA_CONDITIONS,
    ...(options.define ? { define: options.define } : {}),
    ...(options.inject ? { inject: options.inject } : {}),
    /* Under a PnP table, keep the tree pool's link in each package's path:
     * esbuild finds the table by walking up from the importing file, and from
     * the pool's real location, outside the workspace, it would find none. */
    ...(usesManifest() ? { preserveSymlinks: true } : {}),
  };
}

/**
 * @return an esbuild failure's message with fabr's srcs/deps advice added for
 * each of `unresolved` the message names (quoted, as esbuild reports a
 * specifier); the message unchanged where it names none.
 */
export function unresolvedHelp(message: string, unresolved: Iterable<string>): string {
  const named = [...unresolved].filter(specifier => message.includes(`"${specifier}"`));
  if (named.length === 0) {
    return message;
  }
  return [
    message,
    ...named.map(
      specifier =>
        `fabr: '${specifier}' is neither bundled (add it, or its package, to 'srcs') nor a declared dependency (add it to 'deps')`
    ),
  ].join("\n");
}

/** @return the path `--options=` names. Throws where there is none. */
function parseOptionsPath(argv: string[]): string {
  const flag = argv.find(arg => arg.startsWith("--options="));
  if (!flag) {
    throw new Error("bundle-driver: missing --options=<path>");
  }
  return flag.substring("--options=".length);
}

/** Build the bundle the options document describes (see the file's doc). A
 * build that fails writes its messages to stderr and sets the exit code to 1;
 * rejects only where esbuild fails without messages. */
export async function main(argv: string[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const esbuild = require("esbuild") as IEsbuild;

  const options = JSON.parse(fs.readFileSync(parseOptionsPath(argv), "utf8")) as IBundleOptions;
  /* The bare specifiers the resolver plugin left unresolved. */
  const unresolved = new Set<string>();
  let errors: IMessage[];
  let metafile: IMetafile | undefined;
  try {
    const result = await esbuild.build(toEsbuildOptions(options, unresolved));
    errors = result.errors;
    metafile = result.metafile;
  } catch (err) {
    const failure = (err as { errors?: unknown }).errors;
    if (!Array.isArray(failure) || failure.length === 0) {
      throw new Error(unresolvedHelp(err instanceof Error ? err.message : String(err), unresolved));
    }
    errors = failure as IMessage[];
  }
  if (errors.length === 0) {
    const root = process.cwd();
    const named = stagedReferences(argv, root, { withinPackages: true });
    const referenceOf =
      named === undefined
        ? undefined
        : (staged: string): string | undefined => named(posixRelative(root, resolveVirtual(path.resolve(root, staged))));
    if (referenceOf !== undefined) {
      nameMapSources(root, options.outdir, referenceOf);
    }
    if (metafile !== undefined) {
      const inputName = metafileInputNamer(root, referenceOf);
      writeMetafile(options.outdir, metafile, inputName);
      nameModules(metafile, inputName);
    }
  }
  if (errors.length) {
    const resolver = usesManifest() ? PnpResolver.load(process.cwd(), []) : undefined;
    const rendered = await esbuild.formatMessages(readableMessages(errors, process.cwd(), resolver), { kind: "error", color: false });
    process.stderr.write(unresolvedHelp(rendered.join(""), unresolved).replace(/\n*$/, "\n"));
    process.exitCode = 1;
  }
}

/**
 * Name the sources of every map the bundle wrote under `outdir` by their
 * references (see withReferencedSources), `referenceOf` naming a path relative
 * to `root` by the step's table. An entry esbuild carried through from an
 * input's own map, already a reference, is kept.
 */
function nameMapSources(root: string, outdir: string, referenceOf: (staged: string) => string | undefined): void {
  for (const file of mapFilesUnder(path.resolve(root, outdir))) {
    fs.writeFileSync(file, withReferencedSources(fs.readFileSync(file, "utf8"), file, root, referenceOf));
  }
}

/**
 * Make the function naming each of the bundle's inputs, as esbuild spells them
 * (relative to `root`), as the bundle's maps name it: by the reference its own
 * map lists first (the file a compile made it from), else by `referenceOf`,
 * else as esbuild spells it. Memoized per input.
 */
function metafileInputNamer(
  root: string,
  referenceOf: ((staged: string) => string | undefined) | undefined
): (staged: string) => string {
  const fileName = (staged: string): string => {
    const source = getMapSource(resolveVirtual(path.resolve(root, staged)));
    return (source === undefined ? undefined : referenceOfEntry(source)) ?? referenceOf?.(staged) ?? staged;
  };
  const names = new Map<string, string>();
  /* esbuild writes an input outside its file namespace as `(<namespace>):<path>`
   * (`(disabled):` for a module a `browser` field maps to false): name the path
   * and keep the prefix. */
  return staged => {
    let name = names.get(staged);
    if (name === undefined) {
      const namespaced = /^(\([^)]+\)):(.*)$/.exec(staged);
      name = namespaced === null ? fileName(staged) : `${namespaced[1]}:${fileName(namespaced[2])}`;
      names.set(staged, name);
    }
    return name;
  };
}

/** Write esbuild's metafile beside the outputs, each input named by `inputName` and each output relative to `outdir`. */
function writeMetafile(outdir: string, metafile: IMetafile, inputName: (staged: string) => string): void {
  const renamed = renameMetafilePaths(metafile, outdir, inputName);
  fs.writeFileSync(path.resolve(process.cwd(), outdir, BUNDLE_METAFILE), JSON.stringify(renamed, null, 2) + "\n");
}

/**
 * Rename each module in the bundle's outputs from its staged path to
 * `inputName`'s name for it, in the comment line heading the module (`// <path>`
 * in JavaScript, `/* <path> *\/` in a stylesheet) and the key a wrapped module
 * is held under (`"<path>"(exports, module) {`). Only a path that is one of the
 * output's own inputs is renamed. A key is padded with spaces to the length it
 * had, so no mapped column moves, and is left as it is where the name is
 * longer.
 */
function nameModules(metafile: IMetafile, inputName: (staged: string) => string): void {
  const root = process.cwd();
  for (const [output, { inputs }] of Object.entries(metafile.outputs)) {
    if (inputs === undefined || !MODULE_PATH_OUTPUT.test(output)) {
      continue;
    }
    const isInput = (staged: string): boolean => Object.prototype.hasOwnProperty.call(inputs, staged);
    const file = path.resolve(root, output);
    const text = fs.readFileSync(file, "utf8");
    const commented = text.replace(MODULE_COMMENT, (line, indent: string, js?: string, css?: string) => {
      const staged = js ?? css;
      if (staged === undefined || !isInput(staged)) {
        return line;
      }
      return js !== undefined ? `${indent}// ${inputName(staged)}` : `${indent}/* ${inputName(staged)} */`;
    });
    const renamed = output.endsWith(".css")
      ? commented
      : commented.replace(MODULE_KEY, (key, staged: string) => {
          if (!isInput(staged)) {
            return key;
          }
          const named = JSON.stringify(inputName(staged));
          return named.length <= key.length ? named.padEnd(key.length) : key;
        });
    if (renamed !== text) {
      fs.writeFileSync(file, renamed);
    }
  }
}

/** Matches the outputs esbuild names modules in by their paths. */
const MODULE_PATH_OUTPUT = /\.(?:[cm]?js|css)$/;
/** Matches a line holding only a module's path comment: `// <path>` or `/* <path> *\/`. */
const MODULE_COMMENT = /^([ \t]*)(?:\/\/ (.+)|\/\* (.+) \*\/)$/gm;
/** Matches the string a wrapped module's function is keyed by: `"<path>"` directly before its `(`. */
const MODULE_KEY = /"([^"\\\n]+)"(?=\()/g;

/** List every `.map` file under `dir`. */
function mapFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? mapFilesUnder(full) : entry.name.endsWith(".map") ? [full] : [];
  });
}

/**
 * @return esbuild's messages with each location in a file mapped through that
 * file's own source map, where it has one, to the line that was written, and
 * named by the package it lies in (`ms@2.1.3/index.js`); a location outside
 * any package (the bundle's own sources) by its path relative to `cwd`. A note
 * located in the PnP data file is dropped ({@link unresolvedHelp} gives the
 * advice it would).
 */
export function readableMessages(messages: IMessage[], cwd: string, resolver: PnpResolver | undefined): IMessage[] {
  const names = new PackageNames(resolver);
  const readable = (location: ILocation | null | undefined): ILocation | null | undefined => {
    /* esbuild spells the file namespace as "" in a message's location. */
    if (!location || (location.namespace !== undefined && location.namespace !== "" && location.namespace !== "file")) {
      return location;
    }
    const at = originalLocation(path.resolve(cwd, location.file), location) ?? { ...location, file: path.resolve(cwd, location.file) };
    return { ...at, file: names.display(at.file, cwd) };
  };
  return messages.map(message => ({
    ...message,
    location: readable(message.location),
    ...(message.notes
      ? {
          notes: message.notes
            .filter(note => note.location?.file !== PNP_DATA_FILE)
            .map(note => ({ ...note, location: readable(note.location) })),
        }
      : {}),
  }));
}

/**
 * Find where `location` in `file` came from, by the source map the file names
 * (`//# sourceMappingURL=`, a sibling file or an inline `data:` URL), with the
 * original line's text where the map embeds the source; undefined where there
 * is no map or it maps nothing there. `file` is absolute; so is the answer.
 */
function originalLocation(file: string, location: ILocation): ILocation | undefined {
  let text: string;
  try {
    text = fs.readFileSync(resolveVirtual(file), "utf8");
  } catch {
    return undefined;
  }
  const reference = /\/[/*][#@] sourceMappingURL=([^\s*]+)[\s*/]*$/.exec(text.trimEnd())?.[1];
  if (reference === undefined) {
    return undefined;
  }
  let payload: { sources?: unknown; sourceRoot?: unknown; sourcesContent?: unknown };
  let mapDir = path.dirname(file);
  try {
    const inline = /^data:application\/json[^,]*;base64,(.*)$/.exec(reference);
    if (inline) {
      payload = JSON.parse(Buffer.from(inline[1], "base64").toString("utf8")) as typeof payload;
    } else {
      const mapFile = path.resolve(mapDir, decodeURIComponent(reference));
      mapDir = path.dirname(mapFile);
      payload = JSON.parse(fs.readFileSync(resolveVirtual(mapFile), "utf8")) as typeof payload;
    }
  } catch {
    return undefined;
  }
  let origin: { fileName?: string; lineNumber?: number; columnNumber?: number };
  try {
    origin = new SourceMap(payload as ConstructorParameters<typeof SourceMap>[0]).findOrigin(location.line, location.column + 1);
  } catch {
    return undefined;
  }
  if (origin.fileName === undefined || origin.lineNumber === undefined || /^[a-z][a-z0-9+.-]*:/i.test(origin.fileName)) {
    return undefined;
  }
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const content = Array.isArray(payload.sourcesContent) ? payload.sourcesContent[sources.indexOf(origin.fileName)] : undefined;
  const lineText = typeof content === "string" ? content.split(/\r?\n/)[origin.lineNumber - 1] : undefined;
  const root = typeof payload.sourceRoot === "string" ? payload.sourceRoot : "";
  return {
    file: path.resolve(mapDir, root, origin.fileName),
    line: origin.lineNumber,
    column: Math.max(0, (origin.columnNumber ?? 1) - 1),
    ...(lineText === undefined ? { lineText: "" } : { lineText, ...(location.length ? { length: location.length } : {}) }),
  };
}

/** Display names for files, by the package each lies in: its name and
 * version, then the path within it. */
class PackageNames {
  private readonly versions = new Map<string, string>();

  constructor(private readonly resolver: PnpResolver | undefined) {}

  /** Get `file`'s display name: `<name>@<version>/<path within>`, or its path
   * relative to `cwd` where it lies in no package, or a linked one. */
  public display(file: string, cwd: string): string {
    const locator = this.resolver?.findPackageLocator(file);
    const info = locator && locator.name !== null ? this.resolver!.getPackageInformation(locator) : null;
    if (!locator || locator.name === null || !info || info.linkType === "SOFT") {
      return path.relative(cwd, file);
    }
    const root = info.packageLocation;
    /* A map may name its source above the package (fabr's compile names one
     * beside its output directory): drop the `..` parts. */
    const within = toPosix(path.relative(root, file))
      .split("/")
      .filter(part => part !== "..");
    return `${locator.name}@${this.versionOf(root)}/${within.join("/")}`;
  }

  private versionOf(root: string): string {
    let version = this.versions.get(root);
    if (version === undefined) {
      const manifest = readManifest(root);
      version = typeof manifest?.version === "string" ? manifest.version : "?";
      this.versions.set(root, version);
    }
    return version;
  }
}
