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
 * Values by key, each held only while something else holds it: a value
 * nothing else references is collected, and its key then reads as unset. Use
 * it to share one copy of a value among its holders, not to keep one.
 */
export class WeakValueMap<K, V extends object> {
  private readonly refs = new Map<K, WeakRef<V>>();
  private readonly swept = new FinalizationRegistry<K>(key => {
    if (this.refs.get(key)?.deref() === undefined) {
      this.refs.delete(key);
    }
  });

  /** Get the value held under `key`, or undefined where none is or it was collected. */
  public get(key: K): V | undefined {
    return this.refs.get(key)?.deref();
  }

  /** Hold `value` under `key`, replacing any value held there. */
  public set(key: K, value: V): void {
    this.refs.set(key, new WeakRef(value));
    this.swept.register(value, key);
  }

  /** Forget the value held under `key`. */
  public delete(key: K): void {
    this.refs.delete(key);
  }
}
