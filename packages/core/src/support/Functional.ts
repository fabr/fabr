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

/** Map each item with `fn`, keeping only the results that are not undefined. */
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

/** Map each own enumerable property of `input` to `fn`'s result for it. */
export function mapObject<K extends string | symbol | number, V, U>(input: Record<K, V>, fn: (key: K, value: V) => U): Record<K, U> {
  const result = {} as Record<K, U>;
  for (const key of Object.keys(input) as K[]) {
    result[key] = fn(key, input[key]);
  }
  return result;
}

/**
 * Compare two strings by code unit, as `Array.sort`'s default orders them. Sort
 * key material and serialized documents with this, never `localeCompare`,
 * whose order varies with the machine's ICU.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** How many of {@link mapComputable}'s operations run at once by default. */
export const DEFAULT_MAX_CONCURRENCY = 16;

/**
 * Run a one-shot operation on each of `items`, at most `maxConcurrency` at a
 * time, resolving to the results in `items` order. `items` is iterated and `fn`
 * called only as each item's turn comes. The first value a returned source
 * settles to is taken; a later change to it is not followed.
 *
 * A failure stops further items from starting; once the operations already
 * running have settled, the result rejects with the first error.
 *
 * Use this, not {@link Computable.forAll}, for a list whose length depends on
 * the data (files, archive members).
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
