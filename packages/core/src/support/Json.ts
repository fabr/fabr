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

import { Computable } from "../core/Computable";
import { toError } from "../core/Errors";
import type { IFile } from "../core/FileSet";

/**
 * Reading third-party JSON — a registry document, a package.json, a report
 * written by someone else's tool.
 *
 * **Parse to `unknown`, then convert.** `JSON.parse` is typed `any`, so
 * `JSON.parse(text) as IThing` type-checks and then propagates a shape nothing
 * ever verified; the document says what it says, and the first field that isn't
 * what the interface promised throws a TypeError from whatever code finally
 * touched it — deep inside an evaluation, attributed to nothing, usually
 * failing far more than the one bad document.
 *
 * So a document is always read through a {@link JsonConverter} — `toJsonObject`
 * where the caller claims nothing more, a domain one (`toTestReport`) where the
 * whole document becomes a domain value. Malformed JSON and a converter's
 * refusal both throw, attributed to the document, so a caller holds a value and
 * not a maybe; the reader that genuinely wants leniency writes the one `catch`
 * itself.
 *
 * A cast is only honest where the shape was checked before it was written
 * (fabr's own memos and manifests) — and even then the check belongs in one
 * place, not at each read.
 */

/**
 * Converts a parsed document to the value a caller needs, or throws the reason
 * it cannot — succeed-or-throw, so the caller never handles a maybe. (A boolean
 * predicate could only say *false*, which is no diagnostic at all.)
 */
export type JsonConverter<T> = (json: unknown) => T;

/** Read a document from a file, which names itself in any error. */
export function readJsonFile<T>(file: IFile, convert: JsonConverter<T>): Computable<T> {
  return file.readString().then(content => parseJson(content, file.getDisplayName(), convert));
}

/**
 * Read a document from bytes, attributed to `what` — the document as its reader
 * names it ("response from NPM repository for 'pkg/1.0.0'", "package.json of
 * @scope/pkg"). For bytes with no file behind them, or a file whose own name
 * would not identify it.
 */
export function parseJson<T>(text: string | Buffer, what: string, convert: JsonConverter<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === "string" ? text : text.toString("utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${what}: ${toError(err).message}`);
  }
  try {
    return convert(parsed);
  } catch (err) {
    throw new Error(`Invalid ${what}: ${toError(err).message}`);
  }
}

/** The converter for a document nothing further is claimed about. */
export function toJsonObject(json: unknown): Record<string, unknown> {
  if (!isJsonObject(json)) {
    throw new Error("expected a JSON object");
  }
  return json;
}

/** A JSON object — the shape a value must have before any field can be read off
 * it. Excludes `null` and arrays, both of which are `typeof === "object"`. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
