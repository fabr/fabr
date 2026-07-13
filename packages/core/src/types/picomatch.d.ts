/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

/*
 * Corrected declarations for picomatch (v2), in place of @types/picomatch —
 * whose `parse` signature wrongly types its options as only `{ maxLength }`
 * (unfixed through the latest 4.x), while the runtime honours the full option
 * set, notably `dot`. Covers exactly the surface fabr uses: the matcher factory,
 * `scan` (static-base extraction) and `parse` (regex-source compilation).
 */
declare module "picomatch" {
  interface PicomatchOptions {
    /** Match dotfiles with `*`/`**` (off by default). */
    dot?: boolean;
    /** Case-insensitive matching. */
    nocase?: boolean;
    /** Throw if the pattern exceeds this length. */
    maxLength?: number;
    /** Treat `**` as `*` (disable globstar). */
    noglobstar?: boolean;
    /** Match the basename when the pattern contains no slashes. */
    basename?: boolean;
    /** Wrap each wildcard in a capture group in the compiled regex. */
    capture?: boolean;
  }

  /** Tests a single forward-slash path against the compiled pattern. */
  type Matcher = (test: string) => boolean;

  /** The static (non-glob) leading portion of a pattern. */
  interface ScanResult {
    base: string;
    isGlob: boolean;
  }

  /** A parsed pattern; `output` is the regex source (without anchors). */
  interface ParseResult {
    output: string;
  }

  function picomatch(glob: string | string[], options?: PicomatchOptions): Matcher;

  namespace picomatch {
    function scan(pattern: string, options?: PicomatchOptions): ScanResult;
    function parse(input: string, options?: PicomatchOptions): ParseResult;
    /** Compile a pattern to an anchored RegExp; with `capture`, each wildcard
     * becomes a capture group (an unmatched globstar group is `null`). */
    function makeRe(input: string, options?: PicomatchOptions): RegExp;
  }

  export = picomatch;
}
