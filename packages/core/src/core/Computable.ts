/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { MultiError, toError } from "./MultiError";

enum State {
  /**
   * No value has yet been determined at all
   */
  Unresolved = "unresolved",
  /**
   * An ancestor has been updated; the node held a valid value and may or may
   * not eventually need recomputation.
   */
  MaybeValid = "maybevalid",
  /**
   * An ancestor has been updated; the node held an error and may or may not
   * eventually need recomputation.
   */
  MaybeError = "maybeerror",
  /**
   * The node definitely requires recalculation.
   */
  Invalid = "invalid",
  /**
   * The node has a valid value and does not need updating.
   */
  Valid = "valid",
  /**
   * The node has an error value
   */
  Error = "error",
}

type CatchHandler<U> = (err: Error) => U | Computable<U>;

/**
 * A computable functions very similarly to a Promise, except that:
 * a) A Computable may depend on any number of other Computables
 * b) A Computable is persistent - if a value it depends on changes, it will be
 *   recomputed (and so on throughout the graph.) This applies to errors as well:
 *   a node in the Error state is re-run when a dependency re-settles, so an
 *   errored subgraph recovers once the underlying problem is fixed.
 * c) A Computable with multiple failed dependencies aggregates all of their
 *   (distinct) errors into a single MultiError, rather than failing fast on
 *   the first.
 */
export class Computable<T> {
  /** The settled result: T when Valid, Error when Error (undefined while unresolved) */
  private value: T | Error | undefined;
  private state: State = State.Unresolved;
  private dependsOn: Computable<any>[] = [];
  private dependants: Computable<any>[] = [];
  private fn: ((...args: any[]) => any) | undefined = undefined;
  private errfn: CatchHandler<any> | undefined = undefined;

  public then<U>(fn: (value: T) => U | Computable<U>, onError?: CatchHandler<U>): Computable<U> {
    const result = new Computable<U>();
    result.fn = fn;
    result.errfn = onError;
    this.dependants.push(result);
    result.dependsOn.push(this);
    if (this.isSettled()) {
      result.run();
    }
    return result;
  }

  public catch<U>(onError: CatchHandler<U>): Computable<T | U> {
    return this.then<T | U>(value => value, onError);
  }

  /**
   * Run the given side effect once the receiver settles, either way, passing
   * the original value or error through unchanged (like Promise.finally).
   */
  public finally(onSettled: () => void): Computable<T> {
    return this.then(
      value => {
        onSettled();
        return value;
      },
      err => {
        onSettled();
        throw err;
      }
    );
  }

  /**
   *  * all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
   * @param deps
   * @param fn
   * @returns
   */
  public static forAll<U, D extends readonly Computable<unknown>[] | []>(
    deps: D,
    fn: (...deps: { -readonly [P in keyof D]: Awaited<D[P]> }) => U | Computable<U>,
    onError?: CatchHandler<U>
  ): Computable<U> {
    const result = new Computable<U>();
    result.dependsOn.push(...deps);
    deps.forEach(dep => dep.dependants.push(result));
    result.fn = fn;
    result.errfn = onError;
    if (result.canRun()) {
      result.run();
    }
    return result;
  }

  public static resolve<T>(value: T): Computable<T> {
    const result = new Computable<T>();
    result.value = value;
    result.state = State.Valid;
    return result;
  }

  public static reject<T>(err: Error): Computable<T> {
    const result = new Computable<T>();
    result.rejectWith(err);
    return result;
  }

  public static from<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: unknown) => void) => void): Computable<T> {
    const result = new Computable<T>();
    fn(result.resolveTo.bind(result), err => result.rejectWith(toError(err)));
    return result;
  }

  /**
   * Mark the computable as invalid without immediate triggering re-execution;
   * (This is primarily exported for use in batch invalidation/revalidation
   * scenarios)
   */
  public invalidate(): void {
    if (this.state !== State.Unresolved) {
      this.state = State.Invalid;
      this.forEachDependant(dep => dep.markMaybeInvalid());
    }
  }

  private isSettled(): boolean {
    return this.state === State.Valid || this.state === State.Error;
  }

  private canRun(): boolean {
    return this.dependsOn.every(dep => dep.isSettled());
  }

  private run(): void {
    const errors: Error[] = [];
    for (const dep of this.dependsOn) {
      if (dep.state === State.Error) {
        errors.push(dep.value as Error);
      }
    }
    try {
      if (errors.length > 0) {
        const error = MultiError.of(errors);
        if (this.errfn) {
          this.resolveTo(this.errfn(error));
        } else {
          this.rejectWith(error);
        }
      } else {
        const inputs = this.dependsOn.map(dep => dep.value);
        this.resolveTo(this.fn && this.fn(...inputs));
      }
    } catch (err) {
      this.rejectWith(toError(err));
    }
  }

  private resolveTo(value: T | Computable<T>): void {
    if (value instanceof Computable) {
      value.then(this.resolveTo.bind(this), this.rejectWith.bind(this));
    } else {
      this.settleWith(State.Valid, value);
    }
  }

  private rejectWith(err: Error): void {
    this.settleWith(State.Error, err);
  }

  private settleWith(state: State.Valid | State.Error, value: T | Error): void {
    this.state = state;
    if (value !== this.value) {
      this.value = value;
      this.forEachDependant(dep => {
        dep.invalidate();
      });
    }
    this.notifyDependants();
  }

  /**
   * Restore the previous settled state after a dependency re-settled without
   * changing its value, and cascade onwards: nothing needs recomputation, but
   * the whole maybe-invalidated subgraph must return to its settled state.
   */
  private revalidate(): void {
    this.state = this.state === State.MaybeError ? State.Error : State.Valid;
    this.notifyDependants();
  }

  private notifyDependants(): void {
    this.forEachDependant(dep => {
      if (!dep.isSettled() && dep.canRun()) {
        if (dep.state === State.MaybeValid || dep.state === State.MaybeError) {
          dep.revalidate();
        } else {
          dep.run();
        }
      }
    });
  }

  private markMaybeInvalid(): void {
    if (this.state === State.Valid || this.state === State.Error) {
      this.state = this.state === State.Error ? State.MaybeError : State.MaybeValid;
      this.forEachDependant(dep => dep.markMaybeInvalid());
    }
  }

  private forEachDependant(fn: (dep: Computable<any>) => void): void {
    this.dependants.forEach(fn);
  }
}
