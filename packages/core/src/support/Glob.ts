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

/** The glob metacharacters, an extglob group's leader among them (`!(`, `@(`, `+(`): a name holding none is a literal. */
export const GLOB_METACHAR = /[*?[]|[!@+]\(/;

/** @return true if `text` holds a glob metacharacter, otherwise false. */
export function isGlob(text: string): boolean {
  return GLOB_METACHAR.test(text);
}

/** The POSIX classes a bracket expression may name, as regex class contents. */
export const POSIX_CLASSES: ReadonlyMap<string, string> = new Map([
  ["alnum", "A-Za-z0-9"],
  ["alpha", "A-Za-z"],
  ["blank", " \\t"],
  ["cntrl", "\\x00-\\x1f\\x7f"],
  ["digit", "0-9"],
  ["graph", "!-~"],
  ["lower", "a-z"],
  ["print", " -~"],
  ["punct", "!-\\/:-@\\[-`{-~"],
  ["space", " \\t\\n\\r\\f\\v"],
  ["upper", "A-Z"],
  ["xdigit", "0-9A-Fa-f"],
]);

/** A bracket expression's member as written: a character, or a POSIX class (`[:digit:]`) by name. */
export type BracketMember = { readonly char: string } | { readonly posixClass: string };

/**
 * Read the bracket expression opening at `open`: whether `!` or `^` negates it,
 * its members, and the index of its closing `]`, or undefined where it has none.
 * A `]` first in the expression (after any `!` or `^`) is a member, as in bash;
 * a `\` quotes the character after it; `[:name:]` names one of {@link POSIX_CLASSES}.
 */
export function readBracketExpression(
  text: string,
  open: number
): { negated: boolean; members: BracketMember[]; end: number } | undefined {
  let i = open + 1;
  let negated = false;
  if (text[i] === "!" || text[i] === "^") {
    negated = true;
    i++;
  }
  const members: BracketMember[] = [];
  for (let first = true; i < text.length; i++, first = false) {
    const ch = text[i];
    if (ch === "]" && !first) {
      return { negated, members, end: i };
    }
    if (ch === "[" && text[i + 1] === ":") {
      const close = text.indexOf(":]", i + 2);
      const name = close === -1 ? undefined : text.slice(i + 2, close);
      if (name !== undefined && POSIX_CLASSES.has(name)) {
        members.push({ posixClass: name });
        i = close + 1;
        continue;
      }
    }
    members.push({ char: ch === "\\" && i + 1 < text.length ? text[++i] : ch });
  }
  return undefined;
}

/** A compiled glob: true iff the given (forward-slash) path matches. */
export type GlobMatcher = (path: string) => boolean;

/**
 * Compile a glob into a path matcher — the single home for fabr's glob options.
 *
 * fabr treats dotfiles as ordinary files: a directory expansion (`src` →
 * `src/**`) means *every* file beneath it, and a build step's dotfile outputs
 * must survive result collection. picomatch excludes dotfiles by default, so
 * `dot` is set here and every matcher in the engine goes through this function.
 *
 * A `!(…)` group is a subtraction over the whole pattern (see
 * {@link negationsOf}): `A!(X)B` matches what `A*B` matches and `AXB` does not.
 */
export function globMatcher(glob: string): GlobMatcher {
  const negated = negationsOf(glob);
  if (negated === undefined) {
    return picomatch(glob, { dot: true });
  }
  const base = negated.base(false);
  const excluded = negated.excluded();
  return path => base.test(path) && !excluded.some(re => re.test(path));
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
 * and this is then used purely as a matcher. A `!(…)` group captures nothing:
 * what it subtracts is checked by lookbehinds after the end anchor.
 */
export function globCaptureRegex(glob: string): RegExp {
  const negated = negationsOf(glob);
  if (negated === undefined) {
    return picomatch.makeRe(glob, { dot: true, capture: true });
  }
  return new RegExp(
    negated.base(true).source +
      negated
        .excluded()
        .map(re => `(?<!${re.source})`)
        .join("")
  );
}

/**
 * Compile a fixed leading path prefix into an anchored regex, for stripping that
 * prefix from result names (the colon-form naming rule: `src:**` names results
 * relative to `src`). Uses the same dotfile policy as {@link globMatcher}, so a
 * globbed prefix strips the same dotfile directories the search side matches.
 * A `!(…)` group strips as the wildcard it stands for: the selection has already
 * subtracted what it excludes.
 */
export function globPrefixRegex(prefix: string): RegExp {
  const negated = negationsOf(prefix);
  const output = picomatch.parse(negated === undefined ? prefix : negated.withWildcards(), { dot: true }).output;
  return new RegExp("^" + (negated === undefined ? output : negated.expand(output)));
}

/** A glob's `!(…)` groups, and the patterns its subtraction is made of. */
interface INegations {
  /** The pattern with each group as the wildcard it stands for. */
  base(capture: boolean): RegExp;
  /** One pattern per alternative of each group, the other groups as wildcards. */
  excluded(): RegExp[];
  /** The pattern with each group as a placeholder {@link expand} fills in. */
  withWildcards(): string;
  /** Replace each placeholder in a compiled regex source with its wildcard. */
  expand(source: string): string;
}

/** A `!(…)` group: its span in the glob and its alternatives. */
interface INegationGroup {
  start: number;
  end: number;
  alternatives: string[];
  /** true if an alternative holds a `/`, otherwise false. */
  spansSegments: boolean;
  /** true if the group is bounded by `/` or the ends of the glob on both sides, otherwise false. */
  wholeSegment: boolean;
}

/**
 * Find the `!(…)` groups of a glob and make the subtraction they stand for.
 *
 * A group is a wildcard in the pattern it sits in — one path segment's worth
 * (`*`), or any text at all, `/` included, where its contents hold a `/`; like
 * `*`, never empty where it stands as a whole segment — and
 * each of its alternatives, written in its place, is a pattern the path must not
 * match. So `**\/!(foo/bar)/**\/!(*.ts)` matches what `**\/*\/**\/*` matches,
 * less `**\/foo/bar/**\/*` and `**\/*\/**\/*.ts`. A group inside another group is
 * refused (the parser refuses one written in a build file first).
 *
 * @return undefined for a glob with no `!(…)` group.
 */
function negationsOf(glob: string): INegations | undefined {
  const groups = negationGroups(glob);
  if (groups.length === 0) {
    return undefined;
  }
  /* Each group compiles as a placeholder of plain letters, which picomatch
   * passes through as literal text, then replaced by the group's wildcard in
   * the regex it emits. */
  let stem = "FABRNEGATION";
  while (glob.includes(stem)) {
    stem += "X";
  }
  const placeholder = (i: number): string => `${stem}${i}${stem}`;
  /* A group standing as a whole segment is never empty, as `*` there is not. */
  const wildcard = (group: INegationGroup): string => `(?:${group.spansSegments ? "." : "[^/]"}${group.wholeSegment ? "+?" : "*?"})`;
  const assemble = (replace: (group: INegationGroup, i: number) => string): string => {
    let text = "";
    let at = 0;
    groups.forEach((group, i) => {
      text += glob.substring(at, group.start) + replace(group, i);
      at = group.end;
    });
    return text + glob.substring(at);
  };
  const expand = (source: string): string =>
    groups.reduce((text, group, i) => text.replaceAll(placeholder(i), wildcard(group)), source);
  const compile = (pattern: string, capture: boolean): RegExp =>
    new RegExp(expand(picomatch.makeRe(pattern, { dot: true, capture }).source));
  const withWildcards = (): string => assemble((_, i) => placeholder(i));
  return {
    base: capture => compile(withWildcards(), capture),
    excluded: () =>
      groups.flatMap((negated, n) =>
        negated.alternatives.map(alternative =>
          compile(
            assemble((group, i) => (i === n ? alternative : placeholder(i))),
            false
          )
        )
      ),
    withWildcards,
    expand,
  };
}

/**
 * Find the `!(…)` groups at the top level of a glob. A `\` escapes the next
 * character and a `[…]` class is read whole, so neither opens nor closes a group.
 */
function negationGroups(glob: string): INegationGroup[] {
  const groups: INegationGroup[] = [];
  /* The open groups, innermost last: whether each is a negation, and where its
   * current alternative began. */
  const open: { negation: boolean; start: number; from: number; alternatives: string[] }[] = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "[") {
      i = classEnd(glob, i);
    } else if ("!@+*?".includes(ch) && glob[i + 1] === "(") {
      if (ch === "!" && open.length > 0) {
        throw new Error(`A '!(…)' group cannot be inside another group, in '${glob}'`);
      }
      open.push({ negation: ch === "!", start: i, from: i + 2, alternatives: [] });
      i++;
    } else if (ch === "|" && open.length > 0) {
      const group = open[open.length - 1];
      group.alternatives.push(glob.substring(group.from, i));
      group.from = i + 1;
    } else if (ch === ")" && open.length > 0) {
      const group = open.pop()!;
      if (group.negation) {
        const alternatives = [...group.alternatives, glob.substring(group.from, i)];
        groups.push({
          start: group.start,
          end: i + 1,
          alternatives,
          spansSegments: alternatives.some(alt => alt.includes("/")),
          wholeSegment: (group.start === 0 || glob[group.start - 1] === "/") && (i + 1 === glob.length || glob[i + 1] === "/"),
        });
      }
    }
  }
  return groups;
}

/** @return the index of the `]` closing the class opened at `start`, or `start` where none does. */
function classEnd(glob: string, start: number): number {
  return readBracketExpression(glob, start)?.end ?? start;
}
