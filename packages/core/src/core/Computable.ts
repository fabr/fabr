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

import { MultiError, toError } from "./Errors";

export enum ComputableState {
  /**
   * Out of the graph: unregistered from dependencies, value is indeterminate.
   */
  Detached = "detached",
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
 * The "depend on me" half of the reactive graph: a value other nodes can depend
 * on, that notifies its dependants when it changes, and that attaches/detaches
 * from the graph with demand. A source is either a *derived* {@link Computable}
 * or an externally-settled leaf (e.g. a filesystem watch) — the latter subclasses
 * this and settles itself via {@link settle}/{@link invalidate}, overriding
 * {@link attach}/{@link detach} to acquire/release its external subscription.
 *
 * A dependant reads across the edge through the triple `isSettled` / `state` /
 * `value`; the structural wiring is internal — a dependant registers via
 * {@link attachTo} / {@link detachFrom}, which drive the protected {@link addDependant}
 * / {@link removeDependant}. Recomputation from inputs is the derived half, in
 * {@link Computable}.
 *
 * **Attachment.** A raw source is born {@link ComputableState.Detached} and attaches on
 * its first dependant; a derived node attaches eagerly on creation (so fire-and-forget
 * tails run). On losing its last dependant a node detaches — unregisters from its
 * dependencies, cascading up, releasing an orphaned subgraph's filesystem watches with
 * no disposal. Reattaching recomputes (a detached node missed any invalidations; sources
 * re-read external state). A node born with no dependants, never given one, never drops.
 *
 * Two invariants. **Detachable ⟺ reconstructable:** only a node that can re-establish
 * its value on reattach detaches — a derived node with an `fn`, or a re-reading source;
 * a constant (`resolve`/`reject`/`from`) never detaches, serving its value at zero
 * dependants. **A source settles only while attached** — never while detached, so
 * `Detached` never coexists with a live value (a prerequisite for new source subclasses).
 *
 * Persistence: a derived node is recomputed when an input changes, and so on
 * throughout the (attached) graph; this applies to errors too. Multiple failed
 * dependencies aggregate into a single MultiError rather than failing fast.
 */
export abstract class ComputableSource<T> {
  /** The settled result: T when Valid, Error when Error (undefined while unresolved) */
  protected currentValue: T | Error | undefined;
  /** Doubles as the attached/detached bit; see the class doc's Attachment note. */
  protected currentState: ComputableState = ComputableState.Detached;
  /** Nodes depending on this one — typed at the base contract the cascade uses (its
   * hooks), not the concrete `Computable` they always are in practice (via then/forAll). */
  private readonly dependants: ComputableSource<any>[] = [];

  public get state(): ComputableState {
    return this.currentState;
  }

  public get value(): T | Error | undefined {
    return this.currentValue;
  }

  public isSettled(): boolean {
    return this.currentState === ComputableState.Valid || this.currentState === ComputableState.Error;
  }

  public then<U>(fn: (value: T) => U | Computable<U>, onError?: CatchHandler<U>): Computable<U> {
    return Computable.deriving([this], (value: T) => fn(value), onError);
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

  /** Register `dep` as depending on this source; reattaches this source if it had
   * detached. Protected — reached only via a dependant's {@link attachTo}. */
  protected addDependant(dep: ComputableSource<any>): void {
    this.dependants.push(dep);
    if (this.currentState === ComputableState.Detached) {
      this.attach();
    }
  }

  /** Detach a dependant. When the last one leaves, this source detaches too
   * (releasing its dependencies / external subscription), cascading upward. */
  protected removeDependant(dep: ComputableSource<any>): void {
    const index = this.dependants.indexOf(dep);
    if (index >= 0) {
      this.dependants.splice(index, 1);
    }
    if (this.dependants.length === 0 && this.currentState !== ComputableState.Detached) {
      this.detach();
    }
  }

  /**
   * Register with dependencies / acquire external state, entering the graph from
   * {@link ComputableState.Detached} as Unresolved (pending). {@link Computable}
   * overrides to re-register with its inputs and recompute; a source subscribes and
   * settles from its current value. A no-op if already attached (not Detached).
   */
  protected attach(): void {
    if (this.currentState === ComputableState.Detached) {
      this.currentState = ComputableState.Unresolved;
    }
  }

  /** Unregister from dependencies / release external state, returning to Detached. */
  protected detach(): void {
    this.currentState = ComputableState.Detached;
  }

  /** Register as a dependant of each of `dependencies`. The cross-instance
   * `addDependant` call lives here in the declaring class, so that method stays
   * protected (a subclass can't reach it through a base-typed dependency). */
  protected attachTo(dependencies: ComputableSource<unknown>[]): void {
    for (const dep of dependencies) {
      dep.addDependant(this);
    }
  }

  /** Deregister as a dependant of each of `dependencies` — the inverse of {@link attachTo}. */
  protected detachFrom(dependencies: ComputableSource<unknown>[]): void {
    for (const dep of dependencies) {
      dep.removeDependant(this);
    }
  }

  /**
   * Mark the computable as invalid without immediately triggering re-execution;
   * (This is primarily exported for use in batch invalidation/revalidation
   * scenarios, e.g. watch-mode re-settlement.)
   */
  public invalidate(): void {
    /* Nothing to invalidate before a first value (Unresolved) or while out of the
     * graph (Detached — unobservable, and it re-derives on reattach anyway). */
    if (this.currentState !== ComputableState.Unresolved && this.currentState !== ComputableState.Detached) {
      this.currentState = ComputableState.Invalid;
      this.eachDependant(dep => dep.markMaybeInvalid());
    }
  }

  protected settle(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    this.currentState = state;
    if (value !== this.currentValue) {
      this.currentValue = value;
      this.eachDependant(dep => dep.invalidate());
    }
    this.notifyDependants();
  }

  /**
   * Restore the previous settled state after a dependency re-settled without
   * changing its value, and cascade onwards: nothing needs recomputation, but
   * the whole maybe-invalidated subgraph must return to its settled state.
   */
  protected revalidate(): void {
    this.currentState = this.currentState === ComputableState.MaybeError ? ComputableState.Error : ComputableState.Valid;
    this.notifyDependants();
  }

  protected markMaybeInvalid(): void {
    if (this.currentState === ComputableState.Valid || this.currentState === ComputableState.Error) {
      this.currentState = this.currentState === ComputableState.Error ? ComputableState.MaybeError : ComputableState.MaybeValid;
      this.eachDependant(dep => dep.markMaybeInvalid());
    }
  }

  private notifyDependants(): void {
    this.eachDependant(dep => dep.maybeRecompute());
  }

  /** Iterate dependants over a snapshot — the cascade may detach one mid-iteration
   * (a re-run superseding an old subgraph), which mutates this list. */
  private eachDependant(fn: (dep: ComputableSource<any>) => void): void {
    this.dependants.slice().forEach(fn);
  }

  /**
   * Recompute this node in response to a dependency settling, if it can. A pure
   * source (settled from outside) never recomputes; {@link Computable} overrides
   * this to run (or revalidate) from its inputs.
   */
  protected maybeRecompute(): void {}
}

/**
 * A value *derived* from other {@link ComputableSource}s (which may themselves be
 * derived or raw sources). Functions very similarly to a Promise, except it is
 * persistent — recomputed when an input changes — and can depend on any number
 * of inputs, aggregating their errors into a single MultiError.
 */
export class Computable<T> extends ComputableSource<T> {
  private dependsOn: ComputableSource<any>[] = [];
  private fn: ((...args: any[]) => any) | undefined = undefined;
  private errfn: CatchHandler<any> | undefined = undefined;
  /** When resolved *to* another source, the intermediary link feeding us from it
   * — tracked so a re-resolve detaches the previous one, releasing the old inner
   * subgraph (and any watches under it) once it has no other dependants. */
  private binding?: Computable<any>;

  /** Core derivation: a node computing `fn` over `deps` (or `errfn` on failure). */
  public static deriving<U>(
    deps: ComputableSource<any>[],
    fn: (...args: any[]) => U | Computable<U>,
    errfn?: CatchHandler<U>
  ): Computable<U> {
    const result = new Computable<U>();
    result.dependsOn = deps.slice();
    result.fn = fn;
    result.errfn = errfn;
    result.attach();
    return result;
  }

  public static forAll<U, D extends readonly ComputableSource<unknown>[] | []>(
    deps: D,
    fn: (...deps: { -readonly [P in keyof D]: Awaited<D[P]> }) => U | Computable<U>,
    onError?: CatchHandler<U>
  ): Computable<U> {
    return Computable.deriving(deps as unknown as ComputableSource<any>[], fn as (...args: any[]) => U | Computable<U>, onError);
  }

  public static resolve<T>(value: T): Computable<T> {
    const result = new Computable<T>();
    result.currentValue = value;
    result.currentState = ComputableState.Valid;
    return result;
  }

  public static reject<T>(err: Error): Computable<T> {
    const result = new Computable<T>();
    result.rejectWith(err);
    return result;
  }

  public static from<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: Error) => void) => void): Computable<T> {
    const result = new Computable<T>();
    fn(result.resolveTo.bind(result), err => result.rejectWith(err));
    return result;
  }

  /**
   * Once-and-once only version of Computable.from, typically for non-repeatable processes that need to avoid
   * settling multiple times.
   * @param fn
   * @returns
   */
  public static once<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: Error) => void) => void): Computable<T> {
    const result = new Computable<T>();
    let settled = false;

    fn(
      value => {
        if (!settled) {
          settled = true;
          result.resolveTo(value);
        }
      },
      err => {
        if (!settled) {
          settled = true;
          result.rejectWith(err);
        }
      }
    );
    return result;
  }

  protected override attach(): void {
    /* Register with dependencies while still Detached: a dep that reattaches and settles
     * mid-registration notifies us, but maybeRecompute's Detached guard drops it — so we
     * compute exactly once below, after the whole input set is wired. */
    this.attachTo(this.dependsOn);
    super.attach(); // Detached -> Unresolved (pending)
    /* Recompute if every input is settled — a reattach discards a possibly-stale value.
     * Otherwise stay in the pending state super.attach left us in, until an input settles
     * and notifies us; a fn-less node (an unresolved `from`) likewise just waits. */
    if (this.canRun() && this.fn) {
      this.run();
    }
  }

  protected override detach(): void {
    /* Detachable ⟺ reconstructable. A node with no `fn` (a resolve/reject/from
     * constant) can't be recomputed on reattach and has no inputs registered to
     * release, so it never detaches — it keeps serving its value at zero dependants. */
    if (!this.fn) {
      return;
    }
    this.detachFrom(this.dependsOn);
    this.binding?.detach();
    super.detach();
  }

  private canRun(): boolean {
    return this.dependsOn.every(dep => dep.isSettled());
  }

  private run(): void {
    /* Re-running supersedes the previous fn-result link: detach it, so the old
     * inner subgraph (and any watches under it) unwinds once orphaned. This is the
     * ONLY supersede point — resolveTo below keeps the current link attached so
     * the inner re-settling (a source change flowing through) still re-delivers. */
    this.binding?.detach();
    this.binding = undefined;
    const errors: Error[] = [];
    for (const dep of this.dependsOn) {
      if (dep.state === ComputableState.Error) {
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
    /* Bind to the inner source and keep the link (it stays a live dependant, so
     * the inner re-settling re-delivers to us — that's how a source change flows
     * through). Superseding on re-run is handled in run(), not here. */
    if (value instanceof ComputableSource) {
      this.binding = value.then(this.resolveTo.bind(this), this.rejectWith.bind(this));
    } else {
      this.settle(ComputableState.Valid, value as T);
    }
  }

  private rejectWith(err: Error): void {
    this.settle(ComputableState.Error, err);
  }

  protected override maybeRecompute(): void {
    /* Suppressed while Detached: mid-attach (still registering our own deps — we run once
     * at the end of attach), and for any stray notify reaching an orphaned node. */
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    if (!this.isSettled() && this.canRun()) {
      if (this.state === ComputableState.MaybeValid || this.state === ComputableState.MaybeError) {
        this.revalidate();
      } else {
        this.run();
      }
    }
  }
}
