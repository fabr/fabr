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

import { Computable, ComputableSource } from "./Computable";
import { toError } from "./Errors";

/** One step of a work-list traversal: the value computed for a key, and the
 * keys it makes reachable. Keys in `next` already visited are ignored, so a
 * step need not avoid cycles or repeats. */
export interface WorkListItem<K, V> {
  value: V;
  next: K[];
}

/**
 * Compute the transitive closure of `step` over `seeds`: every key reachable
 * through `next` is visited once, and the result maps each key to its value
 * in discovery (breadth-first) order. Keys compare as Map keys do, so use
 * primitives or interned objects.
 *
 * `step` is called at most once per key, and the result depends on each
 * key's node while the key is reachable, so it computes again when a node
 * settles to a new item: a changed `next` adds the keys it now reaches
 * (stepping new ones) and drops those it no longer does. A dropped key's
 * node detaches, and attaches again if the key is reached again. Where steps
 * fail, the result rejects with their errors combined, and recovers when the
 * failed steps settle to values.
 */
export function computableWorkList<K, V>(
  seeds: readonly K[],
  step: (key: K) => ComputableSource<WorkListItem<K, V>>
): Computable<Map<K, V>> {
  const memo = new Map<K, ComputableSource<WorkListItem<K, V>>>();
  const stepFor = (key: K): ComputableSource<WorkListItem<K, V>> => {
    let node = memo.get(key);
    if (node === undefined) {
      try {
        node = step(key);
      } catch (err) {
        node = Computable.reject(toError(err));
      }
      memo.set(key, node);
    }
    return node;
  };

  /* One pass over the closure so far: `keys` is deduplicated, in discovery
   * order, and only grows from one pass to the next. The pass depends on
   * every key's step, not just the newest: a step settling to a new item
   * re-runs the first pass holding its key, which finds the next keys from
   * the current values and replaces the passes after it (detaching them, and
   * any step nodes only they kept attached). */
  const expand = (keys: K[]): Computable<Map<K, V>> =>
    Computable.forAll(keys.map(stepFor), (...items) => {
      const known = new Set(keys);
      const grown = keys.slice();
      for (const item of items) {
        for (const key of item.next) {
          if (!known.has(key)) {
            known.add(key);
            grown.push(key);
          }
        }
      }
      if (grown.length > keys.length) {
        return expand(grown);
      }
      return new Map<K, V>(keys.map((key, index): [K, V] => [key, items[index].value]));
    });

  return expand([...new Set(seeds)]);
}

/**
 * Get what `fn` answers for the first item it answers anything for, or
 * undefined where it answers for none: items are tried in order, one at a
 * time, and `fn` is not called for any item after the one that answers.
 * Callers rely on that: do not make the search parallel.
 */
export function computableFind<T, U>(items: readonly T[], fn: (item: T) => Computable<U | undefined>): Computable<U | undefined> {
  const at = (index: number): Computable<U | undefined> =>
    index >= items.length ? Computable.resolve(undefined) : fn(items[index]).then(found => found ?? at(index + 1));
  return at(0);
}
