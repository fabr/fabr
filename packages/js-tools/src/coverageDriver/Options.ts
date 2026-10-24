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

/* The options document the test pipeline writes for the coverage driver. */

/**
 * What the coverage driver converts: the raw V8 coverage a run left behind,
 * read against the compiled files it measures. Every path is relative to the
 * driver's working directory.
 */
export interface ICoverageOptions {
  /** The directory the run's processes wrote their V8 coverage into. */
  raw: string;
  /** The compiled files measured, each beside its source map: those a run did
   * not load are reported as not run at all. */
  measured: string[];
  /** Where the lcov document is written. */
  output: string;
}
