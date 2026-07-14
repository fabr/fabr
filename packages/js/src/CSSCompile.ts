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
 * document handed to the standalone CSS driver (see cssDriver/css-driver.ts) and
 * loading the driver runtime for staging. Everything here runs in the host during
 * evaluation; the sass/lightningcss invocation itself is the driver's job. Kept
 * apart from the driver so it can import @fabr/core and be unit-tested under jest
 * (the driver runs standalone in the css build step and must not depend on core
 * at runtime).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FileSet, IFile, MemoryFile } from "@fabr/core";

/** Where the driver writes, and the rule collects, the compiled CSS from. */
export const CSS_OUTDIR = "out";

/** Where the styled sources are staged (the driver reads from here). */
export const CSS_SRC_ROOT = "src";

/** Where the scss dependency packages are mounted — the Sass `loadPaths` root
 * against which `@use "@scope/pkg/partial"` resolves (the Sass analogue of the
 * node_modules mount). */
export const SCSS_DEPS_DIR = "scss_deps";

/** The driver's entry, launched under node inside the css build step. */
export const CSS_DRIVER_ENTRY = "css-driver.js";

/* Fabr's own CSS driver lives in this @fabr/js installation, next to the
 * compiled helpers (build/cssDriver in the devchain build, or cssDriver/ within
 * the fabr-built package — the same relative layout as the bundle driver). */
const CSS_DRIVER_DIR = path.join(__dirname, "cssDriver");

let driverCache: FileSet | undefined;

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
    files: [...fileNames].sort((a, b) => a.localeCompare(b)),
    srcRoot: CSS_SRC_ROOT,
    loadPaths: [SCSS_DEPS_DIR],
    outdir: CSS_OUTDIR,
  };
}

/**
 * Load fabr's CSS driver from this installation's cssDriver directory: its
 * runtime .js (css-driver.js + any helpers), named at the directory root, ready
 * to stage into the css step's tool mount. Read once and memoized — the driver
 * is fixed per fabr version. Files enter as in-memory content, so the css-compile
 * cache key stays content-addressed.
 */
export function getCssDriver(): FileSet {
  if (!driverCache) {
    const runtime: Record<string, IFile> = {};
    for (const name of fs.readdirSync(CSS_DRIVER_DIR)) {
      if (name.endsWith(".js") && !name.endsWith(".test.js")) {
        runtime[name] = MemoryFile.from(fs.readFileSync(path.join(CSS_DRIVER_DIR, name), "utf8"));
      }
    }
    if (!runtime[CSS_DRIVER_ENTRY]) {
      throw new Error(`fabr css driver is missing its ${CSS_DRIVER_ENTRY} entry in ${CSS_DRIVER_DIR}`);
    }
    driverCache = FileSet.layout(runtime);
  }
  return driverCache;
}
