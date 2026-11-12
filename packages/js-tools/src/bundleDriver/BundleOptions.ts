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

/* The bundle driver's options document: what the js_bundle rule writes and the
 * driver reads. */

/** The esbuild metafile every bundle writes beside its outputs, its paths naming
 * each input by its source path and each output relative to the output directory. */
export const BUNDLE_METAFILE = "metafile.json";

/** An entry point, as esbuild takes one: the staged file `in`, bundled to the
 * output name `out`. */
export interface IBundleEntry {
  in: string;
  out: string;
}

/** The options document fabr writes for the bundle driver, as JSON, which the
 * driver maps onto esbuild's BuildOptions. Holds no host paths. */
export interface IBundleOptions {
  /** Entry points to bundle, each with its output name: `[name]` in `entryNames`. */
  entries: IBundleEntry[];
  /** esbuild's `entryNames`: a pattern of esbuild's placeholders (`[dir]`, `[name]`, `[hash]`),
   * its extension added by esbuild. */
  entryNames: string;
  /** Package names (dependency closure) to externalize — their imports survive
   * verbatim; a bundled source importing one of these is left as-is. */
  external: string[];
  /** esbuild platform, from JS_TARGET's environment component. */
  platform: "browser" | "node";
  /** esbuild output format (JS_BUNDLE_FORMAT, `esm-split` being `esm`). */
  format: "esm" | "cjs" | "iife";
  /** true for `esm-split`: the code entries share goes into chunks they import.
   * Only with the `esm` format. */
  splitting: boolean;
  /** esbuild's `chunkNames` for a split bundle: a pattern of esbuild's
   * placeholders (`[name]`, `[hash]`), its extension added by esbuild. */
  chunkNames: string;
  /** esbuild's `assetNames`: a pattern of esbuild's placeholders, its extension
   * added by esbuild. */
  assetNames: string;
  /** esbuild target ES level (JS_TARGET's version component). */
  target: string;
  /** Minify per BUILD_TYPE. */
  minify: boolean;
  /** Linked external sourcemap (`//# sourceMappingURL=`) per BUILD_TYPE, or none. */
  sourcemap: "linked" | false;
  /** Where the driver writes outputs, relative to the working directory. */
  outdir: string;
  /** esbuild `define`: identifier -> replacement code text (the `defines` MAP,
   * verbatim). Omitted when no defines were declared. */
  define?: Record<string, string>;
  /** esbuild `inject`: modules whose EXPORTS fill same-named free identifiers in
   * every bundled module (the `js/node_globals` glue). Paths are relative to the
   * working root. Omitted when nothing is injected. */
  inject?: string[];
}
