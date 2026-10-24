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

/* The css drivers' options documents: what the sass_compile and css_postcss
 * rules write and the drivers read. */

/**
 * One Sass source and every name the sass step produces for it. The driver
 * reads this and writes exactly these paths — it derives none of them.
 */
export interface ISassSource {
  /** The styled source, relative to the options' `srcRoot`. */
  path: string;
  /** Where the lowered CSS goes, relative to the options' `outdir` —
   * its lowered name (`sassLoweredName`), `.module.` marker intact. */
  css: string;
  /** Where the source map goes, relative to the options' `outdir`; absent when
   * this build does not carry maps. */
  map?: string;
}

/**
 * The options document fabr writes for the Sass driver — a plain, tool-free
 * description of the lowering. Serialized to JSON, so it stays
 * content-addressed with no host paths.
 */
export interface ISassOptions {
  /** Every source to lower, with its output names. Partials are staged but
   * never listed. */
  sources: ISassSource[];
  /** Root (relative to the working dir) the source files are staged under. */
  srcRoot: string;
  /** Sass load paths (relative to the working dir) — the mounted scss dep roots
   * against which `@use`/`@import` of shared partials resolve. */
  loadPaths: string[];
  /** Where the driver writes outputs, relative to the working dir. */
  outdir: string;
}

/**
 * One stylesheet input and every name the postcss step produces for it. The
 * driver reads this and writes exactly these paths — it derives none of them.
 */
export interface IPostcssSource {
  /** The stylesheet input, relative to the options' `srcRoot` — plain CSS: a
   * lowered Sass source (`.module.` marker intact) or an authored `.css`. */
  path: string;
  /** Where the published CSS goes, relative to the options' `outdir` —
   * its scoped name, marker consumed. */
  css: string;
  /**
   * The suffix a local name takes when it is scoped — `<local>_<scope>`. Every
   * stylesheet has one, including a plain one: its own output keeps its names
   * as written ({@link module} is what decides that), but a css-module
   * composing from it gets a scoped private copy of its rules, and those
   * classes are named with this.
   */
  scope: string;
  /** Whether this stylesheet's OWN output is scoped and carries a class map —
   * the `.module.` marker, read once here rather than from the name again. */
  module: boolean;
  /** The JS shim carrying the class-name map (css-modules only). */
  shim?: string;
  /** The map the input ARRIVED with (relative to the options' `srcRoot`), for a
   * module's output map to chain through; absent for an authored stylesheet. */
  prev?: string;
  /** Where the source map goes, relative to the options' `outdir`: chained through
   * {@link prev} for a module, carried through beside a plain stylesheet that
   * arrived with one, absent otherwise. */
  map?: string;
}

/**
 * The options document fabr writes for the postcss driver. Serialized to JSON,
 * so it stays content-addressed with no host paths.
 */
export interface IPostcssOptions {
  /** Every stylesheet to process, with its output names. */
  sources: IPostcssSource[];
  /**
   * A dependency's stylesheets — readable, composable, never published by this
   * step. Named relative to the working dir (under `depsDir`, so a
   * package specifier is the path below it) and carrying the scope their
   * classes take in the private copy a compose inlines, and the name the
   * run reports a read of it by (a dependency path: the package's name, then
   * the file).
   */
  composable: Array<{ path: string; scope: string; read: string }>;
  /** Root (relative to the working dir) the inputs are staged under. */
  srcRoot: string;
  /** Where a dependency's files are mounted, which a package-shaped compose
   * specifier is resolved against. */
  depsDir: string;
  /** Where the driver writes outputs, relative to the working dir. */
  outdir: string;
}
