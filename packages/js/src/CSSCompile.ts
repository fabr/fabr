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
 * Host-side (tool-independent) helpers behind the css_compile rule: the options
 * document handed to the standalone CSS driver (see cssDriver/css-driver.ts —
 * resolved as the CSS_COMPILER runnable declared in JS.fabr). Everything here
 * runs in the host during evaluation; the sass/lightningcss invocation itself
 * is the driver's job. Kept apart from the driver so it can import
 * @fabr-build/core and be unit-tested under jest (the driver runs standalone in
 * the css build step and must not depend on core at runtime).
 */

/** Where the driver writes, and the rule collects, the compiled CSS from. */
export const CSS_OUTDIR = "out";

/** Where the styled sources are staged (the driver reads from here). */
export const CSS_SRC_ROOT = "src";

/** Where the scss dependency packages are mounted — the Sass `loadPaths` root
 * against which `@use "@scope/pkg/partial"` resolves (the Sass analogue of the
 * node_modules mount). */
export const SCSS_DEPS_DIR = "scss_deps";

/**
 * The options document fabr writes for the CSS driver — a plain, tool-free
 * description of the compile. The driver reads it and lowers each styled source.
 * Serialized to JSON, so it stays content-addressed with no host paths.
 */
export interface ICssOptions {
  /** Styled source files to lower, each relative to {@link CSS_SRC_ROOT}. */
  files: string[];
  /** Root (relative to the working dir) the source files are staged under. */
  srcRoot: string;
  /** Sass load paths (relative to the working dir) — the mounted scss dep roots
   * against which `@use`/`@import` of shared partials resolve. */
  loadPaths: string[];
  /** Where the driver writes outputs, relative to the working dir. */
  outdir: string;
}

/**
 * Whether a bundle source needs the css_compile pre-pass: a Sass source
 * (`.scss`/`.sass`, including `.module.scss`). Plain `.css` and `.module.css`
 * are left for esbuild — it ingests plain CSS natively, and css-modules from
 * *plain* CSS (no Sass) is not yet routed (dylan has none). So the two rewrite
 * cases the bundle driver needs are exactly `.module.{scss,sass}` → proxy `.js`
 * and plain `.{scss,sass}` → `.css`.
 */
export function isStyledSource(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/**
 * Assemble the driver options from the styled source names: every source is
 * lowered (the driver classifies each by extension), read from {@link
 * CSS_SRC_ROOT}, with Sass `loadPaths` pointing at the mounted scss deps and
 * output written to {@link CSS_OUTDIR} — all working-dir-relative, so the
 * document stays content-addressed with no host paths.
 */
export function buildCssOptions(fileNames: string[]): ICssOptions {
  return {
    files: [...fileNames].sort(),
    srcRoot: CSS_SRC_ROOT,
    loadPaths: [SCSS_DEPS_DIR],
    outdir: CSS_OUTDIR,
  };
}
