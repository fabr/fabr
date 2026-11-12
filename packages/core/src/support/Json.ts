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
import { FabrError, toError } from "../core/Errors";
import type { IFile } from "../core/FileSet";

/**
 * Reading JSON that fabr did not write: a registry document, a package.json, a
 * report another tool wrote. Read each through a {@link JsonConverter}
 * (`toJsonObject` where nothing more is needed, a domain converter such as
 * `toTestReport` where the document becomes a domain value), never with
 * `JSON.parse(text) as IThing`. Malformed JSON and a converter's refusal both
 * throw, naming the document; a reader that wants to go on without it catches
 * that itself.
 */

/** A function converting a parsed document to a value, or throwing why it cannot. */
export type JsonConverter<T> = (json: unknown) => T;

/** Read a document from a file, which names itself in any error. */
export function readJsonFile<T>(file: IFile, convert: JsonConverter<T>): Computable<T> {
  return file.readString().then(content => parseJson(content, file.getDisplayName(), convert));
}

/**
 * Read a document from bytes, named in any error as `what` ("response from NPM
 * repository for 'pkg/1.0.0'", "package.json of @scope/pkg"): for bytes with no
 * file behind them, or a file whose own name would not identify it.
 */
export function parseJson<T>(text: string | Buffer, what: string, convert: JsonConverter<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === "string" ? text : text.toString("utf8"));
  } catch (err) {
    throw new FabrError(`Invalid JSON in ${what}: ${toError(err).message}`);
  }
  try {
    return convert(parsed);
  } catch (err) {
    throw new FabrError(`Invalid ${what}: ${toError(err).message}`);
  }
}

/** Convert a document that must be a JSON object, and nothing more. */
export function toJsonObject(json: unknown): Record<string, unknown> {
  if (!isJsonObject(json)) {
    throw new FabrError("expected a JSON object");
  }
  return json;
}

/** Convert a JSON list of strings. */
export function toStringList(json: unknown): string[] {
  if (!Array.isArray(json) || json.some(item => typeof item !== "string")) {
    throw new FabrError("expected a list of strings");
  }
  return json as string[];
}

/** @return true if `value` is a JSON object (not `null`, not an array), otherwise false. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
