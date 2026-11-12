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

/*
 * Reading JSON documents fabr did not write (a package's manifest, a source map
 * a tool emitted, a docblock's options): parsed to `unknown`, then converted to
 * the value a caller needs. The tools' copy of core's `support/Json`, which a
 * tool cannot import at runtime.
 */

/**
 * Converts a parsed document to the value a caller needs, or throws the reason
 * it cannot.
 */
export type JsonConverter<T> = (json: unknown) => T;

/** Read a document from `text`, attributed to `what` in any error. */
export function parseJson<T>(text: string | Buffer, what: string, convert: JsonConverter<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === "string" ? text : text.toString("utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return convert(parsed);
  } catch (err) {
    throw new Error(`Invalid ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Convert a document nothing further is claimed about: any JSON object. */
export function toJsonObject(json: unknown): Record<string, unknown> {
  if (!isJsonObject(json)) {
    throw new Error("expected a JSON object");
  }
  return json;
}

/** @return true if `value` is a JSON object, otherwise false. Excludes `null`
 * and arrays, both of which are `typeof === "object"`. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
