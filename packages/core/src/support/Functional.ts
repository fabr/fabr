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
 * Map each item and keep only the defined results — `map` then drop `undefined`
 * in one pass. The typed primitive for the map-and-filter idiom, so the result
 * is `U[]` (not `(U | undefined)[]` needing a narrowing filter, nor the
 * obscure `flatMap` returning `[x]`/`[]`). A `fn` returning `undefined` selects
 * the item out; any side effect it performs on that path (e.g. logging the
 * reason) still runs.
 */
export function select<T, U>(items: Iterable<T>, fn: (item: T) => U | undefined): U[] {
  const result: U[] = [];
  for (const item of items) {
    const mapped = fn(item);
    if (mapped !== undefined) {
      result.push(mapped);
    }
  }
  return result;
}
