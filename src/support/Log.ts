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

import { IFileSetProvider } from "../core/FileSet";
import { StringReader } from "./StringReader";

export interface ISourcePosition {
  fs: IFileSetProvider;
  file: string;
  offset: number;
  reader: StringReader;
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

  static Error<T>(format: string): Diagnostic<T> {
    return new Diagnostic<T>(LogLevel.Error, format);
  }

  static Warn<T>(format: string): Diagnostic<T> {
    return new Diagnostic<T>(LogLevel.Warn, format);
  }

  static Info<T>(format: string): Diagnostic<T> {
    return new Diagnostic<T>(LogLevel.Info, format);
  }
}

export interface Log {
  log<T>(diagnostic: Diagnostic<T>, params: T): void;
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

export class LogFormatter implements Log {
  private logLevel: LogLevel;
  private out: (log: string) => void;

  public constructor(logLevel: LogLevel, out: (log: string) => void) {
    this.logLevel = logLevel;
    this.out = out;
  }

  public log<T>(diagnostic: Diagnostic<T>, params: T & { loc?: ISourcePosition }): void {
    const level = diagnostic.level;
    if (level < this.logLevel) {
      return;
    }

    const resolvedPos = params.loc?.reader.resolvePosition(params.loc.offset);
    const message = diagnostic.message(params);
    if (resolvedPos) {
      const filename = params.loc?.file;
      const logline = `${filename}:${resolvedPos.line}:${resolvedPos.column}:${getLogLevelName(level)}:${message}\n`;
      const text = resolvedPos.lineText + "\n";
      const caret = " ".repeat(resolvedPos.column - 1) + "^\n";
      this.out(logline + text + caret);
    } else {
      const logline = `${getLogLevelName(level)}:${message}`;
      this.out(logline);
    }
  }
}

export const defaultLog = new LogFormatter(LogLevel.Info, console.log);
