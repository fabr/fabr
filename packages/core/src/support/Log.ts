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

import { FileSource } from "../core/FileSet";
import { StringReader } from "./StringReader";

export interface ISourcePosition {
  fs: FileSource;
  file: string;
  offset: number;
  reader: StringReader;
}

/**
 * A source range: when endOffset (exclusive) is present the whole extent is
 * underlined in diagnostics; otherwise a single caret marks the position.
 */
export interface ISourceSpan extends ISourcePosition {
  endOffset?: number;
}

/**
 * A secondary annotation on a diagnostic, rendered as a `note:` block: its own
 * message, optionally anchored at a source span (with its own excerpt and
 * underline), and an optional label after the underline.
 */
export interface IDiagnosticNote {
  message: string;
  loc?: ISourceSpan;
  label?: string;
}

/**
 * The structured detail any diagnostic may carry alongside its template
 * params: the primary span (with an optional label on its underline),
 * secondary notes, and remedy suggestions (`help:` lines). A diagnostic with
 * a resolvable `loc` renders as a block (headline, `-->` location, gutter,
 * excerpt, underline); without one it stays a plain `level:message` line.
 */
export interface IDiagnosticDetail {
  loc?: ISourceSpan;
  label?: string;
  notes?: IDiagnosticNote[];
  help?: string[];
}

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

export class Diagnostic<T extends Record<string, any>> {
  private logLevel: LogLevel;
  private format: string;

  constructor(level: LogLevel, format: string) {
    this.logLevel = level;
    this.format = format;
  }

  public message(params: T): string {
    return this.format.replaceAll(/\{([a-zA-Z_]+)\}/g, (_match, p1) => params[p1]);
  }

  public get level(): LogLevel {
    return this.logLevel;
  }

  static Error<T extends Record<string, any>>(format: string): Diagnostic<T> {
    return new Diagnostic<T>(LogLevel.Error, format);
  }

  static Warn<T extends Record<string, any>>(format: string): Diagnostic<T> {
    return new Diagnostic<T>(LogLevel.Warn, format);
  }

  static Info<T extends Record<string, any>>(format: string): Diagnostic<T> {
    return new Diagnostic<T>(LogLevel.Info, format);
  }
}

export interface Log {
  log<T extends Record<string, any>>(diagnostic: Diagnostic<T>, params: T & IDiagnosticDetail): void;
}

function getLogLevelName(logLevel: LogLevel): string {
  switch (logLevel) {
    case LogLevel.Debug:
      return "debug";
    case LogLevel.Info:
      return "info";
    case LogLevel.Warn:
      return "warn";
    case LogLevel.Error:
      return "error";
  }
}

/* CSI sequences (colors, cursor movement) and OSC sequences (hyperlinks,
 * titles) — everything a tool plausibly embeds in its captured output. */
// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/** Remove ANSI escape sequences, leaving the plain text. */
export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_ESCAPES, "");
}

/* ANSI SGR codes for the block elements (rustc's palette) */
const SGR_ERROR = "1;31";
const SGR_WARN = "1;33";
const SGR_INFO = "1;36";
const SGR_GUTTER = "1;34";
const SGR_BOLD = "1";

export class LogFormatter implements Log {
  private logLevel: LogLevel;
  private out: (log: string) => void;
  private color: boolean;

  public constructor(logLevel: LogLevel, out: (log: string) => void, color = false) {
    this.logLevel = logLevel;
    this.out = out;
    this.color = color;
  }

  public log<T extends Record<string, any>>(diagnostic: Diagnostic<T>, params: T & IDiagnosticDetail): void {
    const level = diagnostic.level;
    if (level < this.logLevel) {
      return;
    }
    const message = diagnostic.message(params);
    /* A diagnostic without a resolvable primary position stays a plain
     * one-liner (progress and status lines depend on this form). */
    if (!params.loc?.reader.resolvePosition(params.loc.offset)) {
      this.emit(`${getLogLevelName(level)}:${message}`);
      return;
    }
    this.emit(this.renderBlock(level, message, params));
  }

  /** Message content may itself carry ANSI codes (captured tool output runs
   * with color forced — see Execute); when this formatter isn't painting,
   * embedded codes are stripped too, so non-TTY output is genuinely plain. */
  private emit(text: string): void {
    this.out(this.color ? text : stripAnsi(text));
  }

  /**
   * Render a positioned diagnostic as a block: severity headline, `-->`
   * location, gutter with the excerpt and an underline (labelled if the
   * caller supplied a label), then each note (with its own excerpt block when
   * positioned) and each help line. Multi-line messages put their first line
   * on the headline; the remainder (e.g. captured command output) follows the
   * primary excerpt verbatim.
   */
  private renderBlock(level: LogLevel, message: string, detail: IDiagnosticDetail): string {
    const sevSgr = level === LogLevel.Error ? SGR_ERROR : level === LogLevel.Warn ? SGR_WARN : SGR_INFO;
    /* The gutter is sized by the widest line number the block excerpts */
    const locs = [detail.loc, ...(detail.notes ?? []).map(note => note.loc)];
    const width = Math.max(
      ...locs.map(loc => String(loc?.reader.resolvePosition(loc.offset)?.line ?? 0).length)
    );
    const lines: string[] = [];
    const [headline, ...restLines] = message.split("\n");
    lines.push(`${this.paint(sevSgr, getLogLevelName(level))}${this.paint(SGR_BOLD, `: ${headline}`)}`);
    this.pushSpan(lines, width, detail.loc!, detail.label, sevSgr);
    lines.push(...restLines);
    for (const note of detail.notes ?? []) {
      const [first, ...rest] = note.message.split("\n");
      lines.push(`${this.paint(SGR_BOLD, "note")}: ${first}`);
      if (note.loc) {
        this.pushSpan(lines, width, note.loc, note.label, SGR_GUTTER);
      }
      lines.push(...rest);
    }
    for (const help of detail.help ?? []) {
      lines.push(`${this.paint(SGR_INFO, "help")}: ${help}`);
    }
    return lines.join("\n") + "\n";
  }

  /** Append one span's `--> file:line:col` + gutter + excerpt + underline. */
  private pushSpan(lines: string[], width: number, loc: ISourceSpan, label: string | undefined, markerSgr: string): void {
    const pos = loc.reader.resolvePosition(loc.offset);
    if (!pos) {
      return;
    }
    const bar = this.paint(SGR_GUTTER, `${" ".repeat(width + 1)}|`);
    lines.push(`${" ".repeat(width)}${this.paint(SGR_GUTTER, "-->")} ${loc.file}:${pos.line}:${pos.column}`);
    lines.push(bar);
    lines.push(`${this.paint(SGR_GUTTER, `${String(pos.line).padStart(width)} |`)} ${pos.lineText}`);
    /* Underline the span where an extent is known (clamped to the excerpt
     * line), else a single caret at the position */
    let extent = 1;
    if (loc.endOffset !== undefined && loc.endOffset > loc.offset) {
      const end = loc.reader.resolvePosition(loc.endOffset);
      extent =
        end && end.line === pos.line
          ? Math.max(1, end.column - pos.column)
          : Math.max(1, pos.lineText.length - pos.column + 1);
    }
    const marker = this.paint(markerSgr, "^".repeat(extent) + (label ? ` ${label}` : ""));
    lines.push(`${bar} ${" ".repeat(pos.column - 1)}${marker}`);
  }

  private paint(sgr: string, text: string): string {
    return this.color ? `\x1b[${sgr}m${text}\x1b[0m` : text;
  }
}
