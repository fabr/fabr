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

import { expect } from "chai";
import { Writable } from "node:stream";
import { IPaneContent, layoutRow, TerminalStream, truncate } from "./Terminal";

/** A stand-in for stderr that records what was written, so the exact escape
 *  sequences (and their order against the text) can be asserted. */
class CapturedStream extends Writable {
  public written: string[] = [];

  public _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.written.push(chunk.toString());
    done();
  }

  /** Everything written since the last {@link take}. */
  public take(): string {
    const text = this.written.join("");
    this.written = [];
    return text;
  }
}

const pane = (...rows: string[]): IPaneContent => ({
  heading: "Running:",
  rows: rows.map(text => ({ left: text, right: "" })),
});

describe("TerminalStream", () => {
  describe("without a pane (not a tty)", () => {
    it("writes text straight through, with no cursor movement at all", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, false);
      terminal.setPaneSource(() => pane("  Building a    1ms"));
      terminal.write("info:Building a");
      /* The pane is a derived view of what the log already records — with
       * nowhere to paint it, its absence must cost nothing else. */
      expect(out.take()).to.equal("info:Building a\n");
    });

    it("supplies the trailing newline only when the text lacks one", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, false);
      terminal.write("one\n");
      terminal.write("two");
      expect(out.take()).to.equal("one\ntwo\n");
    });
  });

  describe("with a pane", () => {
    it("paints the heading and rows below the text it writes", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1ms"));
      out.take();
      terminal.write("info:Building b");
      /* The pane painted when its source was installed, so this write erases
       * that (two lines: heading + row) before writing, then repaints. */
      expect(out.take()).to.equal("\x1b[2F\x1b[0Jinfo:Building b\nRunning:\n  Building a    1ms\n");
    });

    it("erases exactly the lines it painted before writing the next block", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1ms", "  Building b    0ms"));
      terminal.write("info:one");
      out.take();
      terminal.write("info:two");
      /* Three lines were painted (heading + two rows): the erase must move up
       * exactly three, or the pane eats a line of scrollback per repaint. */
      expect(out.take()).to.equal("\x1b[3F\x1b[0Jinfo:two\nRunning:\n  Building a    1ms\n  Building b    0ms\n");
    });

    it("paints nothing when no work is in flight", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane());
      out.take();
      terminal.write("info:Built a");
      /* No stray heading over an idle build, and nothing to erase next time. */
      expect(out.take()).to.equal("info:Built a\n");
    });

    it("pulls its content afresh on every paint, so elapsed times advance", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      let elapsed = 1;
      terminal.setPaneSource(() => pane(`  Building a    ${elapsed}ms`));
      out.take();
      elapsed = 2;
      terminal.paneChanged();
      expect(out.take()).to.contain("Building a    2ms");
    });

    it("writes nothing for a repaint whose content is unchanged", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1.2s"));
      out.take();
      terminal.paneChanged();
      /* A tick whose times rounded to the same text has nothing to say — and a
       * terminal over a slow link should not pay for it. */
      expect(out.take()).to.equal("");
    });

    it("adopts a write it did not make, so the pane is not stranded above it", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1ms"));
      out.take();

      /* Node's own warnings reach stderr without passing through here. Left
       * alone, such a write lands below the painted pane and moves the cursor,
       * after which every erase counts back from the wrong line. */
      out.write("(node:1) Warning: something\n");
      expect(out.take()).to.equal("\x1b[2F\x1b[0J(node:1) Warning: something\nRunning:\n  Building a    1ms\n");

      /* And the accounting still holds afterwards: two lines up, as painted. */
      terminal.write("info:next");
      expect(out.take()).to.equal("\x1b[2F\x1b[0Jinfo:next\nRunning:\n  Building a    1ms\n");
    });

    it("waits for the newline before repainting under a half-written line", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1ms"));
      out.take();

      /* Painting here would append the heading to somebody's unfinished line,
       * and the next erase would take that line with it. */
      out.write("progress: ");
      expect(out.take()).to.equal("\x1b[2F\x1b[0Jprogress: ");
      terminal.setPaneSource(() => pane("  Building a    2ms"));
      expect(out.take()).to.equal("");

      out.write("done\n");
      expect(out.take()).to.equal("done\nRunning:\n  Building a    2ms\n");
    });

    it("cuts the pane to what the screen can spare, saying what it dropped", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane(...Array.from({ length: 20 }, (_, n) => `  Building //t${n}`)));
      /* Painting N lines scrolls N real log lines off the top, and a later
       * shrink cannot refill that space — so the bound on the pane is the bound
       * on the hole it leaves. Never a silent cut: 6 of 20 with no sign of the
       * other 14 would read as "that is everything running". */
      const painted = out.take().split("\n").filter(line => line.length > 0);
      /* Heading + the 6 budgeted rows, the cut line taking the sixth. */
      expect(painted).to.have.length(7);
      expect(painted[0]).to.equal("Running:");
      expect(painted[6]).to.equal("  … +15 more");
    });

    it("erases while suspended and repaints on resume", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1ms"));
      out.take();

      terminal.suspend();
      expect(out.take()).to.equal("\x1b[2F\x1b[0J");
      /* While something else owns the terminal, fabr's own lines still print —
       * only the live display stands down. */
      terminal.write("info:still logging");
      expect(out.take()).to.equal("info:still logging\n");

      terminal.resume();
      expect(out.take()).to.equal("Running:\n  Building a    1ms\n");
    });

    it("nests suspensions: the pane returns when the last one lifts, not the first", () => {
      const out = new CapturedStream();
      const terminal = new TerminalStream(out, true);
      terminal.setPaneSource(() => pane("  Building a    1ms"));
      out.take();

      /* A prompt can fire while a supervised child already owns the terminal;
       * its resume must not hand the screen back under the child. */
      terminal.suspend();
      terminal.suspend();
      terminal.resume();
      out.take();
      terminal.paneChanged();
      expect(out.take()).to.equal("");

      terminal.resume();
      expect(out.take()).to.equal("Running:\n  Building a    1ms\n");
    });
  });
});

describe("layoutRow", () => {
  it("pushes the right column out to a fixed column on a wide terminal, so rows align", () => {
    const laid = layoutRow({ left: "  Building //a", right: "1ms" }, 79);
    expect(laid).to.equal("  Building //a" + " ".repeat(38) + "1ms");
    expect(laid.indexOf("1ms")).to.equal(52);
  });

  it("gives way on the left when the terminal is too narrow for both columns", () => {
    /* The right column is what changes — a truncated name is still
     * recognizable, a truncated percentage is nothing. */
    const laid = layoutRow({ left: "  Building something long name", right: "1ms" }, 30);
    expect(laid).to.equal("  Building something lon…  1ms");
    expect(laid.length).to.equal(30);
  });

  it("emits no trailing spaces for a row with no right column", () => {
    expect(layoutRow({ left: "  Building //a", right: "" }, 79)).to.equal("  Building //a");
  });

  it("never lays out wider than the terminal", () => {
    const laid = layoutRow({ left: "x".repeat(100), right: "12% of 5.8 MB  4.1s" }, 40);
    expect(laid.length).to.be.at.most(40);
    expect(laid).to.contain("12% of 5.8 MB  4.1s");
  });
});

describe("truncate", () => {
  it("leaves a line that fits", () => {
    expect(truncate("Building a", 20)).to.equal("Building a");
  });

  it("cuts an over-long line and marks the cut", () => {
    expect(truncate("Building a very long target name", 12)).to.equal("Building a…");
  });

  it("measures width without ANSI, which occupies no columns", () => {
    const colored = "\x1b[1mBuilding a\x1b[0m";
    expect(truncate(colored, 12)).to.equal(colored);
  });

  it("strips escapes from an over-long colored line rather than cutting into one", () => {
    /* Slicing mid-sequence emits a partial escape; slicing after one leaves the
     * color unterminated for the rest of the screen. The row's width is what
     * the erase depends on, so the color is what gives way. */
    expect(truncate("\x1b[1mBuilding a long name\x1b[0m", 8)).to.equal("Buildin…");
  });
});
