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
 */

/**
 * Diagnostics as the Language and Build Server Protocols carry them, made
 * from what fabr's diagnostics log reports with a position.
 */

import { type ISourceSpan, type Log, LogLevel } from "@fabr-build/core";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** The protocols' `DiagnosticSeverity`s. */
const DIAGNOSTIC_ERROR = 1;
const DIAGNOSTIC_WARNING = 2;

/** A range of a document: zero-based lines and characters. */
export interface IProtocolRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** A diagnostic, as LSP and BSP carry one. */
export interface IProtocolDiagnostic {
  range: IProtocolRange;
  severity: number;
  source: string;
  message: string;
  relatedInformation?: Array<{ location: { uri: string; range: IProtocolRange }; message: string }>;
}

/** @return the range `loc` covers, or undefined where its offset lies outside its text. */
export function rangeOf(loc: ISourceSpan): IProtocolRange | undefined {
  const start = loc.reader.resolvePosition(loc.offset);
  if (start === undefined) {
    return undefined;
  }
  const end = loc.reader.resolvePosition(loc.endOffset) ?? start;
  return {
    start: { line: start.line - 1, character: start.column - 1 },
    end: { line: end.line - 1, character: end.column - 1 },
  };
}

/** @return the URI of the document `loc` lies in, its file named from `sourceRoot`. */
export function documentOf(sourceRoot: string, loc: ISourceSpan): string {
  return pathToFileURL(path.resolve(sourceRoot, loc.file)).toString();
}

/**
 * @return a log forwarding to `log` that also adds each warning and error it is
 * given with a position to `into`, by the document it lies in, its positioned
 * notes as related information.
 */
export function collectingLog(sourceRoot: string, log: Log, into: Map<string, IProtocolDiagnostic[]>): Log {
  return {
    log: (diagnostic, params) => {
      log.log(diagnostic, params);
      const range = params.loc === undefined ? undefined : rangeOf(params.loc);
      if (range === undefined || diagnostic.level < LogLevel.Warn) {
        return;
      }
      const document = documentOf(sourceRoot, params.loc!);
      const related = (params.notes ?? []).flatMap(note => {
        const at = note.loc === undefined ? undefined : rangeOf(note.loc);
        return at === undefined ? [] : [{ location: { uri: documentOf(sourceRoot, note.loc!), range: at }, message: note.message }];
      });
      into.set(document, [
        ...(into.get(document) ?? []),
        {
          range,
          severity: diagnostic.level === LogLevel.Error ? DIAGNOSTIC_ERROR : DIAGNOSTIC_WARNING,
          source: "fabr",
          message: [diagnostic.message(params), ...(params.help ?? []).map(help => `help: ${help}`)].join("\n"),
          ...(related.length === 0 ? {} : { relatedInformation: related }),
        },
      ]);
    },
  };
}
