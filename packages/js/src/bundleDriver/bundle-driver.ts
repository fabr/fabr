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
 * Fabr's esbuild bundle driver: the runtime executed (standalone, under node)
 * inside a js_bundle build step. It reads the options document fabr staged
 * (see JSBundle.ts / IBundleOptions), invokes esbuild's JS API with one
 * fabr-owned resolver plugin, and writes the bundle to the output directory.
 *
 * Usage: node bundle-driver.js --options=<path-to-options.json>
 *
 * Like the test runner, this file runs in the *build* process, not in fabr:
 * it `require`s esbuild from its own staged node_modules and must not depend on
 * @fabr-build/core at runtime (the IBundleOptions import is type-only, erased at
 * compile). esbuild is required lazily inside {@link main} so the pure helpers
 * stay importable (for the unit tests) without esbuild installed.
 *
 * The resolver plugin implements two fabr policies esbuild can't express in
 * config:
 *
 *  - **Membership.** A bare import that names a declared dep is externalized
 *    (its import survives verbatim). A code import that resolves nowhere and is
 *    no dep is an error (declare it in srcs or deps). An asset reference (a CSS
 *    `url()`) that resolves nowhere is left as an external runtime URL.
 *  - **Single variant.** Within one bundle a package resolves to exactly one
 *    variant regardless of importer kind, defeating Node's dual-package hazard
 *    (esbuild would otherwise inline both the ESM and CJS copies). Bare
 *    specifiers resolve with the kind normalized to the bundle's native format,
 *    cached, and that answer is reused for every importer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IBundleOptions } from "../JSBundle";

/* Minimal structural typing for the slice of esbuild's API we use — esbuild is
 * not a fabr dependency (it is fetched at build time), so its own types are not
 * available here; these mirror the documented shapes. */
interface IMessage {
  text: string;
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
}
interface IEsbuild {
  build(options: Record<string, unknown>): Promise<IBuildResult>;
}

/* The extensions esbuild loads natively as code/text — everything else that
 * membership pulls into the bundle is emitted as a file asset (hashed, its
 * import rewritten to the URL). This is a denylist of code, NOT an allowlist of
 * assets: what goes into the bundle is decided by resolution into srcs, and a
 * file's *representation* is "code if it's a known code extension, else a file"
 * — so no asset-extension list to maintain and no "unsupported extension" error.
 * CSS/JSON are concatenated/parsed natively; JS/TS are compiled. */
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".css", ".json", ".txt"]);

/** The importer kinds that reference an *asset* (a URL in a stylesheet) rather
 * than code: a miss on one of these is an external runtime URL, not an error. */
const ASSET_KINDS = new Set(["url-token"]);

/** The package name a bare specifier belongs to (`lodash/fp` → `lodash`,
 * `@scope/pkg/sub` → `@scope/pkg`). */
export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Whether a specifier is a bare package import (not a relative/absolute path). */
export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

/**
 * The css_compile resolve convention: a styled-source import maps to that
 * source's driver output, which is the same name with the Sass extension
 * lowered to `.css`. A css-module needs no case of its own — `x.module.scss`
 * lands on `x.module.css` by that one rule, which is exactly the name esbuild's
 * local-css loader scopes. Plain `.css` is returned unchanged and left to
 * esbuild, so this stays a naming rule, not a CSS transform.
 */
export function rewriteStyledImport(specifier: string): string {
  return specifier.replace(/\.(scss|sass)$/i, ".css");
}

/**
 * The fabr resolver plugin — membership + single-variant (see file header). The
 * bundle's native kind is the resolution kind bare specifiers are normalized to.
 * `unresolved` collects the bare specifiers this plugin could not answer, for
 * the guidance {@link unresolvedHelp} adds to whichever of them esbuild goes on
 * to report.
 */
function fabrResolverPlugin(options: IBundleOptions, unresolved: Set<string>): IPlugin {
  const external = new Set(options.external);
  const nativeKind = options.format === "cjs" ? "require-call" : "import-statement";
  const otherKind = nativeKind === "require-call" ? "import-statement" : "require-call";
  /* One resolved answer per bare specifier *per importing directory*, reused
   * whatever the importer kind. The kind is what the cache exists to collapse;
   * the directory is not interchangeable — node resolution walks up from it, so
   * two importers under nested installs legitimately reach different copies. */
  const variantCache = new Map<string, IOnResolveResult>();

  return {
    name: "fabr-resolver",
    setup(build: IPluginBuild): void {
      build.onResolve({ filter: /.*/ }, async (args): Promise<IOnResolveResult | null> => {
        /* build.resolve re-runs plugins; the marker lets our own re-entrant
         * call fall through to esbuild's default resolution. */
        if (args.pluginData && (args.pluginData as { fabr?: boolean }).fabr) {
          return null;
        }

        /* Asset references (CSS url()) resolve on disk if vendored (esbuild's
         * file loader then emits them) or become an external runtime URL. */
        if (ASSET_KINDS.has(args.kind)) {
          const probe = await build.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: { fabr: true },
          });
          return probe.errors.length ? { path: args.path, external: true } : null;
        }

        /* Relative/absolute imports are within-variant. A styled-source import
         * (.scss/.sass) is redirected to its css_compile output (the compiled
         * .css) — the only CSS knowledge the driver has, a naming rule.
         * Everything else esbuild resolves (a genuine miss there is a real error). */
        if (!isBareSpecifier(args.path)) {
          const rewritten = rewriteStyledImport(args.path);
          if (rewritten === args.path) {
            return null;
          }
          const resolved = await build.resolve(rewritten, {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: { fabr: true },
          });
          return resolved.errors.length
            ? { errors: resolved.errors }
            : { path: resolved.path, external: resolved.external, namespace: resolved.namespace };
        }

        /* A declared dep is externalized by identity: its import survives. */
        if (external.has(packageOf(args.path))) {
          return { path: args.path, external: true };
        }

        /* A styled import is redirected to its lowered output whether it is
         * written relatively or as a package subpath — CSS resolves by the same
         * rules as JS, so where the specifier came from cannot change it. */
        const specifier = rewriteStyledImport(args.path);
        const variantKey = `${args.resolveDir}\0${specifier}`;
        const cached = variantCache.get(variantKey);
        if (cached) {
          return cached;
        }

        const resolved = await resolveSingleVariant(build, { ...args, path: specifier }, nativeKind, otherKind);
        if (resolved) {
          variantCache.set(variantKey, resolved);
          return resolved;
        }

        /* A bare code import that is neither bundled nor a declared dep.
         * DECLINE rather than report an error: whether an unresolvable import is
         * fatal is esbuild's judgment, not ours. A `require` inside a try/catch
         * is the ecosystem's optional-dependency idiom (framer-motion probing
         * for @emotion/is-prop-valid, an optional peer nothing installs), and
         * esbuild answers it by leaving the call to fail at runtime, where the
         * catch is waiting — but onResolve args do not say whether the call site
         * is one, so a plugin cannot make that call. A returned error is
         * unconditional and would pre-empt it, failing builds esbuild completes.
         * Noted instead, so a failure that DOES survive still carries the
         * srcs/deps guidance esbuild has no way to give. */
        unresolved.add(args.path);
        return null;
      });

      /* Representation, not membership: a file membership already pulled in is
       * loaded natively if it is a known code extension, else emitted as a file
       * asset. So no asset-extension list — anything that resolved into srcs and
       * isn't code becomes an emitted, URL-rewritten file (fonts, images, …). */
      build.onLoad({ filter: /.*/ }, async (args): Promise<IOnLoadResult | null> => {
        if (CODE_EXTENSIONS.has(path.extname(args.path).toLowerCase())) {
          return null;
        }
        return { contents: new Uint8Array(await fs.promises.readFile(args.path)), loader: "file" };
      });
    },
  };
}

/**
 * Resolve a bare specifier to a single variant: try the bundle's native kind
 * first, then the other (a package that ships only one condition), so both an
 * ESM and a CJS importer land on the same file. Returns undefined if neither
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

/** Translate the fabr options document into esbuild's BuildOptions. */
function toEsbuildOptions(options: IBundleOptions, unresolved: Set<string>): Record<string, unknown> {
  return {
    entryPoints: options.entries,
    outdir: options.outdir,
    bundle: true,
    write: true,
    platform: options.platform,
    format: options.format,
    target: options.target,
    minify: options.minify,
    sourcemap: options.sourcemap,
    logLevel: "silent",
    plugins: [fabrResolverPlugin(options, unresolved)],
    /* css-modules: `.module.css` scopes its identifiers and exports the map to
     * the importing JS; every other stylesheet keeps global names. */
    loader: { ".module.css": "local-css", ".css": "global-css" },
    ...(options.define ? { define: options.define } : {}),
  };
}

/**
 * Add fabr's srcs/deps guidance to an esbuild failure, for each specifier the
 * resolver plugin declined AND esbuild went on to name — the ones it tolerated
 * (a probe inside a try/catch) are deliberately absent from its report, so they
 * get no advice either. esbuild reports the specifier quoted, which is what a
 * named one is matched by; the message is returned unchanged when none are.
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

function parseOptionsPath(argv: string[]): string {
  const flag = argv.find(arg => arg.startsWith("--options="));
  if (!flag) {
    throw new Error("bundle-driver: missing --options=<path>");
  }
  return flag.substring("--options=".length);
}

export async function main(argv: string[]): Promise<void> {
  // esbuild is fetched at build time and mounted in this step's node_modules,
  // so it is required (not imported) — its types are not available to compile.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const esbuild = require("esbuild") as IEsbuild;

  const options = JSON.parse(fs.readFileSync(parseOptionsPath(argv), "utf8")) as IBundleOptions;
  /* What the resolver plugin declined; esbuild decides which of them are fatal
   * (see the plugin's fallback), and only those get fabr's guidance. */
  const unresolved = new Set<string>();
  let result: IBuildResult;
  try {
    result = await esbuild.build(toEsbuildOptions(options, unresolved));
  } catch (err) {
    throw new Error(unresolvedHelp(err instanceof Error ? err.message : String(err), unresolved));
  }
  if (result.errors.length) {
    for (const error of result.errors) {
      process.stderr.write(`${unresolvedHelp(error.text, unresolved)}\n`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
