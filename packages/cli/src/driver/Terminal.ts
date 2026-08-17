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

import { Computable, stripAnsi } from "@fabr-build/core";
import { Writable } from "node:stream";

/** Cursor up `n` lines, to column 1. */
const cursorUp = (n: number): string => `\x1b[${n}F`;
/** Erase from the cursor to the end of the screen. */
const ERASE_DOWN = "\x1b[0J";

/** How often the pane repaints while work is in flight, so elapsed times
 * advance. Fast enough to read as live, slow enough to cost nothing. */
const TICK_MS = 100;

/** Fallback width for a terminal that doesn't report one — or reports 0, which
 *  a pty with no known size does, and which is not a width. */
const DEFAULT_COLUMNS = 80;

/** Narrowest width the pane paints at all: below this the rows would be all
 *  ellipsis, and a row must never exceed the real width (a wrapped row desyncs
 *  the erase's line count). */
const MIN_COLUMNS = 24;

/**
 * The most of the screen the pane may take, as a fraction of its height, and
 * the ceiling and floor on that.
 *
 * Height is not just a matter of taste. Painting the pane scrolls that many
 * real log lines off the top of the screen, and when the pane later shrinks the
 * space cannot be refilled — the content that was there is in scrollback — so a
 * tall pane leaves a correspondingly tall hole above the prompt. The bound on
 * the pane is therefore also the bound on that hole.
 */
const MAX_PANE_FRACTION = 4;
const MAX_PANE_ROWS = 6;
const MIN_PANE_ROWS = 2;

/** Fallback height for a terminal that doesn't report one (see width()). */
const DEFAULT_ROWS = 24;

/** stderr as fabr holds it: a Writable that, when it is a real tty, also
 *  carries the screen's measurements and emits "resize". A plain pipe (or a
 *  test's capture) carries neither and gets the defaults. */
type ScreenStream = Writable & { columns?: number; rows?: number };

/* One process-level exit hook shared by every pane-painting stream (tests
 * construct many; per-instance hooks would pile up listeners): process.exit
 * runs no `finally`, and the driver routes signals through it deliberately —
 * so the pane is torn down from an exit hook or not at all, else a terminated
 * run leaves its rows on screen as if still running. */
const liveScreens = new Set<() => void>();
let exitHookInstalled = false;
function eraseOnExit(erase: () => void): void {
  liveScreens.add(erase);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => liveScreens.forEach(screen => screen()));
  }
}

/**
 * One row of the pane: what the work is, and its current state (elapsed time,
 * a download's bytes). Split because only the terminal knows the width — the
 * `right` column is the part that must survive a narrow terminal, so it is the
 * `left` that is truncated, and laying that out here keeps the decision with
 * the component holding the measurement.
 */
export interface IPaneRow {
  left: string;
  right: string;
}

/**
 * The live display at the bottom of the terminal: a heading and a row per unit
 * of work in flight.
 */
export interface IPaneContent {
  heading: string;
  rows: IPaneRow[];
}

/**
 * Where the pane's content comes from. A *source*, not a value, because the
 * pane is derived state that changes with the clock as much as with events —
 * a row's elapsed time advances while nothing at all happens, so anything
 * handed over as rendered text would freeze between events. Asked afresh on
 * every paint.
 *
 * It is given the number of rows it may use, and decides how to spend them:
 * only the terminal knows how big the screen is, and only the source knows
 * which of its rows are worth the space (and how to say what it left out).
 */
export type PaneSource = (rows: number) => IPaneContent;

/**
 * fabr's stderr, as a stream one component owns.
 *
 * Everything fabr writes to the terminal goes through here: rendered
 * diagnostics from the log, and build steps' output from the pump. Its whole
 * job is cursor management — it inspects nothing and decorates nothing, so
 * attribution (prefixing a step's lines) stays with the pump that knows where
 * a line came from, and diagnostic rendering stays with the formatter.
 *
 * Text is written a *block* at a time rather than a line at a time, so a
 * multi-line diagnostic — whose gutter and underline are aligned against
 * column 0 — can never be split across a repaint.
 *
 * Without a pane (not a tty), this is a direct write and nothing else: the
 * pane is a derived view of what the log already records, so its absence costs
 * no information.
 */
export class TerminalStream {
  /** Lines of pane currently painted below the cursor (0 = none). */
  private painted = 0;
  /** What was last painted, so an unchanged repaint (a tick whose elapsed times
   *  rounded to the same text) writes nothing at all. */
  private lastPainted = "";
  private source?: PaneSource;
  private timer?: NodeJS.Timeout;
  /** Depth of hand-overs in force — suspensions nest, since a prompt can fire
   *  while a supervised child already owns the terminal: the pane stays erased,
   *  and repaints are suppressed, until the *last* one lifts. */
  private suspended = 0;
  /** Set while *we* are the one writing, so adopted foreign writes (below) do
   *  not recurse back through the erase/repaint they exist to perform. */
  private emitting = false;
  /** Whether the cursor is at the start of a line. A foreign write that ends
   *  mid-line has nowhere to put a pane — painting there would append the
   *  heading to somebody's half-written line, and the next erase would take
   *  that line with it — so the pane waits for the newline. */
  private lineStart = true;

  /**
   * @param out where rendered text goes (process.stderr in production)
   * @param pane whether to paint the in-flight pane at all — false for a
   *   non-tty, where cursor movement would be noise in a log file
   */
  constructor(
    private readonly out: ScreenStream,
    private readonly pane: boolean
  ) {
    if (pane) {
      this.adoptForeignWrites();
      /* A resize invalidates every truncation the pane made, and the erase
       * depends on those truncations having held (a wrapped row occupies two
       * screen lines and would desync the count). Repaint against the new
       * width immediately rather than waiting for the tick. */
      this.out.on("resize", () => this.repaint());
      /* Torn down from the shared exit hook (see eraseOnExit) or not at all. */
      eraseOnExit(() => this.erase());
    }
  }

  /**
   * Bring writes fabr didn't make through the same erase/repaint — node's own
   * warnings (a deprecation notice from a dependency's first URL parse, an
   * experimental-feature notice), and anything else that reaches for
   * `process.stderr` directly.
   *
   * This is not belt-and-braces: such a write lands *below* the painted pane
   * and moves the cursor, after which every erase counts back from the wrong
   * line — stranding a copy of the pane on screen while the live one carries
   * on elsewhere. Owning the stream has to mean the stream, not the writes we
   * happen to know about; a warning fabr never emitted is exactly the case
   * that cannot be found by reading fabr's own call sites.
   */
  private adoptForeignWrites(): void {
    const original = this.out.write.bind(this.out);
    const adopted: Writable["write"] = (chunk, encoding?, callback?) => {
      if (this.emitting) {
        /* Ours — already bracketed by the erase/repaint that called it. */
        return original(chunk as never, encoding as never, callback as never);
      }
      this.erase();
      const accepted = original(chunk as never, encoding as never, callback as never);
      this.lineStart = endsLine(chunk);
      this.paint();
      return accepted;
    };
    this.out.write = adopted;
  }

  /** Whether this stream paints a live pane at all. Read by whoever is
   *  deciding what the *log* must carry: with a pane showing what is running,
   *  the log needn't also announce it. */
  public get hasPane(): boolean {
    return this.pane;
  }

  /** Write a block of already-rendered text (trailing newline supplied here). */
  public write(text: string): void {
    this.erase();
    this.emit(text.endsWith("\n") ? text : text + "\n");
    this.lineStart = true;
    this.paint();
  }

  /** Write ours, marked as ours so {@link adoptForeignWrites} lets it by. */
  private emit(text: string): void {
    this.emitting = true;
    try {
      this.out.write(text);
    } finally {
      this.emitting = false;
    }
  }

  /** Install what the pane paints (see {@link PaneSource}). */
  public setPaneSource(source: PaneSource): void {
    this.source = source;
    this.repaint();
  }

  /** The pane's content may have changed — repaint now rather than at the next
   *  tick, so a row appears and disappears with the event that caused it. */
  public paneChanged(): void {
    this.repaint();
  }

  /**
   * Hand the terminal to something else that writes to it directly — a prompt
   * reading a line, an interactive child with inherited stdio. The pane is
   * erased and stays erased until {@link resume}; work carries on being
   * tracked, so resuming shows the current state rather than a stale snapshot.
   */
  public suspend(): void {
    this.suspended++;
    this.erase();
    this.stopTicking();
  }

  public resume(): void {
    if (this.suspended > 0) {
      this.suspended--;
    }
    if (this.suspended === 0) {
      this.paint();
    }
  }

  /**
   * Redraw in place: erase what is up and paint what is current. The whole pane
   * goes, since a row leaving shifts every row below it.
   *
   * Compared against what is already on screen *before* erasing — a tick whose
   * elapsed times rendered to the same text has nothing to say, and a terminal
   * over a slow link should not pay for it. (The comparison has to happen here
   * rather than in {@link paint}: erasing is itself a write, and by the time
   * paint runs the screen no longer holds what it is being compared to.)
   */
  private repaint(): void {
    if (this.render() === this.lastPainted) {
      return;
    }
    this.erase();
    this.paint();
  }

  private erase(): void {
    if (this.painted > 0) {
      this.emit(cursorUp(this.painted) + ERASE_DOWN);
      this.painted = 0;
      this.lastPainted = "";
      /* The erase leaves the cursor at column 0 of the pane's first line. */
      this.lineStart = true;
    }
  }

  private paint(): void {
    const text = this.lineStart ? this.render() : "";
    if (text.length > 0) {
      this.emit(text);
      this.painted = text.split("\n").length - 1;
      this.startTicking();
    } else {
      this.stopTicking();
    }
    this.lastPainted = text;
  }

  /**
   * The pane as it should look now — empty when there is none to paint (no
   * terminal, suspended, or no work in flight: an empty pane is nothing at all,
   * not a bare heading over an idle build).
   *
   * Every line is truncated to the terminal width, because a line that wraps
   * occupies two *screen* lines while the erase counts the lines it wrote — one
   * wrapped row and the pane eats a line of scrollback on every repaint.
   */
  private render(): string {
    const content = this.pane && this.suspended === 0 ? this.source?.(this.rowBudget()) : undefined;
    if (content === undefined || content.rows.length === 0) {
      return "";
    }
    const width = this.width();
    if (width < MIN_COLUMNS) {
      /* Too narrow to say anything useful — and an over-wide row would wrap,
       * desyncing the erase's line count. */
      return "";
    }
    const rows = this.fit(content.rows).map(row => layoutRow(row, width));
    return [truncate(content.heading, width), ...rows].map(line => line + "\n").join("");
  }

  /**
   * How many rows the screen can spare (see {@link MAX_PANE_FRACTION}). Told to
   * the pane source, which spends them; only this component knows the screen.
   */
  private rowBudget(): number {
    const height = this.out.rows || DEFAULT_ROWS;
    return Math.max(MIN_PANE_ROWS, Math.min(MAX_PANE_ROWS, Math.floor(height / MAX_PANE_FRACTION)));
  }

  /**
   * The backstop for a source that overspends its budget: cut, and say so
   * rather than truncate silently — a pane showing 6 of 30 with no sign of the
   * other 24 reads as "that is everything running".
   */
  private fit(rows: IPaneRow[]): IPaneRow[] {
    const limit = this.rowBudget();
    if (rows.length <= limit) {
      return rows;
    }
    /* The cut line takes one of the budgeted rows itself — the bound on the
     * pane is the bound on the scrollback hole it leaves. */
    const kept = limit - 1;
    return [...rows.slice(0, kept), { left: `  … +${rows.length - kept} more`, right: "" }];
  }

  /** The columns available to a pane line, one short of the terminal's own so a
   *  full-width line can't wrap. `||`, not `??`: a pty whose size nobody set
   *  reports 0 columns, which is an absence dressed as a number. */
  private width(): number {
    return (this.out.columns || DEFAULT_COLUMNS) - 1;
  }

  /** Repaint on a timer while rows are up, so their elapsed times advance.
   *  Unref'd: a pane must never be the reason the process stays alive. */
  private startTicking(): void {
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.repaint(), TICK_MS);
      this.timer.unref();
    }
  }

  private stopTicking(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The run's terminal, for the code that must hand it over rather than write to
 * it — a prompt reading a line, an interactive child with inherited stdio.
 * Module-level for the same reason Execute tracks its interactive child that
 * way: "who owns the terminal right now" is a property of the process, and the
 * alternative is threading a display object through call paths that have no
 * other interest in one.
 */
let active: TerminalStream | undefined;

export function setActiveTerminal(terminal: TerminalStream): void {
  active = terminal;
}

/**
 * Hand the terminal to something that writes to it directly, for as long as
 * `run`'s chain takes. Suspending is unconditional and resuming happens on
 * settle either way: a program that fails still had the terminal, and leaving
 * the pane suspended would silently disable it for the rest of the run.
 * Hand-overs nest (a prompt can fire while a supervised child already owns the
 * terminal): the pane returns when the last one ends, not the first.
 */
export function withTerminalSuspended<T>(run: () => Computable<T>): Computable<T> {
  suspendActiveTerminal();
  /* A synchronous throw must still resume, or the pane is silently disabled
   * for the rest of the run. */
  try {
    return run().finally(() => resumeActiveTerminal());
  } catch (err) {
    resumeActiveTerminal();
    throw err;
  }
}

/** The unbracketed form, for a hand-over whose end is an event rather than the
 *  settling of a chain (the supervised `run -w` child, which outlives the build
 *  that launched it and is only over when it exits). */
export function suspendActiveTerminal(): void {
  active?.suspend();
}

export function resumeActiveTerminal(): void {
  active?.resume();
}

/** Whether a written chunk left the cursor at the start of a fresh line. */
function endsLine(chunk: unknown): boolean {
  if (typeof chunk === "string") {
    return chunk.endsWith("\n");
  }
  return chunk instanceof Uint8Array && chunk.at(-1) === 0x0a;
}

/** The gap held between a row's two columns, so they never run together. */
const ROW_GAP = 2;

/** Where a row's right column starts on a comfortably wide terminal — enough
 *  for a target name, so the states line up and read as a column. */
const ROW_RIGHT_COLUMN = 52;

/**
 * Lay a row out across `width` columns: the left, then the right pushed out to
 * {@link ROW_RIGHT_COLUMN} (or as far as it fits), the LEFT giving way when the
 * terminal is too narrow for both. A row's right column is what changes — the
 * elapsed time, a download's fraction — so it is what must survive; a truncated
 * target name is still recognizable, a truncated percentage is nothing.
 */
export function layoutRow(row: IPaneRow, width: number): string {
  const right = truncate(row.right, width);
  if (visibleLength(right) === 0) {
    /* Nothing to hold a column for — and trailing spaces are invisible until
     * they are selected and copied. */
    return truncate(row.left, width);
  }
  const rightWidth = visibleLength(right);
  const leftRoom = Math.max(0, width - rightWidth - ROW_GAP);
  const left = truncate(row.left, leftRoom);
  const column = Math.max(ROW_RIGHT_COLUMN, visibleLength(left) + ROW_GAP);
  const pad = " ".repeat(Math.max(ROW_GAP, Math.min(column, width - rightWidth) - visibleLength(left)));
  return left + pad + right;
}

/** Printable width: escapes occupy no columns. */
function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Cut `text` to `width` printable columns, marking the cut with an ellipsis.
 * ANSI escapes occupy no columns, so width is measured without them — a line
 * that only *looks* long because it is colored is left as it is.
 *
 * An over-length line that *does* carry escapes is stripped before cutting:
 * slicing mid-sequence would emit a partial escape, and slicing after one
 * would leave the color unterminated for the rest of the screen. Losing the
 * color of a too-long pane row is the cheaper failure — the row's width is
 * what the erase depends on being right.
 */
export function truncate(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length <= width) {
    return text;
  }
  if (width <= 0) {
    return "";
  }
  return (text === plain ? text : plain).slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}
