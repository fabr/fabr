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

/* The options documents the test pipeline writes for the coverage driver. */

/**
 * The environment variable naming the directory a measured test process
 * writes its coverage into, as one document per process, which the preload
 * the driver prepares ({@link ICoveragePrepareOptions}) reads.
 */
export const COVERAGE_DIR_VARIABLE = "FABR_COVERAGE_DIR";

/**
 * Prepare a measured run: write the module every test process loads first
 * (`--require`), which records the process's coverage of the measured files
 * into the directory {@link COVERAGE_DIR_VARIABLE} names, and the table that
 * module names the measured files by. Every path is absolute or relative to
 * the driver's working directory.
 */
export interface ICoveragePrepareOptions {
  kind: "prepare";
  /** The compiled files measured, each possibly through a PnP virtual
   * location, relative to the driver's working directory. */
  measured: string[];
  /** Where the module is written. */
  preload: string;
  /** Where the table of the measured files is written, as a JSON object: each
   * measured file's physical path, by the least of `measured` that leads to it,
   * which is the name its coverage is recorded under. */
  table: string;
}

/**
 * Convert the coverage a measured run's processes recorded into one lcov
 * document over the sources of `measured`. Every path is absolute or relative
 * to the driver's working directory.
 */
export interface ICoverageConvertOptions {
  kind: "convert";
  /** The directories holding the recorded coverage documents, at any depth. */
  raw: string[];
  /** The compiled files converted, by the names their coverage is recorded
   * under ({@link ICoveragePrepareOptions.table}), each read at its physical
   * path and naming its source map
   * in a `sourceMappingURL` comment (a file naming none is left out). A file no
   * process loaded is reported as not run. */
  measured: string[];
  /** Where the lcov document is written. */
  output: string;
}

/** The coverage driver's options document. */
export type ICoverageOptions = ICoveragePrepareOptions | ICoverageConvertOptions;
