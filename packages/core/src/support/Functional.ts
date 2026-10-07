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

import { Computable, ComputableSource } from "../core/Computable";

/**
 * Map each item and keep only the defined results — `map` then drop `undefined`
 * in one pass, typed as `U[]`. A `fn` returning `undefined` selects the item
 * out; any side effect it performs on that path (e.g. logging the reason)
 * still runs.
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

/** How many of {@link mapComputable}'s operations run at once by default. */
export const DEFAULT_MAX_CONCURRENCY = 16;

/**
 * Run a one-shot operation on each of `items`, at most `maxConcurrency` at a
 * time, yielding the results in `items` order. `items` is iterated as the
 * operations start: `fn` is called when an item's turn comes, so an operation
 * that starts on construction starts then; a source it returns is consumed
 * once, and a later change to it is not followed.
 *
 * A failure stops further items from starting; once the operations already in
 * flight have settled, the result rejects with the first error.
 *
 * Any list whose length follows the data (files, archive members) goes through
 * this rather than {@link Computable.forAll}, which takes one argument per
 * input.
 */
export function mapComputable<T, U>(
  items: Iterable<T>,
  fn: (item: T, index: number) => U | ComputableSource<U>,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY
): Computable<U[]> {
  return Computable.from<U[]>((resolve, reject) => {
    const results: U[] = [];
    const iterator = items[Symbol.iterator]();
    let inFlight = 0;
    let stopped = false;
    let failure: Error | undefined;
    let pumping = false;
    /* Start items up to the cap, and settle once none remain and none are in
     * flight. An operation that completes as it starts calls back in here while
     * the loop is still running, which the guard leaves to that loop. */
    function pump(): void {
      if (pumping) {
        return;
      }
      pumping = true;
      while (!stopped && inFlight < maxConcurrency) {
        const step = iterator.next();
        if (step.done) {
          stopped = true;
          break;
        }
        const index = results.length++;
        inFlight++;
        Computable.resolve(step.value)
          .then(item => fn(item, index))
          .once(
            value => {
              results[index] = value;
              inFlight--;
              pump();
            },
            err => {
              failure ??= err;
              stopped = true;
              inFlight--;
              pump();
            }
          );
      }
      pumping = false;
      if (stopped && inFlight === 0) {
        if (failure === undefined) {
          resolve(results);
        } else {
          reject(failure);
        }
      }
    }
    pump();
  });
}
