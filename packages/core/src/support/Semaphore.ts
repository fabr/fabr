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
 * demand order and started as slots free.
 *
 * The queued work is a plain closure the semaphore holds, NOT a graph node
 * awaiting a value — so a slot is released even when the chain consuming the
 * result has since detached (a superseded watch-mode evaluation), which a
 * gate built out of Computables could not guarantee: settle is inert while
 * detached, so the granted work would never start and its slot never come back.
 *
 * The caller must not acquire a second slot from within work already holding
 * one — nested acquisition of a bounded resource deadlocks at capacity.
 */
export class Semaphore {
  private readonly queued: (() => void)[] = [];
  private held = 0;

  constructor(private readonly capacity: number) {}

  /**
   * Run `work` once a slot is available, resolving with its result. The slot is
   * held from the moment `work` is called until its result settles, either way
   * — so `work` is where the bounded resource is consumed, and nothing before
   * it (a cache lookup, say) should be inside it.
   */
  public run<T>(work: () => Computable<T>): Computable<T> {
    return Computable.from<T>((resolve, reject) => {
      this.acquire(() => {
        /* One release per grant: a work computable that settles again (a
         * revalidation) must not hand back a slot it no longer holds. */
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
