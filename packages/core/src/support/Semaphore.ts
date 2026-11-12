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
 * A counting semaphore over Computable-producing work: at most `capacity` of
 * the functions handed to {@link run} are in flight at once, the rest queued in
 * the order asked and started as slots free.
 *
 * Keep the queue to plain closures, never graph nodes: settle is inert while
 * a node is Detached, so work granted to a detached chain would never start
 * and its slot never come back.
 *
 * Never ask for a slot from within work already holding one: at capacity
 * that deadlocks.
 */
export class Semaphore {
  private readonly queued: (() => void)[] = [];
  private held = 0;

  constructor(private readonly capacity: number) {}

  /**
   * Run `work` once a slot is available, settling as its result first settles.
   * The slot is held from the call of `work` until that result settles, so
   * put only the bounded work itself inside `work` (not a cache lookup before
   * it). A synchronous throw from `work` rejects.
   */
  public run<T>(work: () => Computable<T>): Computable<T> {
    return Computable.from<T>((resolve, reject) => {
      this.acquire(() => {
        /* Release once per grant, though the work's result may settle again. */
        let released = false;
        const release = (): void => {
          if (!released) {
            released = true;
            this.release();
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
    });
  }

  private acquire(grant: () => void): void {
    if (this.held < this.capacity) {
      this.held++;
      grant();
    } else {
      this.queued.push(grant);
    }
  }

  /** Hand the slot to the longest-waiting grant, or give it up if none waits. */
  private release(): void {
    const next = this.queued.shift();
    if (next) {
      next();
    } else {
      this.held--;
    }
  }
}
