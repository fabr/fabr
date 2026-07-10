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

/** One step of a work-list traversal: the value computed for a key, plus the
 * keys it makes reachable. Already-visited keys in `next` are ignored, so
 * cycles and shared references need no special handling by the step. */
export interface WorkListItem<K, V> {
  value: V;
  next: K[];
}

/**
 * Compute the transitive closure of `step` over `seeds`: every key reachable
 * through `next` edges is visited exactly once, yielding key → value in
 * discovery (breadth-first) order. Keys compare by Map identity, so use
 * primitives or interned objects.
 *
 * The result is persistent like any Computable: `step` is called at most once
 * per key ever, and its node is depended on for as long as the key is
 * reachable — if it re-resolves, the closure recomputes from the then-current
 * values. A changed `next` set discovers new keys (stepped on demand) or drops
 * no-longer-reachable ones from the result; a dropped key's step node detaches
 * while idle and reattaches (re-reading its current state) if rediscovered.
 * Step failures aggregate and reject the whole result, recovering if the
 * failed step later re-resolves.
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

  /* One pass over the closure-so-far. `keys` is deduplicated, in discovery
   * order, and grows monotonically down the recursion (so the recursion
   * terminates for any finite reachable set, cycles included). The pass
   * depends on EVERY key's step, not just the newest frontier: a re-resolve
   * anywhere in the prefix re-runs the shallowest pass containing it, which
   * recomputes the frontier from the current values and supersedes the
   * previously grown tail (detaching it, along with any step nodes only it
   * was keeping attached). */
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
