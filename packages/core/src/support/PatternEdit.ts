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

import { POSIX_CLASSES, readBracketExpression } from "./Glob";

/**
 * The operator of a {@link PatternEdit}, as bash writes it after the name in a
 * `${NAME…}`: `#`/`##` remove the shortest/longest matching prefix, `%`/`%%` the
 * shortest/longest matching suffix, `/` replaces the first match, `//` every
 * match, `/#` a match at the start and `/%` a match at the end.
 */
export type PatternOperator = "#" | "##" | "%" | "%%" | "/" | "//" | "/#" | "/%";

/** The operators that replace what they match, rather than removing it. */
const REPLACING: ReadonlySet<PatternOperator> = new Set(["/", "//", "/#", "/%"]);

/**
 * An edit of a substituted value by a pattern, bash's `${NAME#pattern}` and
 * `${NAME/pattern/replacement}` forms. `pattern` and `replacement` are kept as
 * written, backslash escapes included, so the edit renders back to its text.
 */
export interface PatternEdit {
  readonly operator: PatternOperator;
  readonly pattern: string;
  /** The text a match is replaced with, for a replacing operator; `""` where none
   *  was written (`${NAME/pattern}`). Undefined for a removing one. */
  readonly replacement?: string;
}

/** @return true if `operator` replaces what it matches, otherwise false. */
export function isReplacing(operator: PatternOperator): boolean {
  return REPLACING.has(operator);
}

/** @return the edit as written after the name in a `${NAME…}`. */
export function renderPatternEdit(edit: PatternEdit): string {
  return edit.operator + edit.pattern + (edit.replacement === undefined ? "" : "/" + edit.replacement);
}

/**
 * Apply `edit` to `value`, as bash applies the same expansion to a variable: the
 * pattern is matched against the whole of each candidate part of `value`, and
 * the first that matches decides the result. A value nothing matches is left as
 * it is. A replacement is literal text, its backslash escapes removed (bash's
 * `&` for the matched text is not supported).
 */
export function applyPatternEdit(value: string, edit: PatternEdit): string {
  const regex = patternRegex(edit.pattern);
  const matches = (start: number, end: number): boolean => regex.test(value.slice(start, end));
  const replacement = unescape(edit.replacement ?? "");
  const length = value.length;
  switch (edit.operator) {
    case "#":
      return (
        withFirst(
          ascending(0, length),
          end => matches(0, end),
          end => value.slice(end)
        ) ?? value
      );
    case "##":
      return (
        withFirst(
          descending(length, 0),
          end => matches(0, end),
          end => value.slice(end)
        ) ?? value
      );
    case "%":
      return (
        withFirst(
          descending(length, 0),
          start => matches(start, length),
          start => value.slice(0, start)
        ) ?? value
      );
    case "%%":
      return (
        withFirst(
          ascending(0, length),
          start => matches(start, length),
          start => value.slice(0, start)
        ) ?? value
      );
    case "/#":
      return (
        withFirst(
          descending(length, 0),
          end => matches(0, end),
          end => replacement + value.slice(end)
        ) ?? value
      );
    case "/%":
      return (
        withFirst(
          ascending(0, length),
          start => matches(start, length),
          start => value.slice(0, start) + replacement
        ) ?? value
      );
    case "/": {
      const found = firstMatch(value, 0, matches);
      return found === undefined ? value : value.slice(0, found.start) + replacement + value.slice(found.end);
    }
    case "//": {
      let result = "";
      let from = 0;
      for (let found = firstMatch(value, from, matches); found !== undefined; found = firstMatch(value, from, matches)) {
        result += value.slice(from, found.start) + replacement;
        from = found.end;
      }
      return result + value.slice(from);
    }
  }
}

/**
 * Find the leftmost match from `from` on, the longest at that position: what
 * bash's `/` replaces. A match of no characters does not count, so an empty
 * pattern replaces nothing.
 */
function firstMatch(
  value: string,
  from: number,
  matches: (start: number, end: number) => boolean
): { start: number; end: number } | undefined {
  for (let start = from; start < value.length; start++) {
    for (let end = value.length; end > start; end--) {
      if (matches(start, end)) {
        return { start, end };
      }
    }
  }
  return undefined;
}

/** @return `make(index)` for the first index `test` accepts, or undefined where none does. */
function withFirst(indices: Iterable<number>, test: (index: number) => boolean, make: (index: number) => string): string | undefined {
  for (const index of indices) {
    if (test(index)) {
      return make(index);
    }
  }
  return undefined;
}

function* ascending(from: number, to: number): Iterable<number> {
  for (let index = from; index <= to; index++) {
    yield index;
  }
}

function* descending(from: number, to: number): Iterable<number> {
  for (let index = from; index >= to; index--) {
    yield index;
  }
}

/** The characters a regex gives a meaning to, outside a class. */
const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/**
 * Make the regex that matches a whole string against a bash pattern: `*` any
 * characters (`/` included), `?` any one, `[…]` a bracket expression (`!` or
 * `^` negating it, POSIX classes such as `[:digit:]` inside it), and a
 * backslash quoting the character after it. A `[` with no closing `]` is a
 * literal `[`.
 */
export function patternRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      source += pattern[++i].replace(REGEX_SYNTAX, "\\$&");
    } else if (ch === "*") {
      source += "[\\s\\S]*";
    } else if (ch === "?") {
      source += "[\\s\\S]";
    } else if (ch === "[") {
      const bracket = bracketExpression(pattern, i);
      if (bracket === undefined) {
        source += "\\[";
      } else {
        source += bracket.source;
        i = bracket.end;
      }
    } else {
      source += ch.replace(REGEX_SYNTAX, "\\$&");
    }
  }
  return new RegExp(`^(?:${source})$`);
}

/**
 * Read the bracket expression opening at `open` (see {@link readBracketExpression})
 * as its regex class and the index of its closing `]`, or undefined where it has none.
 */
function bracketExpression(pattern: string, open: number): { source: string; end: number } | undefined {
  const bracket = readBracketExpression(pattern, open);
  if (bracket === undefined) {
    return undefined;
  }
  const members = bracket.members
    .map(member => ("posixClass" in member ? POSIX_CLASSES.get(member.posixClass)! : classMember(member.char)))
    .join("");
  return { source: `[${bracket.negated ? "^" : ""}${members}]`, end: bracket.end };
}

/** @return `ch` as a member of a regex class: itself, quoted where a class gives it a meaning. */
function classMember(ch: string): string {
  return ch === "\\" || ch === "]" || ch === "[" || ch === "^" ? "\\" + ch : ch;
}

/** @return `text` with each backslash escape replaced by the character it quotes. */
function unescape(text: string): string {
  return text.replace(/\\([\s\S])/g, "$1");
}
