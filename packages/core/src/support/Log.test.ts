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

import { EMPTY_FILESET } from "../core/FileSet";
import { StringReader } from "./StringReader";
import { Diagnostic, ISourceSpan, LogFormatter, LogLevel } from "./Log";
import { expect } from "chai";

const DIAG_TEST = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_INFO = Diagnostic.Info<{ message: string }>("{message}");

const SOURCE = "first line\ndeps = one two;\nlast line\n";

/** A reader scanned to EOF: its line table (built lazily during reading, and
 * complete by the time diagnostics render in production) is populated. */
function readerFor(text: string): StringReader {
  const reader = new StringReader(text);
  while (!reader.eof()) {
    reader.next();
  }
  return reader;
}

function spanAt(offset: number, endOffset?: number): ISourceSpan {
  return { fs: EMPTY_FILESET, file: "TEST.fabr", reader: readerFor(SOURCE), offset, endOffset };
}

function render(params: Record<string, unknown>, color = false): string[] {
  const out: string[] = [];
  const log = new LogFormatter(LogLevel.Info, line => out.push(line), color);
  log.log(DIAG_TEST, { message: "something went wrong", ...params });
  return out.join("\n").split("\n");
}

describe("LogFormatter", () => {
  it("renders an unpositioned diagnostic as a plain line", () => {
    const out: string[] = [];
    const log = new LogFormatter(LogLevel.Info, line => out.push(line));
    log.log(DIAG_INFO, { message: "Building x" });
    expect(out).to.deep.equal(["info:Building x"]);
  });

  it("renders a positioned diagnostic as a block with an underline", () => {
    /* Span over "one" (offset 18, length 3, on line 2) */
    const lines = render({ loc: spanAt(18, 21), label: "required by a deps" });
    expect(lines[0]).to.equal("error: something went wrong");
    expect(lines[1]).to.equal(" --> TEST.fabr:2:8");
    expect(lines[2]).to.equal("  |");
    expect(lines[3]).to.equal("2 | deps = one two;");
    expect(lines[4]).to.equal("  |        ^^^ required by a deps");
  });

  it("falls back to a single caret without an extent", () => {
    const lines = render({ loc: spanAt(18) });
    expect(lines[4]).to.equal("  |        ^");
  });

  it("renders a locless diagnostic's notes as a block rather than dropping them", () => {
    /* A diagnostic with no primary span but with notes (e.g. a conflict raised
     * outside any target build, anchored only by its two attributed sides) still
     * renders the headline and every note — a positioned note keeps its excerpt. */
    const lines = render({ notes: [{ message: "one side", loc: spanAt(18, 21) }, { message: "at /path/to/file" }] });
    expect(lines[0]).to.equal("error: something went wrong");
    expect(lines).to.include("note: one side");
    expect(lines).to.include("2 | deps = one two;"); /* the positioned note keeps its excerpt */
    expect(lines).to.include("note: at /path/to/file");
  });

  it("renders notes with their own excerpts, and help lines", () => {
    const lines = render({
      loc: spanAt(18, 21),
      notes: [{ message: "required by b deps", loc: spanAt(22, 25) }, { message: "an unpositioned remark" }],
      help: ["try something else"],
    });
    expect(lines).to.include("note: required by b deps");
    expect(lines).to.include("  |            ^^^");
    expect(lines).to.include("note: an unpositioned remark");
    expect(lines).to.include("help: try something else");
  });

  it("puts multi-line message detail after the primary excerpt", () => {
    const lines = render({ loc: spanAt(18, 21), message: "failed:\n$ tool --arg\noutput line" });
    expect(lines[0]).to.equal("error: failed:");
    expect(lines[5]).to.equal("$ tool --arg");
    expect(lines[6]).to.equal("output line");
  });

  it("sizes the gutter to the widest excerpted line number", () => {
    /* An 11-line source so the note's line number is two digits wide */
    const reader = readerFor("a\n".repeat(10) + "deps = one;\n");
    const loc = { fs: EMPTY_FILESET, file: "TEST.fabr", reader, offset: 0, endOffset: 1 };
    const note = { message: "required by", loc: { ...loc, offset: 20 + 7, endOffset: 20 + 10 } };
    const lines = render({ loc, notes: [note] });
    expect(lines[1]).to.equal("  --> TEST.fabr:1:1");
    expect(lines[3]).to.equal(" 1 | a");
    expect(lines).to.include("11 | deps = one;");
  });

  it("colors the block when enabled", () => {
    const lines = render({ loc: spanAt(18, 21) }, true);
    expect(lines[0]).to.contain("\x1b[1;31merror\x1b[0m");
    expect(lines[0]).to.contain("something went wrong");
  });

  it("strips ANSI codes embedded in the message when color is off", () => {
    /* Captured tool output: SGR color, a cursor sequence, an OSC hyperlink */
    const message = "failed:\n\x1b[31mred text\x1b[0m \x1b[1A\x1b]8;;http://x\x07link\x1b]8;;\x07";
    const lines = render({ loc: spanAt(18, 21), message });
    expect(lines[5]).to.equal("red text link");
  });

  it("passes embedded ANSI codes through when color is on", () => {
    const lines = render({ loc: spanAt(18, 21), message: "failed:\n\x1b[31mred\x1b[0m" }, true);
    expect(lines[5]).to.equal("\x1b[31mred\x1b[0m");
  });
});
