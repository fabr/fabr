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

import { FabrError } from "./Errors";

/** A run of a {@link SecureString}'s text from a masked source, and what output shows in its place. */
export interface MaskedSpan {
  readonly start: number;
  readonly end: number;
  readonly shown: string;
}

/**
 * Text, some of which may be a secret: each such run, a masked run, is shown
 * in output as the text given for it (the substitution that read it, as
 * written: `${TOKEN}`), never as its value. It has the operations of a string,
 * each carrying the masked runs to its result; a run an operation cuts is
 * still shown whole, so no part of a masked value is ever shown.
 *
 * It is never made a string implicitly: `toString()` and `toJSON()` throw, so
 * a template literal, `String()`, `+` or `JSON.stringify` of one is an error.
 * Read {@link toDisplayString} for output, and {@link toUnmaskedString} where
 * the text is used: sent, run, written, or matched.
 */
export class SecureString {
  private constructor(
    private readonly text: string,
    /** The masked runs, in order, none overlapping and none empty. */
    private readonly spans: readonly MaskedSpan[]
  ) {}

  /** Make text with nothing masked. */
  public static of(text: string): SecureString {
    return new SecureString(text, []);
  }

  /** Make text that is masked whole, shown as `shown`. */
  public static masked(text: string, shown: string): SecureString {
    return new SecureString(text, text === "" ? [] : [{ start: 0, end: text.length, shown }]);
  }

  /** Make `parts` joined by `separator`, their masked runs kept. */
  public static join(parts: readonly (SecureString | string)[], separator: SecureString | string): SecureString {
    return parts.reduce<SecureString>(
      (joined, part, index) => (index === 0 ? joined.concat(part) : joined.concat(separator, part)),
      EMPTY
    );
  }

  /** The text's length, in UTF-16 code units, as a string's. */
  public get length(): number {
    return this.text.length;
  }

  /** @return true if any of the text is from a masked source, otherwise false. */
  public isMasked(): boolean {
    return this.spans.length > 0;
  }

  /** @return the text as output shows it: each masked run as it was written. */
  public toDisplayString(): string {
    let shown = "";
    let at = 0;
    for (const span of this.spans) {
      shown += this.text.substring(at, span.start) + span.shown;
      at = span.end;
    }
    return shown + this.text.substring(at);
  }

  /** @return the text itself, masked runs included: for where it is used, never for output. */
  public toUnmaskedString(): string {
    return this.text;
  }

  /** Throw: a SecureString is made a string only by {@link toDisplayString} or {@link toUnmaskedString}. */
  public toString(): never {
    throw new FabrError("internal: a SecureString was made a string implicitly; read toDisplayString() or toUnmaskedString()");
  }

  /** Throw, as {@link toString} does: a SecureString is never serialized. */
  public toJSON(): never {
    return this.toString();
  }

  /** @return the text as output shows it, for a debugger or `console.log`. */
  public [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SecureString(${JSON.stringify(this.toDisplayString())})`;
  }

  /** @return true if the text is `other`'s, otherwise false. */
  public equals(other: SecureString | string): boolean {
    return this.text === textOf(other);
  }

  /** @return this text followed by each of `parts`. */
  public concat(...parts: readonly (SecureString | string)[]): SecureString {
    return parts.reduce<SecureString>((joined, part) => joined.append(secureOf(part)), this);
  }

  /** @return the text from `start` up to `end`, as `String.prototype.slice` reads them. */
  public slice(start?: number, end?: number): SecureString {
    const [from, to] = sliceBounds(this.text.length, start, end);
    return this.cut(from, to);
  }

  /** @return the text from `start` up to `end`, as `String.prototype.substring` reads them. */
  public substring(start: number, end?: number): SecureString {
    const clamp = (at: number): number => Math.min(Math.max(Number.isNaN(at) ? 0 : at, 0), this.text.length);
    const from = clamp(start);
    const to = end === undefined ? this.text.length : clamp(end);
    return this.cut(Math.min(from, to), Math.max(from, to));
  }

  /** @return the character at `index`, counting back from the end where it is negative, or undefined where there is none. */
  public at(index: number): SecureString | undefined {
    const at = index < 0 ? this.text.length + index : index;
    return at < 0 || at >= this.text.length ? undefined : this.cut(at, at + 1);
  }

  /**
   * @return the text split at each match of `separator`, as
   * `String.prototype.split` splits it, into at most `limit` parts: a
   * regular expression's capture groups among them, but a group that took no
   * part in a match, which `String.prototype.split` gives as `undefined`, left
   * out (though counted toward `limit`, as there).
   */
  public split(separator: string | RegExp, limit?: number): SecureString[] {
    const max = limit === undefined ? Infinity : limit >>> 0;
    if (max === 0) {
      return [];
    }
    const flags = typeof separator === "string" ? "" : separator.flags.replace(/[gy]/g, "");
    const source = typeof separator === "string" ? separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : separator.source;
    const matcher = new RegExp(source, flags.includes("d") ? flags + "y" : flags + "dy");
    const size = this.text.length;
    if (size === 0) {
      matcher.lastIndex = 0;
      return matcher.test(this.text) ? [] : [this];
    }
    const parts: SecureString[] = [];
    /* How many parts `String.prototype.split` would have given so far: `parts` and the groups left out. */
    let count = 0;
    let p = 0;
    let q = 0;
    while (q < size) {
      matcher.lastIndex = q;
      const match = matcher.exec(this.text);
      const e = match === null ? -1 : Math.min(matcher.lastIndex, size);
      if (match === null || e === p) {
        q++;
        continue;
      }
      parts.push(this.cut(p, q));
      if (++count === max) {
        return parts;
      }
      /* The `d` flag's `indices`, which the compile's `lib` does not declare. */
      const { indices } = match as RegExpExecArray & { indices: Array<[number, number] | undefined> };
      for (const group of indices.slice(1)) {
        if (group !== undefined) {
          parts.push(this.cut(group[0], group[1]));
        }
        if (++count === max) {
          return parts;
        }
      }
      p = e;
      q = p;
    }
    parts.push(this.cut(p, size));
    return parts;
  }

  /** @return the text without leading and trailing white space. */
  public trim(): SecureString {
    return this.trimStart().trimEnd();
  }

  /** @return the text without leading white space. */
  public trimStart(): SecureString {
    return this.cut(this.text.length - this.text.trimStart().length, this.text.length);
  }

  /** @return the text without trailing white space. */
  public trimEnd(): SecureString {
    return this.cut(0, this.text.trimEnd().length);
  }

  /** @return the text padded at its start with `fill` to `length`, as `String.prototype.padStart` pads it. */
  public padStart(length: number, fill?: string): SecureString {
    return SecureString.of("".padStart(Math.max(length - this.text.length, 0), fill)).concat(this);
  }

  /** @return the text padded at its end with `fill` to `length`, as `String.prototype.padEnd` pads it. */
  public padEnd(length: number, fill?: string): SecureString {
    return this.concat("".padEnd(Math.max(length - this.text.length, 0), fill));
  }

  /** @return the text `count` times over. */
  public repeat(count: number): SecureString {
    return SecureString.join(
      Array.from({ length: count }, () => this),
      ""
    );
  }

  /** @return the text in upper case. */
  public toUpperCase(): SecureString {
    return this.mapRuns(text => text.toUpperCase());
  }

  /** @return the text in lower case. */
  public toLowerCase(): SecureString {
    return this.mapRuns(text => text.toLowerCase());
  }

  /**
   * @return the text with `encode` applied to each masked run and to each run
   * between them, each masked run's result masked as the run is: for a
   * transform that treats each character alike wherever it is, such as
   * URI-encoding.
   */
  public mapRuns(encode: (text: string) => string): SecureString {
    let result = EMPTY;
    let at = 0;
    for (const span of this.spans) {
      result = result.concat(
        encode(this.text.substring(at, span.start)),
        SecureString.masked(encode(this.text.substring(span.start, span.end)), span.shown)
      );
      at = span.end;
    }
    return result.concat(encode(this.text.substring(at)));
  }

  /**
   * @return the text with the first match of `pattern` (every match, where it
   * is a global RegExp) replaced by `replacement`, taken literally: no `$`
   * patterns are expanded.
   */
  public replace(pattern: string | RegExp, replacement: SecureString | string): SecureString {
    return this.replaced(matchesOf(this.text, pattern, typeof pattern !== "string" && pattern.global), replacement);
  }

  /** @return the text with every match of `pattern` replaced by `replacement`, taken literally. */
  public replaceAll(pattern: string | RegExp, replacement: SecureString | string): SecureString {
    return this.replaced(matchesOf(this.text, pattern, true), replacement);
  }

  /** @return where `search` is first found at or after `position`, or -1. */
  public indexOf(search: string, position?: number): number {
    return this.text.indexOf(search, position);
  }

  /** @return where `search` is last found at or before `position`, or -1. */
  public lastIndexOf(search: string, position?: number): number {
    return this.text.lastIndexOf(search, position);
  }

  /** @return true if the text holds `search` at or after `position`, otherwise false. */
  public includes(search: string, position?: number): boolean {
    return this.text.includes(search, position);
  }

  /** @return true if the text starts with `search` at `position`, otherwise false. */
  public startsWith(search: string, position?: number): boolean {
    return this.text.startsWith(search, position);
  }

  /** @return true if the text ends with `search` before `endPosition`, otherwise false. */
  public endsWith(search: string, endPosition?: number): boolean {
    return this.text.endsWith(search, endPosition);
  }

  /** @return where `pattern` first matches, or -1. */
  public search(pattern: RegExp): number {
    return this.text.search(pattern);
  }

  /** @return true if `pattern` matches the text, otherwise false. */
  public test(pattern: RegExp): boolean {
    return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(this.text);
  }

  /** @return the text from `from` up to `to`, both within it, a cut masked run kept for what remains of it. */
  private cut(from: number, to: number): SecureString {
    if (from === 0 && to === this.text.length) {
      return this;
    }
    const spans = this.spans
      .filter(span => span.end > from && span.start < to)
      .map(span => ({ start: Math.max(span.start, from) - from, end: Math.min(span.end, to) - from, shown: span.shown }))
      .filter(span => span.end > span.start);
    return new SecureString(this.text.substring(from, to), spans);
  }

  /** @return this text followed by `other`, a masked run that ends where one with the same `shown` begins merged into one. */
  private append(other: SecureString): SecureString {
    if (other.text === "") {
      return this;
    }
    if (this.text === "") {
      return other;
    }
    const offset = this.text.length;
    const spans = [...this.spans];
    for (const span of other.spans) {
      const last = spans[spans.length - 1];
      if (last !== undefined && last.end === offset && span.start === 0 && last.shown === span.shown) {
        spans[spans.length - 1] = { start: last.start, end: span.end + offset, shown: span.shown };
      } else {
        spans.push({ start: span.start + offset, end: span.end + offset, shown: span.shown });
      }
    }
    return new SecureString(this.text + other.text, spans);
  }

  /** @return the text with each of `matches` replaced by `replacement`. */
  private replaced(matches: Array<[number, number]>, replacement: SecureString | string): SecureString {
    let result = EMPTY;
    let at = 0;
    for (const [start, end] of matches) {
      result = result.concat(this.cut(at, start), replacement);
      at = end;
    }
    return matches.length === 0 ? this : result.concat(this.cut(at, this.text.length));
  }
}

/** The empty text. */
const EMPTY = SecureString.of("");

/**
 * Build a SecureString from a template: `secure\`https://${host}/v2/\``. Each
 * value is text (a string, as it is), a number, or a SecureString, whose
 * masked runs are kept.
 */
export function secure(strings: TemplateStringsArray, ...values: Array<SecureString | string | number>): SecureString {
  return strings.reduce<SecureString>(
    (built, literal, index) => (index === 0 ? built.concat(literal) : built.concat(secureOf(values[index - 1]), literal)),
    EMPTY
  );
}

/** @return `value` as a SecureString: a string or number with nothing masked. */
function secureOf(value: SecureString | string | number): SecureString {
  return value instanceof SecureString ? value : SecureString.of(String(value));
}

/** @return the text of `value`. */
function textOf(value: SecureString | string): string {
  return value instanceof SecureString ? value.toUnmaskedString() : value;
}

/** @return the start and end `String.prototype.slice` reads `start` and `end` as, in text of `length`. */
function sliceBounds(length: number, start = 0, end = length): [number, number] {
  const bound = (at: number): number => (at < 0 ? Math.max(length + at, 0) : Math.min(at, length));
  const from = bound(Number.isNaN(start) ? 0 : start);
  const to = bound(Number.isNaN(end) ? 0 : end);
  return [from, Math.max(from, to)];
}

/** @return where `pattern` matches `text`, as start and end: every match where `all`, else the first. */
function matchesOf(text: string, pattern: string | RegExp, all: boolean): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  if (typeof pattern === "string") {
    let at = text.indexOf(pattern);
    while (at !== -1) {
      found.push([at, at + pattern.length]);
      if (!all) {
        break;
      }
      const next = at + Math.max(pattern.length, 1);
      at = next > text.length ? -1 : text.indexOf(pattern, next);
    }
    return found;
  }
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (const match of text.matchAll(global)) {
    found.push([match.index, match.index + match[0].length]);
    if (!all) {
      break;
    }
  }
  return found;
}
