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

import { ISourceSpan } from "./Log";

/**
 * The analysis report fabr writes for code-scanning services: SARIF (Static
 * Analysis Results Interchange Format, OASIS, version 2.1.0), the members fabr
 * uses of https://docs.oasis-open.org/sarif/sarif/v2.1.0/. A report is one
 * run of one tool: its rules (what can be found) and its results (what was),
 * each result located in a source file where it has a place.
 */
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/** The base a result's `uri` is relative to: the root of the source tree, as code-scanning services name it. */
export const SARIF_SOURCE_ROOT = "%SRCROOT%";

export type SarifLevel = "none" | "note" | "warning" | "error";

export interface ISarifMessage {
  text: string;
}

/** A rule: one kind of result a tool reports, which its results name by `id`. */
export interface ISarifRule {
  id: string;
  shortDescription: ISarifMessage;
  helpUri?: string;
  /** Code-scanning conventions ride here: `security-severity` (a CVSS-scaled score as text) and `tags`. */
  properties?: Record<string, unknown>;
}

export interface ISarifRegion {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  /** The column after the region's last character. */
  endColumn?: number;
}

export interface ISarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId?: string };
    region?: ISarifRegion;
  };
}

export interface ISarifResult {
  ruleId: string;
  /** The rule's index in the run's `rules`. */
  ruleIndex: number;
  level: SarifLevel;
  message: ISarifMessage;
  locations?: ISarifLocation[];
  /** Why the result does not stand, where it does not: `inSource` for a
   * suppression the project declares. */
  suppressions?: Array<{ kind: "inSource" | "external"; justification?: string }>;
  properties?: Record<string, unknown>;
}

export interface ISarifTool {
  name: string;
  version?: string;
  informationUri?: string;
  rules: ISarifRule[];
}

export interface ISarifRun {
  tool: { driver: ISarifTool };
  results: ISarifResult[];
  /** What the run covered, as the tool describes it. */
  properties?: Record<string, unknown>;
}

export interface ISarifLog {
  $schema: string;
  version: "2.1.0";
  runs: ISarifRun[];
}

/** Make the document of one run of `tool` with `results`, described by `properties`. */
export function sarifLog(tool: ISarifTool, results: ISarifResult[], properties?: Record<string, unknown>): ISarifLog {
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{ tool: { driver: tool }, results, ...(properties === undefined ? {} : { properties }) }],
  };
}

/**
 * Locate a result at `span`, a position in a build file of the source tree:
 * the file relative to {@link SARIF_SOURCE_ROOT}, and its line and column,
 * through the span's end where it has one. The caller says the span is in
 * the source tree: a position elsewhere has no uri the tree's root resolves.
 */
export function sarifLocation(span: ISourceSpan): ISarifLocation {
  const start = span.reader.resolvePosition(span.offset);
  const end = span.endOffset === undefined ? undefined : span.reader.resolvePosition(span.endOffset);
  const region: ISarifRegion | undefined =
    start === undefined
      ? undefined
      : {
          startLine: start.line,
          startColumn: start.column,
          ...(end === undefined ? {} : { endLine: end.line, endColumn: end.column }),
        };
  return {
    physicalLocation: {
      artifactLocation: { uri: span.file, uriBaseId: SARIF_SOURCE_ROOT },
      ...(region === undefined ? {} : { region }),
    },
  };
}
