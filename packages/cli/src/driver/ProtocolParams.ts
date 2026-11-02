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
 * The parameters of the requests and notifications the Build and Language
 * Server Protocols send a server, converted from what a client sent: each
 * converter returns the parameters or throws {@link InvalidParams}.
 */

import { isJsonObject } from "@fabr-build/core";
import { InvalidParams } from "./JsonRpc";

/** A position in a document: a zero-based line and UTF-16 character. */
export interface IPosition {
  line: number;
  character: number;
}

/** @return `value`'s field `name`, an object, or throw where it is none. */
function objectAt(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const field = value[name];
  if (!isJsonObject(field)) {
    throw new InvalidParams(`'${name}' is not an object`);
  }
  return field;
}

/** @return `value`'s field `name`, a string, or throw where it is none. */
function stringAt(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") {
    throw new InvalidParams(`'${name}' is not a string`);
  }
  return field;
}

/** @return `params`, an object, or throw where they are none. */
function toObject(params: unknown): Record<string, unknown> {
  if (!isJsonObject(params)) {
    throw new InvalidParams("the parameters are not an object");
  }
  return params;
}

/** Convert the parameters naming build targets (`buildTarget/sources`, `compile`, `test`, …): their URIs, and the request's `originId` where it gives one. */
export function toTargetsParams(params: unknown): { targets: string[]; originId?: string } {
  const value = toObject(params);
  if (!Array.isArray(value.targets)) {
    throw new InvalidParams("'targets' is not a list");
  }
  const targets = value.targets.map(target => {
    if (!isJsonObject(target)) {
      throw new InvalidParams("a target is not an object");
    }
    return stringAt(target, "uri");
  });
  const { originId } = value;
  if (originId !== undefined && typeof originId !== "string") {
    throw new InvalidParams("'originId' is not a string");
  }
  return { targets, ...(originId === undefined ? {} : { originId }) };
}

/** Convert the parameters naming a document: its URI. */
export function toDocumentParams(params: unknown): { uri: string } {
  return { uri: stringAt(objectAt(toObject(params), "textDocument"), "uri") };
}

/** Convert the parameters naming a place in a document: its URI, and the position. */
export function toPositionParams(params: unknown): { uri: string; position: IPosition } {
  const value = toObject(params);
  const position = objectAt(value, "position");
  const { line, character } = position;
  if (typeof line !== "number" || typeof character !== "number") {
    throw new InvalidParams("'position' is not a line and a character");
  }
  return { uri: toDocumentParams(value).uri, position: { line, character } };
}

/** Convert `textDocument/didOpen`'s parameters: the document's URI and its text. */
export function toOpenedParams(params: unknown): { uri: string; text: string } {
  const document = objectAt(toObject(params), "textDocument");
  return { uri: stringAt(document, "uri"), text: stringAt(document, "text") };
}

/** Convert `textDocument/didChange`'s parameters, the whole text sent for each change: the document's URI and its text after the last, if it sent any. */
export function toChangedParams(params: unknown): { uri: string; text?: string } {
  const value = toObject(params);
  if (!Array.isArray(value.contentChanges)) {
    throw new InvalidParams("'contentChanges' is not a list");
  }
  const last: unknown = value.contentChanges[value.contentChanges.length - 1];
  const text = last === undefined ? undefined : isJsonObject(last) ? stringAt(last, "text") : undefined;
  if (last !== undefined && text === undefined) {
    throw new InvalidParams("a change is not an object");
  }
  return { uri: toDocumentParams(value).uri, ...(text === undefined ? {} : { text }) };
}
