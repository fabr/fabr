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

import { Computable, cutToWidth, displayWidth, stripAnsi } from "@fabr-build/core";
import { Writable } from "node:stream";

/** Cursor up `n` lines, to column 1. */
const cursorUp = (n: number): string => `\x1b[${n}F`;
/** Erase from the cursor to the end of the screen. */
const ERASE_DOWN = "\x1b[0J";

/** How often the pane repaints while it is up, so elapsed times advance. */
const TICK_MS = 100;

/** The width of a terminal that reports none, or 0 (a pty whose size nobody set). */
const DEFAULT_COLUMNS = 80;

/** The narrowest width the pane is painted at. */
const MIN_COLUMNS = 24;

/**
 * The pane's row budget: 1/MAX_PANE_FRACTION of the screen's height, between
 * MIN_PANE_ROWS and MAX_PANE_ROWS. Keep it small: painting the pane scrolls
 * that many log lines into scrollback, and the space is left blank when the
 * pane shrinks.
 */
const MAX_PANE_FRACTION = 4;
const MAX_PANE_ROWS = 6;
const MIN_PANE_ROWS = 2;

/** The height of a terminal that reports none, or 0. */
const DEFAULT_ROWS = 24;

/** The stream the terminal writes to: a Writable that, on a tty, also carries
 *  the screen's measurements and emits "resize". */
type ScreenStream = Writable & { columns?: number; rows?: number };

/* The erasers of the streams painting a pane, run by one process exit hook
 * shared by them all. Erase the pane from the exit hook: process.exit runs no
 * `finally`. */
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
 * One row of the pane: what the work is (`left`), and its current state
 * (`right`: elapsed time, a download's bytes). Where the row does not fit, the
 * terminal truncates `left` first ({@link layoutRow}).
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
 * The source of the pane's content, asked afresh at every paint, given the
 * number of rows it may use. A source returning more rows than that is cut,
 * with a row counting the rest.
 */
export type PaneSource = (rows: number) => IPaneContent;

/**
 * fabr's stderr, which keeps a live pane painted below the text written to it.
 *
 * {@link write} writes a block of already-rendered text through unchanged,
 * erasing the pane before and painting it again after. With a pane, the
 * stream's own `write` is wrapped too, so a write fabr did not make (a node
 * warning, a library writing to `process.stderr`) is bracketed the same way;
 * the pane is not painted again until such a write has ended its line.
 *
 * The pane is painted from the {@link PaneSource} within the row budget
 * ({@link MAX_PANE_FRACTION}), each line cut to the terminal's width. It is
 * repainted on {@link paneChanged}, on a resize, and every {@link TICK_MS}
 * while it is up, and erased on {@link suspend} and as the process exits.
 *
 * Without a pane, {@link write} is a plain write.
 */
export class TerminalStream {
  /** The lines of pane painted below the cursor (0 = none). */
  private painted = 0;
  /** The text last painted; a repaint that would paint the same writes nothing. */
  private lastPainted = "";
  private source?: PaneSource;
  private timer?: NodeJS.Timeout;
  /** The number of suspensions in force; the pane stays erased until the last
   *  one is resumed (a prompt can come while a supervised child holds the terminal). */
  private suspended = 0;
  /** Whether this stream is writing, so the wrapped `write` lets its writes by. */
  private emitting = false;
  /** Whether the cursor is at the start of a line. Paint only there: a pane
   *  painted after a half-written line joins it, and its erase takes the line. */
  private lineStart = true;

  /**
   * @param out where text goes (process.stderr)
   * @param pane whether to paint the pane: false where `out` is not a tty
   */
  constructor(
    private readonly out: ScreenStream,
    private readonly pane: boolean
  ) {
    if (pane) {
      this.adoptForeignWrites();
      /* Repaint at once at the new width. The erase counts the lines laid out
       * at the old width, so a terminal that reflows on shrink (iTerm2, VTE)
       * can leave pane fragments behind, until later repaints overwrite them. */
      this.out.on("resize", () => this.repaint());
      /* Erased from the shared exit hook (see eraseOnExit). */
      eraseOnExit(() => this.erase());
    }
  }

  /**
   * Wrap `out`'s own `write`, so a write fabr did not make (node's own
   * warnings, anything writing to `process.stderr` directly) erases the pane
   * before it and paints it after. An unwrapped write would land below the
   * pane and leave every later erase counting from the wrong line.
   */
  private adoptForeignWrites(): void {
    const original = this.out.write.bind(this.out);
    const adopted: Writable["write"] = (chunk, encoding?, callback?) => {
      if (this.emitting) {
        /* This stream's own write, already between an erase and a paint. */
        return original(chunk as never, encoding as never, callback as never);
      }
      this.erase();
      const accepted = original(chunk as never, encoding as never, callback as never);
      /* A zero-length write moves no cursor: leave `lineStart` as it is. */
      if ((chunk as { length: number }).length !== 0) {
        this.lineStart = endsLine(chunk);
      }
      this.paint();
      return accepted;
    };
    this.out.write = adopted;
  }

  /** @return true if this stream paints a pane, otherwise false. */
  public get hasPane(): boolean {
    return this.pane;
  }

  /** Write a block of already-rendered text, ending it with a newline where it has none. */
  public write(text: string): void {
    this.erase();
    this.emit(text.endsWith("\n") ? text : text + "\n");
    this.lineStart = true;
    this.paint();
  }

  /** Write `text` to `out` as this stream's own, which the wrapped `write` lets by. */
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

  /** Repaint now: the pane's content may have changed. */
  public paneChanged(): void {
    this.repaint();
  }

  /**
   * Hand the terminal to something else that writes to it directly (a prompt
   * reading a line, an interactive child with inherited stdio): erase the pane
   * and paint none until each suspension is matched by a {@link resume}.
   */
  public suspend(): void {
    this.suspended++;
    this.erase();
    this.stopTicking();
  }

  /** Lift one suspension, painting the pane as it is now once none is left. */
  public resume(): void {
    if (this.suspended > 0) {
      this.suspended--;
    }
    if (this.suspended === 0) {
      this.paint();
    }
  }

  /**
   * Erase the whole pane and paint it as it is now, unless that would paint
   * what is already painted. Compare here, before erasing: an erase clears
   * `lastPainted`.
   */
  private repaint(): void {
    if (this.render() === this.lastPainted) {
      return;
    }
    this.erase();
    this.paint();
  }

  /** Erase the pane painted, if any. */
  private erase(): void {
    if (this.painted > 0) {
      this.emit(cursorUp(this.painted) + ERASE_DOWN);
      this.painted = 0;
      this.lastPainted = "";
      /* The erase leaves the cursor at column 0 of the pane's first line. */
      this.lineStart = true;
    }
  }

  /** Paint the pane below the cursor where it is at the start of a line, ticking while it is up. */
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
   * Render the pane as it should look now, each line cut to the terminal's
   * width; "" where there is none to paint (no pane, suspended, no rows, or a
   * terminal narrower than {@link MIN_COLUMNS}). Cut every line: the erase
   * counts the lines written, and a line that wraps takes two on the screen.
   */
  private render(): string {
    const content = this.pane && this.suspended === 0 ? this.source?.(this.rowBudget()) : undefined;
    if (content === undefined || content.rows.length === 0) {
      return "";
    }
    const width = this.width();
    if (width < MIN_COLUMNS) {
      return "";
    }
    const rows = this.fit(content.rows).map(row => layoutRow(row, width));
    return [truncate(content.heading, width), ...rows].map(line => line + "\n").join("");
  }

  /** Count the rows the pane may use (see {@link MAX_PANE_FRACTION}). */
  private rowBudget(): number {
    const height = this.out.rows || DEFAULT_ROWS;
    return Math.max(MIN_PANE_ROWS, Math.min(MAX_PANE_ROWS, Math.floor(height / MAX_PANE_FRACTION)));
  }

  /**
   * Cut `rows` to the row budget where they exceed it, the last row kept
   * replaced by one counting those cut ("… +24 more").
   */
  private fit(rows: IPaneRow[]): IPaneRow[] {
    const limit = this.rowBudget();
    if (rows.length <= limit) {
      return rows;
    }
    const kept = limit - 1;
    return [...rows.slice(0, kept), { left: `  … +${rows.length - kept} more`, right: "" }];
  }

  /** Count the columns a pane line may take: one short of the terminal's, so a
   *  full-width line cannot wrap. Use `||`, not `??`: a pty whose size nobody
   *  set reports 0 columns. */
  private width(): number {
    return (this.out.columns || DEFAULT_COLUMNS) - 1;
  }

  /** Repaint every {@link TICK_MS} while the pane is up. The timer is unref'd,
   *  so it never keeps the process alive. */
  private startTicking(): void {
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.repaint(), TICK_MS);
      this.timer.unref();
    }
  }

  /** Stop repainting on a timer. */
  private stopTicking(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The process's terminal, for code that must hand it over rather than write
 * to it (a prompt reading a line, an interactive child with inherited stdio).
 */
let active: TerminalStream | undefined;

/** Make `terminal` the one the hand-over functions below suspend and resume. */
export function setActiveTerminal(terminal: TerminalStream): void {
  active = terminal;
}

/**
 * Suspend the active terminal for as long as `run`'s chain takes, resuming it
 * when the chain settles, resolved or rejected, or where `run` throws.
 * Hand-overs nest: the pane returns when the last one ends.
 */
export function withTerminalSuspended<T>(run: () => Computable<T>): Computable<T> {
  suspendActiveTerminal();
  try {
    return run().finally(() => resumeActiveTerminal());
  } catch (err) {
    resumeActiveTerminal();
    throw err;
  }
}

/** Suspend the active terminal until {@link resumeActiveTerminal}, for a
 *  hand-over that ends with an event rather than a chain (the supervised
 *  `run -w` child, until it exits). */
export function suspendActiveTerminal(): void {
  active?.suspend();
}

/** Lift one suspension of the active terminal. */
export function resumeActiveTerminal(): void {
  active?.resume();
}

/** @return true if a written chunk left the cursor at the start of a fresh line, otherwise false. */
function endsLine(chunk: unknown): boolean {
  if (typeof chunk === "string") {
    return chunk.endsWith("\n");
  }
  return chunk instanceof Uint8Array && chunk.at(-1) === 0x0a;
}

/** The least gap between a row's two columns. */
const ROW_GAP = 2;

/** The column a row's right part starts at, where the terminal is wide enough. */
const ROW_RIGHT_COLUMN = 52;

/**
 * Lay a row out across `width` columns: the left, then the right pushed out
 * to {@link ROW_RIGHT_COLUMN}, or as far as fits, at least {@link ROW_GAP}
 * after the left. Where both do not fit, the left is truncated first, to
 * nothing where the right needs the whole row. A row with an empty right is
 * the left alone, with no trailing spaces.
 */
export function layoutRow(row: IPaneRow, width: number): string {
  const right = truncate(row.right, width);
  const rightWidth = visibleLength(right);
  if (rightWidth === 0) {
    return truncate(row.left, width);
  }
  const leftRoom = Math.max(0, width - rightWidth - ROW_GAP);
  const left = truncate(row.left, leftRoom);
  const leftWidth = visibleLength(left);
  if (leftWidth === 0) {
    /* No pad: it would push the row past `width`. */
    return right;
  }
  const column = Math.max(ROW_RIGHT_COLUMN, leftWidth + ROW_GAP);
  const pad = " ".repeat(Math.min(column, width - rightWidth) - leftWidth);
  return left + pad + right;
}

/** Count the columns `text` takes on a terminal: escapes take none, and a
 *  wide character (CJK, emoji) two. */
function visibleLength(text: string): number {
  return displayWidth(stripAnsi(text));
}

/**
 * Cut `text` to `width` columns, ending the cut with an ellipsis, its width
 * measured without ANSI escapes. Text that fits is returned as it is; text
 * that does not loses its escapes before it is cut, so no escape is left
 * partial or unterminated.
 */
export function truncate(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (displayWidth(plain) <= width) {
    return text;
  }
  if (width <= 0) {
    return "";
  }
  return cutToWidth(plain, width - 1).trimEnd() + "…";
}
