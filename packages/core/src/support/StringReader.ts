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

import assert from "assert";

/** A position in the text: its offset, 1-based line and column (in code points), and its line's text. */
export interface IResolvedPosition {
  offset: number;
  line: number;
  column: number;
  lineText: string; // Text of the line in question.
}

const CHAR_NEWLINE = 10;

/**
 * A UTF-8 byte-order mark, which `readString("utf8")` keeps as a leading
 * U+FEFF. The reader drops a leading one: offsets, and the positions they
 * resolve to, are of the text without it.
 */
const BOM = "\uFEFF";

/** A cursor over a string, by code point, for a tokenizer: its offsets are UTF-16 indexes into the string. */
export class StringReader {
  /** The text being read. */
  private data: string;

  /** The UTF-16 index of the current character (not a byte offset into the file). */
  private offset: number;

  private currentChar: number | undefined;

  /** The offset of the first character of each line read so far. */
  private lineTable: number[];

  constructor(input: string) {
    this.data = input.startsWith(BOM) ? input.substring(BOM.length) : input;
    this.offset = 0;
    this.currentChar = this.data.codePointAt(0);
    this.lineTable = [0];
  }

  public current(): number | undefined {
    return this.currentChar;
  }

  public eof(): boolean {
    return this.currentChar === undefined;
  }

  public currentOffset(): number {
    return this.offset;
  }

  /**
   * @return the code point `delta` UTF-16 units ahead of the current one, or
   * undefined past the end, without advancing. For short lookahead (`->`
   * against a `-` in a name): `delta` counts UTF-16 units, not code points.
   */
  public peekAt(delta: number): number | undefined {
    return this.data.codePointAt(this.offset + delta);
  }

  /**
   * @return the next codepoint, or undefined for end of string.
   */
  public next(): number | undefined {
    if (this.currentChar === undefined) {
      return undefined;
    } else {
      this.offset += this.currentChar > 0xffff ? 2 : 1;
      if (this.currentChar === CHAR_NEWLINE) {
        this.lineTable.push(this.offset);
      }
    }
    return (this.currentChar = this.data.codePointAt(this.offset));
  }

  /**
   * Assert that the current character is `char`, and advance past it.
   * @return the next code point, or undefined at the end.
   */
  public consume(char: number | undefined): number | undefined {
    assert(this.currentChar === char);
    return this.next();
  }

  /**
   * Advance until `test` returns true of the current code point, testing the
   * current one first.
   * @return the code point `test` accepted, left current, or undefined at the end.
   */
  public skipUntil(test: (char: number) => boolean): number | undefined {
    while (this.currentChar !== undefined && !test(this.currentChar)) {
      this.offset += this.currentChar > 0xffff ? 2 : 1;
      if (this.currentChar === CHAR_NEWLINE) {
        this.lineTable.push(this.offset);
      }
      this.currentChar = this.data.codePointAt(this.offset);
    }
    return this.currentChar;
  }

  /**
   * Advance as {@link skipUntil} does, then past the code point `test` accepted.
   * @return the code point after it, or undefined at the end.
   */
  public skipUntilAfter(test: (char: number) => boolean): number | undefined {
    this.skipUntil(test);
    return this.next();
  }

  /**
   * Advance as {@link skipUntil} does, where `test` may itself advance the
   * reader (past a whole quoted string, say): where it has, the scan does not
   * advance again but tests the new current code point.
   * @return the code point `test` accepted, left current, or undefined at the end.
   */
  public scanUntil(test: (char: number) => boolean): number | undefined {
    while (this.currentChar !== undefined) {
      const offset = this.offset;
      if (test(this.currentChar)) {
        break;
      }
      if (this.offset === offset) {
        this.next();
      }
    }
    return this.currentChar;
  }

  /** @return the text from offset `start` up to `end` (the current offset by default), `end` excluded. */
  public substring(start: number, end: number = this.offset): string {
    return this.data.substring(start, end);
  }

  /**
   * Resolve an offset to its line and column, for reporting. An offset equal to
   * the text's length is the end of its last line. Lines are known only as far
   * as the reader has read: resolve an offset only once the reader has passed it.
   * @return the position, or undefined where the offset is undefined or out of range.
   */
  public resolvePosition(offset: number | undefined): IResolvedPosition | undefined {
    if (offset === undefined || offset > this.data.length || offset < 0) {
      return undefined;
    } else {
      const line = this.getLineByOffset(offset);
      const lineStart = this.lineTable[line];
      const nextLine = this.lineTable[line + 1];
      const lineEnd = nextLine ? nextLine - 1 : this.data.indexOf("\n", lineStart);
      const lineText = this.data.substring(lineStart, lineEnd === -1 ? undefined : lineEnd);
      return {
        offset,
        line: line + 1,
        column: this.countCodePositions(lineStart, offset) + 1,
        lineText,
      };
    }
  }

  private getLineByOffset(offset: number): number {
    let a = 0;
    let b = this.lineTable.length - 1;
    while (a !== b) {
      const idx = (a + b + 1) >> 1;
      if (offset < this.lineTable[idx]) {
        b = idx - 1;
      } else {
        a = idx;
      }
    }
    return a;
  }

  /** Count the code points from `startOffset` up to `endOffset`. */
  private countCodePositions(startOffset: number, endOffset: number): number {
    let count = 0;
    for (let offset = startOffset; offset < endOffset; offset += this.data.codePointAt(offset)! > 0xffff ? 2 : 1) {
      count++;
    }
    return count;
  }

  /** @return an empty object, so the reader adds nothing to a JSON rendering of what holds it. */
  public toJSON(): Record<string, unknown> {
    return {};
  }
}
