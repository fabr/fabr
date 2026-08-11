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

import picomatch from "picomatch";

/** A compiled glob: true iff the given (forward-slash) path matches. */
export type GlobMatcher = (path: string) => boolean;

/**
 * Compile a glob into a path matcher — the single home for fabr's glob options.
 *
 * fabr treats dotfiles as ordinary files: a directory expansion (`src` →
 * `src/**`) means *every* file beneath it, and a build step's dotfile outputs
 * must survive result collection. picomatch excludes dotfiles by default, so
 * `dot` is set here and every matcher in the engine goes through this function.
 */
export function globMatcher(glob: string): GlobMatcher {
  return picomatch(glob, { dot: true });
}

/**
 * Compile a glob into an anchored *capturing* regex, for the rename projection
 * (`sel -> tmpl`): each `*`/`**` becomes a capture group, so a match substitutes
 * into a `$1`/`$2`-style template via `String.replace` (see Name.makeRenamer). A
 * zero-segment globstar leaves its group unmatched, which `replace` substitutes
 * as `""` — Name.makeRenamer then cleans up the stray slash.
 *
 * The caller guarantees (via the parser) that a rename glob whose template has
 * slots to fill uses only `*`/`**` wildcards — `?` and `[...]` are rejected,
 * because picomatch captures them inconsistently (`?` not at all, a class as a
 * group), which would desync the positional `$n` references. With only `*`/`**`
 * present picomatch emits exactly one group per wildcard in order. A
 * wildcard-free template references no group, so its selector is unrestricted
 * and this is then used purely as a matcher.
 */
export function globCaptureRegex(glob: string): RegExp {
  return picomatch.makeRe(glob, { dot: true, capture: true });
}

/**
 * Compile a fixed leading path prefix into an anchored regex, for stripping that
 * prefix from result names (the colon-form naming rule: `src:**` names results
 * relative to `src`). Uses the same dotfile policy as {@link globMatcher}, so a
 * globbed prefix strips the same dotfile directories the search side matches.
 */
export function globPrefixRegex(prefix: string): RegExp {
  return new RegExp("^" + picomatch.parse(prefix, { dot: true }).output);
}
