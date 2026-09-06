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

export function mapObject<K extends string | symbol | number, V, U>(input: Record<K, V>, fn: (key: K, value: V) => U): Record<K, U> {
  const result = {} as Record<K, U>;
  /* Own enumerable keys only, so an inherited member cannot be mapped in — the
   * guard a `for...in` would need. */
  for (const key of Object.keys(input) as K[]) {
    result[key] = fn(key, input[key]);
  }
  return result;
}

/**
 * Plain code-unit comparison, for canonical orderings. Key material and
 * serialized documents sort with THIS (or `Array.sort`'s default), never
 * `localeCompare`: a locale collation varies with the machine's ICU and can
 * even order two distinct strings as equal, where the whole point of a
 * canonical order is one answer everywhere. Locale collation is for display.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}