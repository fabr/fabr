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
 * Pure (esbuild-independent) helpers behind the js_bundle rule: computing the
 * externalized-dependency name set, mapping each entry to its output name via
 * the `output` REWRITE, and assembling the fabr-level options document handed to
 * the standalone bundle driver (see @fabr-build/js-tools's
 * bundleDriver/bundle-driver.ts — resolved as the JS_BUNDLER runnable declared
 * in JS.fabr). Everything here runs in the host during evaluation; the esbuild
 * invocation itself is the driver's job.
 * Kept apart from the driver so it can import @fabr-build/core and be
 * unit-tested under jest (the driver runs standalone in the bundle build step
 * and must not depend on core at runtime).
 */

import { dependencyName, FabrError, FileSet, PackageFileSet, RewriteFn } from "@fabr-build/core";
import type { IBundleEntry, IBundleOptions } from "@fabr-build/js-tools";
import { JSTarget } from "./JSPackage";

/** Where esbuild writes and the rule collects the bundle output from. */
export const BUNDLE_OUTDIR = "out";

/** Name an entry's default OUTPUT: every spelling the pipeline compiles
 * or links (`.ts`/`.tsx`/`.jsx`/`.mts`/`.cts`/`.mjs`/`.cjs`) maps to `.js` —
 * the bundle is a fresh file esbuild always writes as `.js`, so even a
 * module-flavoured entry (`.mts`, `.mjs`) yields a plain `.js` bundle name.
 * Anything else keeps its name (and fails the `.js` check downstream). */
export function compiledName(name: string): string {
  return name.replace(/\.(?:tsx?|jsx|[cm]ts|[cm]js)$/i, ".js");
}

export interface IBundleEntrySource {
  path: string;
  name: string;
}

/** Collect every package name reachable from the given roots — the roots themselves plus
 * their whole dependency closure, deduped. An unbound edge (an external
 * requirement a package still carries inertly) contributes the name it is
 * imported by, its local name; a bound one recurses into its package. */
export function collectClosureNames(roots: FileSet[]): Set<string> {
  const names = new Set<string>();
  const visit = (pkg: PackageFileSet): void => {
    if (names.has(pkg.packageName)) {
      return;
    }
    names.add(pkg.packageName);
    for (const dep of pkg.dependencies) {
      if (dep.package !== undefined) {
        visit(dep.package);
      } else {
        names.add(dependencyName(dep));
      }
    }
  };
  for (const set of roots) {
    if (set instanceof PackageFileSet) {
      visit(set);
    }
  }
  return names;
}

/** Collect the direct (top-level, i.e. property-listed) package names among the roots. */
function directNames(roots: FileSet[]): Set<string> {
  const names = new Set<string>();
  for (const set of roots) {
    if (set instanceof PackageFileSet) {
      names.add(set.packageName);
    }
  }
  return names;
}

/**
 * Compute the package names to externalize (left runtime-provided, not bundled). A
 * package is externalized only when it is provided MORE directly than it is
 * bundled — its directness in `deps` outranks its directness in `srcs`, where
 * direct (property-listed) = 2, transitive (closure-only) = 1, absent = 0:
 *
 *   direct src   + direct dep    -> bundled     (an explicit srcs entry isn't overridden)
 *   transitive src + transitive dep -> bundled  (neither side names it explicitly)
 *   transitive src + direct dep  -> externalized (the explicit dep wins)
 *   direct src   + transitive dep -> bundled    (the explicit srcs entry wins)
 *   (absent from srcs, present in deps -> externalized, the ordinary external case)
 *
 * So externalization requires an explicit deps declaration that out-ranks how the
 * package entered srcs; identity is what matters, not which import reached it.
 */
export function computeExternalNames(srcs: FileSet[], deps: FileSet[]): string[] {
  const srcsDirect = directNames(srcs);
  const srcsAll = collectClosureNames(srcs);
  const depsDirect = directNames(deps);
  const external: string[] = [];
  for (const name of collectClosureNames(deps)) {
    const depLevel = depsDirect.has(name) ? 2 : 1;
    if (depLevel > srcLevel(name, srcsDirect, srcsAll)) {
      external.push(name);
    }
  }
  return external;
}

/** Rank how directly a package sits in `srcs`: direct (property-listed) = 2,
 * transitive (closure-only) = 1, absent = 0. */
function srcLevel(name: string, direct: Set<string>, all: Set<string>): number {
  if (direct.has(name)) {
    return 2;
  }
  return all.has(name) ? 1 : 0;
}

/** A bundle's entries, and the esbuild `entryNames` pattern their output names are written by. */
export interface IBundleEntryNames {
  entries: IBundleEntry[];
  entryNames: string;
}

/** The placeholder esbuild writes an output's content hash for. */
const HASH = "[hash]";

/**
 * Map each entry to its bundle entry pair, and make the pattern their outputs are
 * written by. `path` is where the file is staged — for a loose source its compiled
 * name at the bundle root, for one located inside a mounted container the path
 * under that mount. `name` is what the reference CALLS it, and the output is
 * derived from that: any compiled/linked spelling becomes `.js`
 * ({@link compiledName}), named by its content as `<name>-[hash].js`, then the
 * `output` REWRITE renames it (first matching value; unmatched → unchanged). The
 * final name must end in `.js`, and may keep `[hash]` once or drop it. esbuild
 * writes the hash, so the outputs share one pattern: every entry keeps the hash,
 * with the same text after it, or every entry drops it.
 * @throws if an output name doesn't end in `.js`, holds `[hash]` twice, or the
 * outputs need more than one pattern.
 */
export function computeBundleEntries(entries: IBundleEntrySource[], rewrite: RewriteFn): IBundleEntryNames {
  const named = entries.map(({ path, name }) => {
    const compiled = compiledName(name);
    const pattern = compiled.endsWith(".js") ? `${compiled.slice(0, -".js".length)}-${HASH}.js` : compiled;
    const output = rewrite(pattern) ?? pattern;
    if (!output.endsWith(".js")) {
      throw new FabrError(
        `js_bundle output '${output}' (from entry '${name}') must end in '.js' — rename it with an 'output' rewrite (output = <selector> -> <name>.js;)`
      );
    }
    const stem = output.slice(0, -".js".length);
    const at = stem.indexOf(HASH);
    if (at !== stem.lastIndexOf(HASH)) {
      throw new FabrError(`js_bundle output '${output}' (from entry '${name}') names its hash twice`);
    }
    return { path, output, out: at < 0 ? stem : stem.slice(0, at), tail: at < 0 ? undefined : stem.slice(at + HASH.length) };
  });
  const differing = named.find(entry => entry.tail !== named[0].tail);
  if (differing !== undefined) {
    throw new FabrError(
      `js_bundle names its entries by one pattern, so they must all keep the hash, with the same text after it, or all drop it: '${named[0].output}' and '${differing.output}' differ`
    );
  }
  const tail = named[0]?.tail;
  return {
    entries: named.map(({ path, out }) => ({ in: path, out })),
    entryNames: tail === undefined ? "[dir]/[name]" : `[dir]/[name]${HASH}${tail}`,
  };
}

/** The names a split bundle's chunks and a bundle's assets are written under,
 * with esbuild's placeholders in them, before the `output` rewrite renames them. */
const CHUNK_NAMES = "chunks/[name]-[hash].js";
const ASSET_NAMES = "[name]-[hash].[ext]";

/**
 * Compute esbuild's `chunkNames` pattern: {@link CHUNK_NAMES} as `rewrite`
 * renames it, without its extension. A wildcard in a rewrite captures a
 * placeholder whole, so `chunks/*-*.js -> js/$2.$1.js` gives `js/[hash].[name]`.
 */
export function computeChunkNames(rewrite: RewriteFn): string {
  return renamedPattern(rewrite, CHUNK_NAMES, ".js", "the chunks'");
}

/** Compute esbuild's `assetNames` pattern: {@link ASSET_NAMES} as `rewrite`
 * renames it, without its extension (`*-*.* -> assets/$1-$2.$3` gives
 * `assets/[name]-[hash]`). */
export function computeAssetNames(rewrite: RewriteFn): string {
  return renamedPattern(rewrite, ASSET_NAMES, ".[ext]", "the assets'");
}

/**
 * Rename esbuild's naming `pattern` by `rewrite` and strip its `extension`,
 * refusing a rename that does not keep the extension; `whose` names the
 * pattern's files in that error.
 */
function renamedPattern(rewrite: RewriteFn, pattern: string, extension: string, whose: string): string {
  const output = rewrite(pattern) ?? pattern;
  if (!output.endsWith(extension)) {
    throw new FabrError(`js_bundle output '${output}' (from ${whose} name '${pattern}') must end in '${extension}'`);
  }
  return output.slice(0, -extension.length);
}

/** The forms a bundle is written in: JS_BUNDLE_FORMAT's values. */
export type BundleFormat = "iife" | "cjs" | "esm" | "esm-split";

/** Convert a JS_BUNDLE_FORMAT value, refusing one that is not a bundle format. */
export function toBundleFormat(value: string): BundleFormat {
  if (value === "iife" || value === "cjs" || value === "esm" || value === "esm-split") {
    return value;
  }
  throw new FabrError(`JS_BUNDLE_FORMAT must be 'iife', 'cjs', 'esm' or 'esm-split', not '${value}'`);
}

/**
 * Assemble the driver options from the target's JS_TARGET, bundle format and
 * BUILD_TYPE and the computed entries + external set. Minify/sourcemap track
 * BUILD_TYPE (cmake-style): debug → sourcemap only, relwithdebinfo → both,
 * release → minify only.
 */
export function buildBundleOptions(
  jsTarget: JSTarget,
  bundleFormat: BundleFormat,
  buildType: string,
  { entries, entryNames }: IBundleEntryNames,
  external: string[],
  defines: Record<string, string>,
  inject: string[],
  chunkNames: string,
  assetNames: string
): IBundleOptions {
  const minify = buildType === "release" || buildType === "relwithdebinfo";
  const sourcemap: "linked" | false = buildType === "release" ? false : "linked";
  return {
    entries,
    entryNames,
    external,
    platform: jsTarget.environment,
    format: bundleFormat === "esm-split" ? "esm" : bundleFormat,
    splitting: bundleFormat === "esm-split",
    chunkNames,
    assetNames,
    target: jsTarget.version,
    minify,
    sourcemap,
    outdir: BUNDLE_OUTDIR,
    ...(Object.keys(defines).length > 0 ? { define: defines } : {}),
    ...(inject.length > 0 ? { inject } : {}),
  };
}
