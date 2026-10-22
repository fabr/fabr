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

export interface IBundleEntry {
  in: string;
  out: string;
}

/**
 * The options document fabr writes for the bundle driver — a plain, esbuild-free
 * description of the build. The driver maps it onto esbuild's BuildOptions and
 * owns the resolver plugin (membership + single-variant). Serialized to JSON, so
 * it stays content-addressed with no host paths.
 */
export interface IBundleOptions {
  /** Entry points to bundle, each with its output name. */
  entries: IBundleEntry[];
  /** Package names (dependency closure) to externalize — their imports survive
   * verbatim; a bundled source importing one of these is left as-is. */
  external: string[];
  /** esbuild platform, from JS_TARGET's environment component. */
  platform: "browser" | "node";
  /** esbuild output format: esm, or (for non-esm) iife in the browser else cjs. */
  format: "esm" | "cjs" | "iife";
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
