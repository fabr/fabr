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

import { FabrError } from "../core/Errors";
import { Name } from "../core/Name";
import { declPosn, IMapSpliceDecl, INameValue, IPropertyDecl } from "../model/AST";
import { NameResolutionError } from "../model/Errors";

/**
 * A value in a MAP property's ordered key -> value map: a string-valued entry's
 * words as written (not joined), a nested map (one block), or a list of nested
 * maps (several blocks, `maintainers`-style), never a mix. The rule reading the
 * map decides how to encode each value.
 */
export type PropertyMapValue = string[] | PropertyMap | PropertyMap[];

export type PropertyMap = Map<string, PropertyMapValue>;

/**
 * Ghost provenance for one map entry: the written `key = value;` decl the value
 * came from, and the reference hops it arrived through, outermost first, each
 * an in-block `NAME;` splice or a top-level bare-reference value ("via
 * 'FABR_METADATA'"). Runtime-only: it is kept in {@link MAP_ORIGINS} beside the
 * map, never on it.
 */
export interface MapEntryOrigin {
  entry: IPropertyDecl;
  via: (IMapSpliceDecl | INameValue)[];
}

const MAP_ORIGINS = new WeakMap<PropertyMap, Map<string, MapEntryOrigin>>();

/** Get the origin of a map's entry, where the map came from `lookupMap` (a
 * hand-built Map has none). */
export function mapEntryOrigin(map: PropertyMap, key: string): MapEntryOrigin | undefined {
  return MAP_ORIGINS.get(map)?.get(key);
}

/**
 * Make an error about one entry of a map, positioned at the entry as it was
 * written. For an entry that arrived through a shared map, the splice and
 * reference hops are named in the message. A hand-built map has no origins, so
 * its error carries no position.
 */
export function mapEntryError(map: PropertyMap, key: string, message: string): Error {
  const origin = mapEntryOrigin(map, key);
  if (!origin) {
    return new FabrError(message);
  }
  const via = origin.via.map(hop => ` (via '${("ref" in hop ? hop.ref : hop.value).toString()}')`).join("");
  return new NameResolutionError(Name.fromLiteral(key), declPosn(origin.entry), undefined, message + via);
}

/**
 * Convert a MAP property's value to environment variables, names to strings in
 * name order. A value is its words joined by a space (`NODE_OPTIONS = --a
 * --b;`). A name that could not be a variable, or a nested map for a value, is
 * refused at the entry that wrote it.
 */
export function toEnvironment(map: PropertyMap): ReadonlyMap<string, string> {
  const variables = new Map<string, string>();
  for (const name of [...map.keys()].sort()) {
    const value = map.get(name)!;
    if (name === "" || name.includes("=") || name.includes("\0")) {
      throw mapEntryError(map, name, `'${name}' is not a valid environment variable name`);
    }
    if (!Array.isArray(value) || !value.every((word): word is string => typeof word === "string")) {
      throw mapEntryError(map, name, `environment variable '${name}' must be a string`);
    }
    variables.set(name, value.join(" "));
  }
  return variables;
}

export function recordMapOrigin(map: PropertyMap, key: string, origin: MapEntryOrigin): void {
  let origins = MAP_ORIGINS.get(map);
  if (!origins) {
    origins = new Map();
    MAP_ORIGINS.set(map, origins);
  }
  origins.set(key, origin);
}

/** Merge `source`'s entries into `target` (later wins), threading each entry's
 * origin with the written reference `hop` prepended to its via-chain. */
export function mergeMapInto(target: PropertyMap, source: PropertyMap, hop: IMapSpliceDecl | INameValue): void {
  for (const [key, value] of source) {
    target.set(key, value);
    const origin = mapEntryOrigin(source, key);
    if (origin) {
      recordMapOrigin(target, key, { entry: origin.entry, via: [hop, ...origin.via] });
    }
  }
}
