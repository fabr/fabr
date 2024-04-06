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

import * as assert from "assert";

export interface IResolvedPosition {
  offset: number;
  line: number;
  column: number;
  lineText: string; // Text of the line in question.
}

const CHAR_NEWLINE = 10;

/**
 * String buffer + tokenizer
 */
export class StringReader {
  /**
   * The input string being read
   */
  private data: string;

  /**
   * The offset of the next character to be returned, as a direct
   * index into the string. (note this is _not_ a byte index into
   * the original file)
   */
  private offset: number;

  private currentChar: number | undefined;

  /**
   * Array of offsets corresponding to the first character of each line.
   */
  private lineTable: number[];

  constructor(input: string) {
    this.data = input;
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
   * Consume the given character - assert that the current character is indeed
   * the expected one, and then advances forward one character.
   * @param char expected value.
   */
  public consume(char: number | undefined): number | undefined {
    assert(this.currentChar === char);
    return this.next();
  }

  /**
   * Skip characters until the given callback returns true or EOF is reached.
   * The first character tested will be the current character (if not EOF)
   * @param test Function from codepoint to boolean.
   * @return the codepoint for which the test succeeded, or undefined if EOF
   * was reached.
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
   * Skip characters until the given callback returns true or EOF is reached,
   * and consumes that last character tested.
   * The first character tested will be the current character (if not EOF)
   * @param test Function from codepoint to boolean.
   * @return the codepoint after the one for which the test succeeded, or undefined if EOF
   * was reached.
   */
  public skipUntilAfter(test: (char: number) => boolean): number | undefined {
    this.skipUntil(test);
    return this.next();
  }

  /**
   * @returns the string of characters between the start position (inclusive) up to the
   *  end position (excluding the character at the end position).
   * @param start First character to include.
   * @param end Character after the last character to include. Optional: if not specified,
   *  returns all characters from start up to (but not including) the current offset.
   */
  public substring(start: number, end: number = this.offset): string {
    return this.data.substring(start, end);
  }

  /**
   * Resolve the offset to a human-friendly file position. Note this is relatively
   * expensive (O(lg N) in line count + O(N) in line width), but we should only be
   * doing this for final error reporting.
   *
   * Note: for offset === length we point at the end of the last line (for EOF)
   *
   * @return the source position, or undefined if the offset is out of range.
   * @param offset
   */
  public resolvePosition(offset: number | undefined): IResolvedPosition | undefined {
    if (offset === undefined || offset > this.data.length || offset < 0) {
      return undefined;
    } else {
      const line = this.getLineByOffset(offset);
      const lineStart = this.lineTable[line];
      const nextLine = this.lineTable[line + 1];
      const lineEnd = nextLine ? nextLine-1 : this.data.indexOf("\n",lineStart)
      const lineText = this.data.substring(lineStart, lineEnd === -1 ? undefined : lineEnd);
      return {
        offset,
        line: line+1,
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

  /**
   * Count the number of characters between the given start and end offsets.
   * @param startOffset
   * @param endOffset
   */
  private countCodePositions(startOffset: number, endOffset: number): number {
    let count = 0;
    for (let offset = startOffset; offset < endOffset; offset += this.data.codePointAt(offset)! > 0xffff ? 2 : 1) {
      count++;
    }
    return count;
  }

  /**
   * Return an empty JSON representation to avoid polluting output
   */
  public toJSON(): Record<string, unknown> {
    return {};
  }
}
