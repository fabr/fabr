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

/**
 * Diagnostics and ranges as the Language and Build Server Protocols carry
 * them: converted from what a server sent, and shown as VS Code's.
 */

import * as vscode from "vscode";

/** @return true if `value` is a JSON object, otherwise false. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A diagnostic, as LSP and BSP carry one. */
export interface IProtocolDiagnostic {
  range: IProtocolRange;
  severity?: number;
  message: string;
  relatedInformation?: Array<{ location: { uri: string; range: IProtocolRange }; message: string }>;
}

/** A range of a document, as LSP and BSP carry one: zero-based lines and characters. */
export interface IProtocolRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** @return `json` as a range, or undefined where it is not one. */
export function toProtocolRange(json: unknown): IProtocolRange | undefined {
  const position = (value: unknown): { line: number; character: number } | undefined =>
    isRecord(value) && typeof value.line === "number" && typeof value.character === "number"
      ? { line: value.line, character: value.character }
      : undefined;
  const start = isRecord(json) ? position(json.start) : undefined;
  const end = isRecord(json) ? position(json.end) : undefined;
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** @return `range` as VS Code's. */
export function toRange(range: IProtocolRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** @return `diagnostic` as VS Code's. */
export function toDiagnostic(diagnostic: IProtocolDiagnostic): vscode.Diagnostic {
  /* The protocols' severities count from 1 (error), VS Code's from 0. */
  const severity = [
    vscode.DiagnosticSeverity.Error,
    vscode.DiagnosticSeverity.Warning,
    vscode.DiagnosticSeverity.Information,
    vscode.DiagnosticSeverity.Hint,
  ][(diagnostic.severity ?? 1) - 1];
  const shown = new vscode.Diagnostic(toRange(diagnostic.range), diagnostic.message, severity ?? vscode.DiagnosticSeverity.Error);
  shown.source = "fabr";
  shown.relatedInformation = diagnostic.relatedInformation?.map(
    related =>
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.parse(related.location.uri), toRange(related.location.range)),
        related.message
      )
  );
  return shown;
}

/** @return the diagnostics in `json`, leaving out any entry (or related information) that is not one; none where `json` is not a list. */
export function toProtocolDiagnostics(json: unknown): IProtocolDiagnostic[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.flatMap((diagnostic): IProtocolDiagnostic[] => {
    const range = isRecord(diagnostic) ? toProtocolRange(diagnostic.range) : undefined;
    if (!isRecord(diagnostic) || range === undefined || typeof diagnostic.message !== "string") {
      return [];
    }
    const related = Array.isArray(diagnostic.relatedInformation)
      ? diagnostic.relatedInformation.flatMap(information => {
          const location = isRecord(information) && isRecord(information.location) ? information.location : undefined;
          const at = location === undefined ? undefined : toProtocolRange(location.range);
          return location !== undefined &&
            at !== undefined &&
            typeof location.uri === "string" &&
            typeof information.message === "string"
            ? [{ location: { uri: location.uri, range: at }, message: information.message }]
            : [];
        })
      : undefined;
    return [
      {
        range,
        message: diagnostic.message,
        ...(typeof diagnostic.severity === "number" ? { severity: diagnostic.severity } : {}),
        ...(related === undefined ? {} : { relatedInformation: related }),
      },
    ];
  });
}
