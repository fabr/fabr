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
import { toError } from "../core/Errors";

/**
 * A counting semaphore over Computable-producing work: the functions handed
 * to {@link run} hold at most `capacity` slots between them, each as many as it
 * asked for (one by default); the rest are queued in the order asked, and each
 * is started once the slots it asked for are free, taking them together. One
 * waiting for several slots holds back those queued behind it.
 *
 * Keep the queue to plain closures, never graph nodes: settle is inert while
 * a node is Detached, so work granted to a detached chain would never start
 * and its slot never come back.
 *
 * Never ask for a slot from within work already holding one: at capacity
 * that deadlocks, unless the work can finish without what it asks for.
 */
export class Semaphore {
  private readonly queued: { count: number; grant: () => void }[] = [];
  private held = 0;

  constructor(public readonly capacity: number) {}

  /**
   * Run `work` once `count` slots are available (one by default; a count over
   * `capacity` takes every slot), settling as its result first settles. The slots are held
   * from the call of `work` until that result settles, so put only the
   * bounded work itself inside `work` (not a cache lookup before it). A
   * synchronous throw from `work` rejects. Aborting `signal` while `work` is
   * still queued withdraws it, rejecting without running it; once it has
   * started, aborting changes nothing. Throws a RangeError where `count` is
   * not a whole number of at least one.
   */
  public run<T>(work: () => Computable<T>, count = 1, signal?: AbortSignal): Computable<T> {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`a semaphore's work takes a whole number of slots, not ${count}`);
    }
    const slots = Math.min(count, this.capacity);
    return Computable.from<T>((resolve, reject) => {
      const entry = this.acquire(slots, () => {
        /* Release once per grant, though the work's result may settle again. */
        let released = false;
        const release = (): void => {
          if (!released) {
            released = true;
            this.release(slots);
          }
        };
        try {
          work().then(
            value => {
              release();
              resolve(value);
            },
            err => {
              release();
              reject(err);
            }
          );
        } catch (err) {
          release();
          reject(toError(err));
        }
      });
      if (entry !== undefined && signal !== undefined) {
        const withdraw = (): void => {
          if (this.withdraw(entry)) {
            reject(new Error("withdrawn before it started"));
          }
        };
        if (signal.aborted) {
          withdraw();
        } else {
          signal.addEventListener("abort", withdraw, { once: true });
        }
      }
    });
  }

  /**
   * Grant `count` slots at once where they are free and nothing is queued,
   * else queue the grant.
   * @return the queued entry, or undefined where it was granted at once.
   */
  private acquire(count: number, grant: () => void): { count: number; grant: () => void } | undefined {
    if (this.queued.length === 0 && this.held + count <= this.capacity) {
      this.held += count;
      grant();
      return undefined;
    }
    const entry = { count, grant };
    this.queued.push(entry);
    return entry;
  }

  /**
   * Remove `entry` from the queue, then start what now fits.
   * @return true if it was still queued, otherwise false.
   */
  private withdraw(entry: { count: number; grant: () => void }): boolean {
    const index = this.queued.indexOf(entry);
    if (index < 0) {
      return false;
    }
    this.queued.splice(index, 1);
    this.release(0);
    return true;
  }

  /**
   * Give back `count` slots, then start each queued function in turn whose
   * slots are now free, stopping at the first that has to wait.
   */
  private release(count: number): void {
    this.held -= count;
    while (this.queued.length > 0 && this.held + this.queued[0].count <= this.capacity) {
      const next = this.queued.shift()!;
      this.held += next.count;
      next.grant();
    }
  }
}
