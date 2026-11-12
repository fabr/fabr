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
 * Declarations for picomatch (v2), covering only what fabr uses: the matcher
 * factory, `scan` (the static base of a pattern), `parse` (a pattern's regex
 * source) and `makeRe`. Use these rather than @types/picomatch, whose `parse`
 * accepts only `{ maxLength }` of the options picomatch honours.
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

  /** A test of one forward-slash path against the compiled pattern. */
  type Matcher = (test: string) => boolean;

  /** A scanned pattern: its static (non-glob) leading portion, and whether it has any glob. */
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
