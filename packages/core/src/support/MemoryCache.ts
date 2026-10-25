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

/**
 * Computations by key, held in memory: each made once for as long as the cache
 * is held (a repository instance's, for the run). One that fails is forgotten,
 * so a transient failure (a dropped connection) is tried again when next asked
 * rather than kept.
 */
export class MemoryCache<K, T> {
  private readonly held = new Map<K, Computable<T>>();

  /** Get the computation held for `key`, making it with `make` if none is. */
  public getOrCreate(key: K, make: () => Computable<T>): Computable<T> {
    let result = this.held.get(key);
    if (result === undefined) {
      result = make();
      const made = result;
      /* Held before the failure observer is attached: a computation already
       * rejected runs the observer at once, which must find it to forget. */
      this.held.set(key, made);
      made.catch(() => {
        if (this.held.get(key) === made) {
          this.held.delete(key);
        }
      });
    }
    return result;
  }
}
