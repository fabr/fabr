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

enum State {
  /**
   * No value has yet been determined at all
   */
  Unresolved = "unresolved",
  /**
   * An ancestor has been updated,but the node may or may not eventually need recomputation.
   */
  MaybeInvalid = "maybeinvalid",
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

type CatchHandler<U> = (value: unknown) => U | Computable<U>;

/**
 * A computable functions very similarly to a Promise, except that:
 * a) A Computable may depend on any number of other Computables
 * b) A Computable is persistent - if a value it depends on changes, it will be
 *   recomputed (and so on throughout the graph.)
 * c) A Computable may reject (throw), in which case graph computation is halted
 *   (there is no equivalent of .catch())
 */
export class Computable<T> {
  private value: T | undefined | unknown;
  private state: State = State.Unresolved;
  private dependsOn: Computable<any>[] = [];
  private dependants: WeakRef<Computable<any>>[] = [];
  private fn: ((...args: any[]) => any) | undefined = undefined;

  public then<U>(fn: (value: T) => U | Computable<U>): Computable<U> {
    const result = new Computable<U>();
    result.fn = fn;
    this.dependants.push(new WeakRef(result));
    result.dependsOn.push(this);
    if (this.state === State.Valid) {
      result.run();
    }
    return result;
  }

  public static forAll<U, D extends readonly Computable<unknown>[]>(
    deps: D,
    fn: (...deps: { [P in keyof D]: D[P] extends Computable<infer U> ? U : D[P] }) => U | Computable<U>
  ): Computable<U> {
    const result = new Computable<U>();
    result.dependsOn.push(...deps);
    deps.forEach(dep => dep.dependants.push(new WeakRef(result)));
    result.fn = fn;
    if (result.canRun()) {
      result.run();
    }
    return result;
  }

  public static resolve<T>(value: T): Computable<T> {
    const result = new Computable<T>();
    result.value = value;
    return result;
  }

  public static reject<T>(err: unknown): Computable<T> {
    const result = new Computable<T>();
    result.rejectWith(err);
    return result;
  }

  public static from<T>(fn: (resolve: (value: T) => void, reject: (err: unknown) => void) => void): Computable<T> {
    const result = new Computable<T>();
    fn(result.resolveTo.bind(result), result.rejectWith.bind(result));
    return result;
  }

  /**
   * Mark the computable as invalid without immediate triggering re-execution;
   * (This is primarily exported for use in batch invalidation/revalidation
   * scenarios)
   */
  public invalidate() {
    if (this.state !== State.Unresolved) {
      this.state = State.Invalid;
      this.forEachDependant(dep => dep.markMaybeInvalid());
    }
  }

  private canRun(): boolean {
    return this.dependsOn.every(dep => dep.state === State.Valid);
  }

  private run(): void {
    const inputs = this.dependsOn.map(dep => dep.value);
    try {
      const result = this.fn && this.fn(...inputs);
      if (result instanceof Computable) {
        result.then(this.resolveTo.bind(this));
      } else {
        this.resolveTo(result);
      }
    } catch (err) {
      this.rejectWith(err);
    }
  }

  private resolveTo(value: T): void {
    this.state = State.Valid;
    if (value !== this.value) {
      this.value = value;
      this.forEachDependant(dep => {
        dep.invalidate();
      });
    }
    this.forEachDependant(dep => {
      if (dep.state !== State.Valid && dep.canRun()) {
        if (dep.state === State.MaybeInvalid) {
          dep.state = State.Valid;
        } else {
          dep.run();
        }
      }
    });
  }

  private rejectWith(err: unknown): void {
    this.state = State.Error;
    this.value = err;
    console.log("Error: " + err);
    /* TODO error reporting */
  }

  private markMaybeInvalid() {
    if (this.state === State.Valid || this.state === State.Error) {
      this.state = State.MaybeInvalid;
      this.forEachDependant(dep => dep.markMaybeInvalid());
    }
  }

  forEachDependant(fn: (dep: Computable<any>) => void): void {
    let gc = false;
    this.dependants.forEach(wdep => {
      const dep = wdep.deref();
      if (dep) {
        fn(dep);
      } else {
        gc = true;
      }
    });
    if (gc) {
      this.dependants = this.dependants.filter(wdep => wdep.deref());
    }
  }
}
