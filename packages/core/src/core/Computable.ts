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

import { MultiError, toError, CycleError, Label } from "./Errors";

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

type CatchHandler<U> = (err: Error) => U | ComputableSource<U>;

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
 * its first dependant, and so is the one derived node made to wait for demand,
 * {@link Computable.detached}; every other node enters the graph at birth — a derived node
 * attaches eagerly on creation (so fire-and-forget tails run), a `from`/`fromOnce` cell
 * attaches in its factory (its executor runs eagerly there — it is producer-driven,
 * never demand-deferred), and `resolve`/`reject` are born already settled. On losing its
 * last dependant a node detaches — unregisters from its dependencies, cascading up,
 * releasing an orphaned subgraph's filesystem watches with no disposal. Reattaching
 * recomputes (a detached node missed any invalidations; sources re-read external state).
 * A node born with no dependants, never given one, never drops.
 *
 * Two invariants. **Detachable ⟺ reconstructable:** only a node that can re-establish
 * its value on reattach detaches — a derived node with an `fn`, or a re-reading source;
 * a constant (`resolve`/`reject`/`from`) never detaches, serving its value at zero
 * dependants. **A source settles only while attached** — enforced: {@link settle} and
 * {@link revalidate} are no-ops on a detached node, so the async tail of a superseded
 * evaluation landing after its detach is simply discarded (a reattach re-derives), and
 * `Detached` never coexists with a live value. A source subclass therefore needs no
 * settle-time guard of its own — but work that *mutates its own state* before settling
 * must still discard superseded completions itself (see TreeQuery's generation check).
 *
 * Persistence: a derived node is recomputed when an input changes, and so on
 * throughout the (attached) graph; this applies to errors too. Multiple failed
 * dependencies aggregate into a single MultiError rather than failing fast.
 */
/** The notification cascades in flight (nested {@link ComputableSource.notifyDependants}
 * calls), and the cycle closers asked to decide during one. A closer decides once no
 * notification is pending: until then a node it would judge unable to move may merely
 * not have been notified yet of an input that settled. */
let cascadeDepth = 0;
const deferredClosers = new Set<ComputableSource<unknown>>();

export abstract class ComputableSource<T> {
  /** The settled result: T when Valid, Error when Error (undefined while unresolved) */
  protected currentValue: T | Error | undefined;
  /** Doubles as the attached/detached bit; see the class doc's Attachment note. */
  protected currentState: ComputableState = ComputableState.Detached;
  /** Nodes depending on this one — typed at the base contract the cascade uses (its
   * cascade methods), not the concrete `Computable` they always are in practice (via then/forAll). */
  private readonly dependants: ComputableSource<any>[] = [];

  /** What this node stands for, to a reader of a cycle it is found in. */
  public label?: Label;

  /**
   * Global event listener for otherwise unhandled rejections.
   */
  public static onUnhandledError: ((err: Error) => void) | undefined;

  public get state(): ComputableState {
    return this.currentState;
  }

  public get value(): T | Error | undefined {
    return this.currentValue;
  }

  public isSettled(): boolean {
    return this.currentState === ComputableState.Valid || this.currentState === ComputableState.Error;
  }

  /**
   * Derive a node from this one. Unlike a Promise, the callback runs
   * **synchronously** when the receiver is already settled (this is a reactive
   * cell, not a microtask queue — a derived node eager-attaches and, with a
   * settled input, computes in-line). Do not rely on a `then` callback deferring
   * to a later tick; if you need that, defer explicitly.
   */
  public then<U>(fn: (value: T) => U | ComputableSource<U>, onError?: CatchHandler<U>): Computable<U> {
    return Computable.deriving([this], (value: T) => fn(value), onError);
  }

  public catch<U>(onError: CatchHandler<U>): Computable<T | U> {
    return this.then<T | U>(value => value, onError);
  }

  /**
   * Run the given side effect once the receiver settles, either way, passing
   * the original value or error through unchanged (like Promise.finally). An
   * effect returning a source is awaited before the outcome passes through,
   * and the effect's own rejection replaces the outcome — both also like
   * Promise.finally; any other return value is ignored.
   */
  public finally(onSettled: () => unknown): Computable<T> {
    const after = (complete: () => T): (T | ComputableSource<T>) => {
      const effect = onSettled();
      return effect instanceof ComputableSource ? effect.then(complete) : complete();
    };
    return this.then(
      value => after(() => value),
      err =>
        after(() => {
          throw err;
        })
    );
  }

  /**
   * Consume this node's result **exactly once**, without holding the receiver
   * in the graph (typically for fire-and-forget situations where you don't want
   * the chain to hang around (note if the receiver has no other dependents, 
   * it will be detached)
   */
  public once(fn: (value: T) => void, onError?: (err: Error) => void): void {
    let consumed = false;
    let release = (): void => {};
    const consume = (effect: () => void): void => {
      if (!consumed) {
        consumed = true;
        release();
        effect();
      }
    };
    const tail = this.then(
      value => consume(() => fn(value)),
      err => consume(() => (onError ? onError(err) : reportUnobserved(err)))
    );
    release = () => this.removeDependant(tail);
    if (consumed) {
      release();
    }
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
    if (this.dropDependant(dep)) {
      ComputableSource.release([this]);
    }
  }

  /** Remove `dep` from this source's dependants, detaching nothing. Returns
   * whether that left this source attached with no dependants: a node to
   * detach. */
  private dropDependant(dep: ComputableSource<unknown>): boolean {
    const index = this.dependants.indexOf(dep);
    if (index >= 0) {
      this.dependants.splice(index, 1);
    }
    return this.dependants.length === 0 && this.currentState !== ComputableState.Detached;
  }

  /**
   * Detach each of `nodes` still attached with no dependants, and each node
   * that leaves with none in turn, from a work list rather than the stack, so
   * a long chain detaches without running out of it. A node that gained a
   * dependant again before its turn stays.
   */
  protected static release(nodes: ComputableSource<unknown>[]): void {
    const pending = nodes.slice();
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next.dependants.length === 0 && next.currentState !== ComputableState.Detached) {
        pending.push(...next.detach());
      }
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

  /** Unregister from dependencies / release external state, returning to
   * Detached. Detaches nothing further: returns the dependencies left with no
   * dependants, which {@link release} detaches in turn. */
  protected detach(): ComputableSource<unknown>[] {
    this.currentState = ComputableState.Detached;
    return [];
  }

  /** Register as a dependant of each of `dependencies`. The cross-instance
   * `addDependant` call lives here in the declaring class, so that method stays
   * protected (a subclass can't reach it through a base-typed dependency). */
  protected attachTo(dependencies: ComputableSource<unknown>[]): void {
    for (const dep of dependencies) {
      dep.addDependant(this);
    }
  }

  /** Deregister as a dependant of each of `dependencies` — the inverse of
   * {@link attachTo} — detaching those left with no dependants. */
  protected detachFrom(dependencies: ComputableSource<unknown>[]): void {
    ComputableSource.release(this.dropFrom(dependencies));
  }

  /** Deregister as a dependant of each of `dependencies`, detaching nothing:
   * returns those left with no dependants. */
  protected dropFrom(dependencies: ComputableSource<unknown>[]): ComputableSource<unknown>[] {
    return dependencies.filter(dep => dep.dropDependant(this));
  }

  /**
   * Mark the computable as invalid without immediately triggering re-execution;
   * (This is primarily exported for use in batch invalidation/revalidation
   * scenarios, e.g. watch-mode re-settlement.)
   */
  public invalidate(): void {
    /* Nothing to invalidate while out of the graph (Detached — unobservable, and
     * it re-derives on reattach anyway), nor before a first value unless that
     * value is computed from inputs (see {@link recomputesWhileUnresolved}). */
    if (
      this.currentState !== ComputableState.Detached &&
      (this.currentState !== ComputableState.Unresolved || this.recomputesWhileUnresolved())
    ) {
      this.currentState = ComputableState.Invalid;
      this.eachDependant(dep => dep.markMaybeInvalid());
    }
  }

  /** @return true if an input changing while this node awaits its first value
   * means it must compute again, otherwise false. A derived node's does: its
   * pending value was asked for from the inputs it had. */
  protected recomputesWhileUnresolved(): boolean {
    return false;
  }

  protected settle(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    /* Inert while Detached (the enforced invariant — see the class doc): a
     * detached node is out of the graph and holds no value, which is what makes
     * detach reversible. The async tail of a superseded evaluation (an orphaned
     * TreeQuery's enumeration, a watch batch's prepared update) routinely
     * completes after the detach; dropping it here discards the stale result —
     * a reattach re-derives from current state. */
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    this.currentState = state;
    if (value !== this.currentValue) {
      this.currentValue = value;
      this.eachDependant(dep => dep.invalidate());
    }
    this.notifyDependants();
    this.checkUnhandledError();
  }

  /**
   * Restore the previous settled state after a dependency re-settled without
   * changing its value, and cascade onwards: nothing needs recomputation, but
   * the whole maybe-invalidated subgraph must return to its settled state.
   */
  protected revalidate(): void {
    /* Inert while Detached, like settle: revalidation restores a *settled*
     * state and a detached node has none. */
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    this.currentState = this.currentState === ComputableState.MaybeError ? ComputableState.Error : ComputableState.Valid;
    this.notifyDependants();
  }

  /**
   * Mark this node maybe-invalid, and everything that depends on it, from a
   * work list rather than the stack, so a long chain is marked without
   * running out of it.
   */
  protected markMaybeInvalid(): void {
    const pending: ComputableSource<unknown>[] = [this];
    const marked: ComputableSource<unknown>[] = [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      marked.push(node);
      pending.push(...node.markSelfMaybeInvalid());
    }
    for (const node of marked) {
      node.afterMaybeInvalidWave();
    }
  }

  /** Called on each node a maybe-invalid wave marked, once the wave is done. */
  protected afterMaybeInvalidWave(): void {}

  /**
   * Mark this node alone maybe-invalid: a settled value becomes a maybe.
   * Returns the nodes to mark after it.
   */
  protected markSelfMaybeInvalid(): ComputableSource<unknown>[] {
    if (!this.isSettled()) {
      return [];
    }
    this.currentState = this.currentState === ComputableState.Error ? ComputableState.MaybeError : ComputableState.MaybeValid;
    return this.dependants.slice();
  }

  private notifyDependants(): void {
    cascadeDepth++;
    try {
      this.eachDependant(dep => dep.maybeRecompute());
    } finally {
      if (--cascadeDepth === 0) {
        for (const closer of deferredClosers) {
          deferredClosers.delete(closer);
          closer.recheckCycle();
        }
      }
    }
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

  /**
   * Decide, as a node that closed a cycle, whether to settle its error again. A
   * pure source closes no cycle; {@link Computable} overrides this.
   */
  protected recheckCycle(): void {}

  /**
   * @return true if this node's settled error would go unobserved, otherwise
   * false: it is settled Error and in the graph with no dependant that would
   * *read* it. {@link Computable} narrows it
   * to also exclude a binding node (which forwards to its `outer`). The
   * `dependants` check already excludes a detached node: a derived node that loses
   * its last dependant *detaches* (Detached, not Error), so only an eager,
   * still-live terminal tail reaches here.
   */
  protected isUnhandledError(): boolean {
    return this.currentState === ComputableState.Error && !this.dependants.some(dep => dep.observesErrors());
  }

  /**
   * @return true if depending on this node amounts to observing its error, otherwise
   * false. True for a derived node — it reads its inputs and propagates their failure
   * onwards. False for a {@link Sink}, which
   * holds a node attached without ever reading it: an edge that keeps a chain alive is not
   * an edge that reports its failure, so a seated chain must still answer for its own
   * errors (see {@link isUnhandledError}).
   */
  protected observesErrors(): boolean {
    return true;
  }

  /**
   * Report a stranded computed error, deferred one microtask past the synchronous
   * graph-building burst — a handler attached on the next line
   * (`const c = x.then(f); c.catch(g)`) settles within that window and clears the
   * candidacy, exactly as V8 suppresses a rejected-then-handled promise. Fires per
   * strand event: a persistent node that re-errors on a later (watch-mode) rebuild
   * reports again, which is the honest signal — it stranded again. A settle with
   * dependants (ordinary error propagation) fails {@link isUnhandledError} here and
   * costs nothing.
   */
  private checkUnhandledError(): void {
    if (ComputableSource.onUnhandledError === undefined || !this.isUnhandledError()) {
      return;
    }
    queueMicrotask(() => {
      if (this.isUnhandledError()) {
        ComputableSource.onUnhandledError?.(this.currentValue as Error);
      }
    });
  }
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
  /** When resolved *to* another source, the binding node feeding us from it —
   * tracked so a re-resolve detaches the previous one, releasing the old inner
   * subgraph (and any watches under it) once it has no other dependants. */
  private binding?: Computable<T>;
  /** Set only on a binding node: the outer Computable that resolved to this node's
   * sole dependency, and which mirrors our cascade (see {@link resolveTo}). */
  private outer?: Computable<T>;
  /** Whether this binding's inner depends on its outer (set only on a binding
   * node). While it does, the outer holds the cycle's error and refuses what
   * the inner delivers (see {@link fromBinding}). */
  private cyclic = false;
  /** Set on a cyclic binding while a maybe-invalid wave it carried into its
   * outer is still being marked (see {@link afterMaybeInvalidWave}). */
  private carriedWave = false;
  /** Whether a search for a cycle reached this node and could not follow its
   * binding (see {@link inputsWaitedOn}). If so, whether the binding closes a
   * cycle is checked when this node is next waiting on it for certain (see
   * {@link maybeRecompute}). */
  private unsearched = false;
  /** The nodes that closed a cycle this node is on and are holding for it
   * to stop moving (see {@link recheckCycle}): each is asked again whenever
   * this node moves. */
  private closedBy: Set<Computable<unknown>> | undefined;
  /** The nodes this node is holding on, having closed a cycle (see
   * {@link recheckCycle}): the pending region behind its binding, as a wave
   * crossing the binding or a node asking finds it. Released when the binding
   * delivers, and when this node re-runs or detaches. */
  private holding = new Set<Computable<unknown>>();

  /** Label this node, and return it. */
  public labelled(label: Label | undefined): Computable<T> {
    this.label = label;
    return this;
  }

  /** Derive a node computing `fn` over `deps` (or `errfn` on failure). */
  public static deriving<U>(
    deps: ComputableSource<any>[],
    fn: (...args: any[]) => U | ComputableSource<U>,
    errfn?: CatchHandler<U>
  ): Computable<U> {
    const result = new Computable<U>();
    result.errfn = errfn;
    result.setDerivation(deps, fn);
    return result;
  }

  /**
   * Create a node that computes `fn` when it is first depended on, not when
   * it is made: it is born detached, as a raw source is. A memo that files
   * such a node holds it before `fn` runs, so a request for the same thing
   * made while `fn` runs finds the node and depends on it.
   */
  public static detached<U>(fn: () => U | ComputableSource<U>): Computable<U> {
    const result = new Computable<U>();
    result.fn = fn;
    return result;
  }

  /** Initialise a derived node's inputs + fn and enter the graph — the shared tail
   * of {@link deriving} and {@link resolveTo}'s binding construction. */
  private setDerivation(deps: ComputableSource<any>[], fn: (...args: any[]) => any): void {
    this.dependsOn = deps.slice();
    this.fn = fn;
    this.attach();
  }

  public static forAll<U, D extends readonly ComputableSource<unknown>[] | []>(
    deps: D,
    fn: (...deps: { -readonly [P in keyof D]: Awaited<D[P]> }) => U | ComputableSource<U>,
    onError?: CatchHandler<U>
  ): Computable<U> {
    return Computable.deriving(deps as unknown as ComputableSource<any>[], fn as (...args: any[]) => U | ComputableSource<U>, onError);
  }

  public static resolve<T>(value: T): Computable<T> {
    const result = new Computable<T>();
    result.currentValue = value;
    result.currentState = ComputableState.Valid;
    return result;
  }

  public static reject<T>(err: Error): Computable<T> {
    const result = new Computable<T>();
    /* Born settled, mirroring resolve(): a constant enters the graph already
     * holding its outcome — settle() is for a node transitioning while attached,
     * and would drop the value on a Detached-born node. */
    result.currentValue = err;
    result.currentState = ComputableState.Error;
    return result;
  }

  public static from<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: Error) => void) => void): Computable<T> {
    const result = new Computable<T>();
    /* In the graph from birth: the executor runs eagerly (right here), so this
     * cell is producer-driven, never demand-deferred — it must not sit Detached
     * while pending, or its own resolve would be dropped by settle's detached
     * guard. Fn-less, so it never detaches; attach here is just the
     * Detached -> Unresolved (pending) transition. */
    result.attach();
    /* A synchronous throw in the executor becomes a rejection, mirroring native
     * `new Promise(exec)` and run()'s own discipline — the error flows through the
     * graph rather than escaping sideways at the call site. Guarded on isSettled so
     * an executor that resolves and *then* throws stays resolved (the throw is dropped). */
    try {
      fn(result.resolveTo.bind(result), err => result.rejectWith(err));
    } catch (err) {
      if (!result.isSettled()) {
        result.rejectWith(toError(err));
      }
    }
    return result;
  }

  /**
   * Create a cell like {@link from} that settles at most once, typically for
   * non-repeatable processes that need to avoid settling multiple times.
   */
  public static fromOnce<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: Error) => void) => void): Computable<T> {
    const result = new Computable<T>();
    result.attach(); // in the graph from birth — see from()
    let settled = false;

    /* As from(), a synchronous executor throw rejects — but only if nothing has
     * settled yet, upholding the settle-exactly-once contract. */
    try {
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
    } catch (err) {
      if (!settled) {
        settled = true;
        result.rejectWith(toError(err));
      }
    }
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

  protected override detach(): ComputableSource<unknown>[] {
    this.releaseHolds();
    /* Detachable ⟺ reconstructable. A node with no `fn` (a resolve/reject/from
     * constant) can't be recomputed on reattach and has no inputs registered to
     * release, so it never detaches — it keeps serving its value at zero dependants. */
    if (!this.fn) {
      return [];
    }
    super.detach();
    return [...this.dropFrom(this.dependsOn), ...this.dropBinding()];
  }

  protected override recomputesWhileUnresolved(): boolean {
    return this.fn !== undefined;
  }

  /** @return true if this node is in a maybe state — a value served before,
   * with an input since marked maybe-invalid — otherwise false. */
  private isMaybe(): boolean {
    return this.currentState === ComputableState.MaybeValid || this.currentState === ComputableState.MaybeError;
  }

  private canRun(): boolean {
    return this.dependsOn.every(dep => dep.isSettled());
  }

  private run(): void {
    /* Re-running supersedes the previous fn-result link: detach it, so the old
     * inner subgraph (and any watches under it) unwinds once orphaned. */
    this.unbind();
    this.unsearched = false;
    this.releaseHolds();
    /* Running consumes the inputs: no re-run is owed any longer, and this node
     * awaits what `fn` gives it, as on a first run. */
    if (this.currentState === ComputableState.Invalid) {
      this.currentState = ComputableState.Unresolved;
    }
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

  private resolveTo(value: T | ComputableSource<T>): void {
    /* Resolving to another source: link to it through a binding — an identity node
     * that sits on the inner as its sole dependant and mirrors the inner's cascade
     * (maybe-invalid, revalidate, settle) into us, its `outer` (the overrides
     * below). Being a real dependant is what carries the maybe-invalid frontier
     * across the boundary (a batch invalidation must reach us and our dependants);
     * forwarding the settle rather than recomputing us is what stops a
     * fresh-per-call factory (`x.then(v => build(v))`) from thrashing. Superseding
     * on re-run is handled in run(); a stray re-resolve (from() may fire more than
     * once) is superseded here — on BOTH branches: a plain-value re-resolve must
     * also detach a prior still-pending binding, or its inner would later forward
     * and clobber this value with the superseded result. */
    this.unbind();
    if (!(value instanceof ComputableSource)) {
      this.settle(ComputableState.Valid, value);
      this.askClosers();
      return;
    }
    /* A cell with no `fn` is resolved by its executor, so this is its run:
     * resolving consumes the inputs as run() does, and the node awaits the
     * inner's delivery (which acceptFromBinding holds off an Invalid node). */
    if (!this.fn && this.currentState === ComputableState.Invalid) {
      this.currentState = ComputableState.Unresolved;
    }
    const binding = new Computable<T>();
    /* Wired before entering the graph: an already-settled inner settles the
     * binding during setDerivation's attach, which must forward to this node. */
    binding.outer = this;
    this.binding = binding;
    binding.setDerivation([value], IDENTITY);
    this.checkCycle();
    this.askClosers();
  }

  /**
   * Check whether the binding closes a dependency cycle: whether the inner
   * depends on this node through nodes waiting for certain. If so this node
   * settles with the cycle's error and the binding stays, marked cyclic: inert
   * to every wave, so this node stays settled until its own inputs re-run it
   * or the inner's delivery no longer depends on it (see {@link fromBinding}).
   */
  private checkCycle(): void {
    const binding = this.binding;
    if (binding === undefined || binding.isSettled()) {
      return;
    }
    const path = Computable.pathBetween(binding, this, node => node.inputsWaitedOn());
    if (path === undefined) {
      return;
    }
    this.settleCycle(path);
  }

  /** Settle with the error of the cycle `path` leads round from the binding
   * to this node, marking the binding cyclic. */
  private settleCycle(path: ComputableSource<unknown>[]): void {
    const labels = [this, ...path].map(node => node.label).filter((label): label is Label => label !== undefined);
    /* The same cycle found again is the same error: an unchanged value. */
    const held = this.currentValue;
    const same = held instanceof CycleError && held.labels.length === labels.length && held.labels.every((label, i) => label === labels[i]);
    this.binding!.cyclic = true;
    this.settle(ComputableState.Error, same ? held : new CycleError(labels));
  }

  /** @return true if `start` depends on `target` through any node, settled or
   * not, otherwise false. Asked of a cyclic binding, to tell whether its cycle
   * is still there. */
  private static reaches(start: ComputableSource<unknown>, target: ComputableSource<unknown>): boolean {
    return Computable.pathBetween(start, target, node => node.inputs()) !== undefined;
  }

  /**
   * Get the path by which `start` depends on `target`: `start`, then each
   * node it depends on in turn, up to but not including `target`; undefined
   * where there is none. `inputsOf` says which nodes each derived node on
   * the way depends on, for the search's purpose ({@link inputs} or
   * {@link inputsWaitedOn}); a raw source depends on nothing.
   */
  private static pathBetween(
    start: ComputableSource<unknown>,
    target: ComputableSource<unknown>,
    inputsOf: (node: Computable<unknown>) => ComputableSource<unknown>[]
  ): ComputableSource<unknown>[] | undefined {
    const from = new Map<ComputableSource<unknown>, ComputableSource<unknown> | undefined>([[start, undefined]]);
    const pending: ComputableSource<unknown>[] = [start];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      for (const input of node instanceof Computable ? inputsOf(node) : []) {
        if (input === target) {
          const path: ComputableSource<unknown>[] = [];
          for (let at: ComputableSource<unknown> | undefined = node; at !== undefined; at = from.get(at)) {
            path.unshift(at);
          }
          return path;
        }
        if (!from.has(input)) {
          from.set(input, node);
          pending.push(input);
        }
      }
    }
    return undefined;
  }

  /** List the nodes this one depends on: its inputs and, where it has one, its binding. */
  private inputs(): ComputableSource<unknown>[] {
    return this.binding === undefined ? this.dependsOn : [...this.dependsOn, this.binding];
  }

  /**
   * List the nodes this one is waiting on: none where it is settled (its value is
   * in hand, so nothing is held up behind it); otherwise its inputs, and its
   * binding only where it is waiting on that for certain — its own inputs
   * settled and no re-run owed. A node whose inputs are unsettled may re-run
   * and drop its binding, so it is marked to be judged when they settle
   * instead: a re-run binds afresh, and one whose inputs come back unchanged
   * checks in {@link maybeRecompute}.
   */
  private inputsWaitedOn(): ComputableSource<unknown>[] {
    if (this.isSettled()) {
      return [];
    }
    if (this.binding !== undefined && (this.currentState === ComputableState.Invalid || !this.canRun())) {
      this.unsearched = true;
      return this.dependsOn;
    }
    return this.inputs();
  }

  /** Tear down the current resolveTo binding, releasing the inner subgraph once
   * it has no other dependants. */
  private unbind(): void {
    ComputableSource.release(this.dropBinding());
  }

  /** Detach the current resolveTo binding, releasing nothing further: returns
   * the inner where the binding was its last dependant. */
  private dropBinding(): ComputableSource<unknown>[] {
    const binding = this.binding;
    this.binding = undefined;
    return binding === undefined ? [] : binding.detach();
  }

  private rejectWith(err: Error): void {
    /* An outside rejection supersedes a pending fn-result link just as a
     * re-resolve does (a from() executor may resolve with a Computable and then
     * reject) — without this, the orphaned inner's eventual settle would forward
     * through the stale binding and clobber the error. */
    this.unbind();
    this.settle(ComputableState.Error, err);
    this.askClosers();
  }

  protected override isUnhandledError(): boolean {
    /* A binding forwards its settle to its `outer`, so its error IS observed —
     * exclude it, else every forwarded error would double as a false strand. */
    return this.outer === undefined && super.isUnhandledError();
  }

  protected override maybeRecompute(): void {
    /* Suppressed while Detached: mid-attach (still registering our own deps — we run once
     * at the end of attach), and for any stray notify reaching an orphaned node. */
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    if (!this.isSettled() && this.canRun()) {
      if (this.isMaybe()) {
        /* Returning to settled after a maybe-invalid wave. With a live binding,
         * this node's settled-ness is the CONJUNCTION of its own deps (all
         * settled — canRun above) and the binding: revalidating from the
         * own-deps side alone would re-serve the stale inner value while the
         * inner is still recomputing — exactly the mixed-generation interim the
         * maybe-invalid frontier exists to forbid. So adopt a settled binding's
         * result (settle dedups an unchanged value into the equivalent of a
         * revalidation — and adopts a *changed* one, which plain revalidate
         * would silently discard); hold on a pending one — its forward delivers
         * when the inner side lands. */
        const binding = this.binding;
        if (!binding) {
          this.revalidate();
        } else if (binding.isSettled()) {
          this.fromBinding(binding.state as ComputableState.Valid | ComputableState.Error, binding.value as T | Error);
        } else if (binding.cyclic) {
          /* Its own inputs came back unchanged, so the cycle's error stands
           * unless the batch is still cutting it (see {@link recheckCycle}). */
          this.recheckCycle();
        } else if (this.unsearched) {
          /* Its own inputs came back unchanged, so it is now waiting on its
           * binding for certain: where a search for a cycle reached it while
           * it was maybe-invalid, check now whether the binding closes one. */
          this.unsearched = false;
          this.checkCycle();
        }
      } else {
        this.run();
      }
    }
    this.askClosers();
  }

  /**
   * Decide, as the node that closed a cycle, whether to settle its error again
   * while its binding is pending: asked when its own inputs come back from a
   * maybe-invalid wave unchanged, and again whenever a node it holds on
   * moves. The cycle's nodes wait on this one, so it must settle for them to;
   * but the batch may be cutting the cycle, and settling first would serve
   * the stale error to a consumer that then sees the healed value too. So it
   * settles only when nothing behind its binding can move — every node the
   * binding still waits on this one through is waiting itself, on nothing
   * but the cycle — and otherwise holds on those nodes, which ask again as
   * each moves. A binding that no longer waits on this node decides by its
   * delivery. Asked while a notification cascade is in flight, it decides at
   * the cascade's end instead: a node not yet notified of an input that
   * settled is about to move, whatever its state says now.
   */
  protected override recheckCycle(): void {
    if (cascadeDepth > 0) {
      deferredClosers.add(this);
      return;
    }
    const binding = this.binding;
    if (binding === undefined || !binding.cyclic || binding.isSettled()) {
      return;
    }
    const region = Computable.pendingRegion(binding, this);
    if (region === undefined) {
      return;
    }
    /* The region as it stands now: a node that joined it since is held on too. */
    this.holdOn(region);
    if (!this.isMaybe() || !this.canRun()) {
      return;
    }
    if (region.some(node => (node instanceof Computable ? node.canMove() : !node.isSettled()))) {
      return;
    }
    this.revalidate();
  }

  /** Hold on each derived node of `region`: it asks this node to decide again
   * whenever it moves (see {@link recheckCycle}). */
  private holdOn(region: ReadonlyArray<ComputableSource<unknown>>): void {
    for (const node of region) {
      if (node instanceof Computable && !this.holding.has(node)) {
        (node.closedBy ??= new Set()).add(this);
        this.holding.add(node);
      }
    }
  }

  /** Ask each node holding on this one to decide again, this node having
   * moved: recomputed, resolved, rejected, or left waiting (see
   * {@link recheckCycle}). */
  private askClosers(): void {
    if (this.closedBy !== undefined) {
      for (const closer of [...this.closedBy]) {
        closer.recheckCycle();
      }
    }
  }

  /** Stop holding on every node this one holds on. */
  private releaseHolds(): void {
    for (const node of this.holding) {
      node.closedBy?.delete(this);
    }
    this.holding.clear();
  }

  /** @return true if this node can move on its own — a derived node owed a
   * run it can make, or a cell still to be resolved by its executor —
   * otherwise false. */
  private canMove(): boolean {
    if (this.fn === undefined) {
      return this.binding === undefined && !this.isSettled();
    }
    return this.canRun() && (this.currentState === ComputableState.Invalid || (this.currentState === ComputableState.Unresolved && this.binding === undefined));
  }

  /**
   * Get the pending region behind `binding`: every unsettled node it waits on,
   * directly or through other unsettled nodes, up to `closer`; undefined
   * where it does not wait on `closer` at all. A raw source still to settle
   * is in it as a leaf.
   */
  private static pendingRegion(binding: ComputableSource<unknown>, closer: ComputableSource<unknown>): Array<ComputableSource<unknown>> | undefined {
    const region: Array<ComputableSource<unknown>> = [];
    const seen = new Set<ComputableSource<unknown>>([binding]);
    const pending: ComputableSource<unknown>[] = [binding];
    let reached = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      region.push(node);
      for (const input of node instanceof Computable ? node.inputs() : []) {
        if (input === closer) {
          reached = true;
        } else if (!input.isSettled() && !seen.has(input)) {
          seen.add(input);
          pending.push(input);
        }
      }
    }
    return reached ? region : undefined;
  }

  /**
   * Take the inner's settled result from the binding. It lands only when this
   * node is coherent to receive it: own deps settled (canRun) and no re-run
   * pending — Invalid means an own-dep *value* changed and `fn` hasn't consumed
   * it yet; run() will unbind this binding and rebind from fresh inputs, so its
   * value must not land now (settling here would make maybeRecompute see a
   * settled node and skip the re-run, freezing the stale binding in place). A
   * held delivery is not lost: once the own-dep side settles, maybeRecompute
   * adopts the binding's result (own deps unchanged) or run() rebinds (changed).
   */
  private acceptFromBinding(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    if (this.canRun() && this.currentState !== ComputableState.Invalid) {
      this.fromBinding(state, value);
    }
  }

  /**
   * Take what the binding delivers — unless the binding closes a cycle the
   * inner still makes: then this node keeps the cycle's error, and what came
   * back around is its own. Once the inner no longer depends on this node the
   * cycle is gone, and the delivery is its value.
   */
  private fromBinding(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    /* The binding has settled, so whether it closes a cycle is answered. */
    this.unsearched = false;
    const binding = this.binding;
    if (binding?.cyclic === true) {
      if (Computable.reaches(binding, this)) {
        if (this.isMaybe()) {
          this.revalidate();
        }
        return;
      }
      binding.cyclic = false;
      this.releaseHolds();
    }
    this.settle(state, value);
  }

  /**
   * Take the binding's report that the inner revalidated unchanged: return to
   * settled only if the own-dep side is settled too and we are in a maybe state
   * (the only states a revalidation can restore); otherwise hold — the own-dep
   * side's own settle/revalidate converges us through maybeRecompute.
   */
  private revalidateFromBinding(): void {
    if (this.canRun() && this.isMaybe()) {
      this.revalidate();
    }
  }

  /* A binding node mirrors the full cascade into its outer (no-ops elsewhere —
   * `outer` is only ever set on a binding): the maybe-invalid frontier, the
   * revalidation wave, and the settle itself (state + value adopted verbatim,
   * never recomputed — re-running the outer's fn would mint a fresh inner).
   * A maybe-invalid wave forwards, except through a pending cyclic binding,
   * and a hard invalidate forwards except from a cyclic binding (see
   * {@link markSelfMaybeInvalid} and {@link invalidate}); the SETTLING
   * direction is coherence-gated on the outer
   * (acceptFromBinding / revalidateFromBinding): the outer returns to settled
   * only when both its own deps and the binding agree, so a consumer never
   * observes mixed-generation inputs across the boundary. */

  /** Invalidate, and on a binding mark the outer maybe-invalid too: a hard
   * invalidate (the inner re-settled a changed value with no prior
   * maybe-invalid wave) must still unsettle the outer, or a consumer sharing
   * another arm of the diamond reads the outer's stale value mid-cascade. The
   * outer only ever needs maybe: the definite new value arrives via settle.
   * Not from a cyclic binding: what the inner re-settles to while the cycle
   * stands is the outer's own error coming back around, or a change inside
   * the cycle, neither of which changes the outer; one that cuts the cycle
   * reaches it as a delivery (see {@link fromBinding}). */
  public override invalidate(): void {
    super.invalidate();
    if (this.outer !== undefined && !this.cyclic) {
      this.outer.markMaybeInvalid();
    }
  }

  /** Mark this node alone maybe-invalid, returning the nodes to mark after
   * it — on a binding, its outer too where the wave crosses. A wave crosses
   * a cyclic binding where the binding was settled, the cycle standing: the outer and what depends on it may be
   * about to change, if the batch cuts the cycle, and must hold until it is
   * decided (see {@link recheckCycle}). It does not cross one still pending:
   * the wave is then the outer's own cycle error on its way back around. */
  protected override markSelfMaybeInvalid(): ComputableSource<unknown>[] {
    const settled = this.isSettled();
    const next = super.markSelfMaybeInvalid();
    this.carriedWave = this.cyclic && settled;
    return this.outer !== undefined && (!this.cyclic || settled) ? [...next, this.outer] : next;
  }

  /** Have the outer hold on its pending region, on a cyclic binding that
   * carried a wave into it: once the wave is done that region is marked in
   * full, and the outer holds on it, so that whichever of its nodes moves
   * first asks the outer to decide. */
  protected override afterMaybeInvalidWave(): void {
    if (this.carriedWave) {
      this.carriedWave = false;
      this.outer?.holdOn(Computable.pendingRegion(this, this.outer) ?? []);
    }
  }

  protected override revalidate(): void {
    super.revalidate();
    /* Forward only what actually landed (the base drops a revalidate on a
     * detached binding); the outer applies its own coherence gate. */
    if (this.currentState !== ComputableState.Detached) {
      this.outer?.revalidateFromBinding();
    }
  }

  protected override settle(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    super.settle(state, value);
    /* Forward only what actually landed: if the base dropped the settle (this
     * binding detached — unbound by a supersede), the outer must not adopt the
     * stale value either. Post-drop the state is still Detached, so this check
     * distinguishes a landed settle from a discarded one. The outer then applies
     * its own coherence gate (acceptFromBinding). */
    if (this.currentState !== ComputableState.Detached) {
      this.outer?.acceptFromBinding(state, value);
    }
  }
}

/** A binding is a pure identity over its inner — shared, since it captures
 * nothing (its forwarding rides the `outer` link, not the fn). */
const IDENTITY = (value: unknown): unknown => value;

/**
 * Report an error that reached a {@link ComputableSource.once} tail with no `onError`:
 * the tail is the error's observer, so with no handler it must surface the error rather
 * than swallow it. Reported directly (not deferred like
 * {@link ComputableSource.checkUnhandledError}): the tail's handlers are fixed when it is
 * built, so there is no late-handler window for the deferral to allow for.
 */
function reportUnobserved(err: Error): void {
  ComputableSource.onUnhandledError?.(err);
}

/**
 * The registered dependant behind a {@link ComputableHandle}, and the reason the two are
 * separate classes: the cascade a source drives over its dependants
 * (`markMaybeInvalid`/`invalidate`/`maybeRecompute`) is protected, so a dependant has to
 * *be* a ComputableSource — while a handle must not be one, or it could be depended on
 * in turn. The sink is that bridge, and is never exported.
 *
 * A handle needs its own dependant (rather than the plain `then` tail
 * {@link ComputableSource.once} withdraws) because it observes *many* results over one
 * seating and has to tell a real settle from a revalidation, which a tail's `fn` cannot
 * see.
 *
 * It is only ever the dependant half of an edge: nothing depends on it, so it is never
 * attached and stays {@link ComputableState.Detached} for life — which is precisely what
 * makes it inert, since all three cascade methods no-op in that state. Only the settle
 * observation needs overriding.
 */
class Sink<T> extends ComputableSource<never> {
  private seated: ComputableSource<T> | undefined;

  constructor(private readonly onSettled?: (source: ComputableSource<T>) => void) {
    super();
  }

  /** Hold `source`: becoming its dependant is what keeps it (and everything below it)
   * attached, and — for a raw source — what starts it. */
  public seat(source: ComputableSource<T>): void {
    this.clear();
    this.seated = source;
    this.attachTo([source]);
  }

  /** Fires on each settlement of the seated chain — a settle OR a
   * revalidate-unchanged, which a `then` tail cannot see. */
  protected override maybeRecompute(): void {
    const source = this.seated;
    if (source?.isSettled()) {
      this.onSettled?.(source);
    }
  }

  /** Withdraw demand: the source loses a dependant and, if it was the last, detaches and
   * cascades — the whole point of a handle. */
  public clear(): void {
    const source = this.seated;
    this.seated = undefined;
    if (source) {
      this.detachFrom([source]);
    }
  }

  /** A sink holds without reading, so it cannot answer for a seated chain's error. */
  protected override observesErrors(): boolean {
    return false;
  }
}

/**
 * Holds a Computable in the graph on behalf of something outside it, and lets that hold be
 * withdrawn or moved. A chain built for its effect has no dependants of its own, so nothing
 * would ever detach it (see the Attachment note on {@link ComputableSource}); seating it
 * gives it the dependant it lacks, and {@link release} — or seating something else — takes
 * that edge away again, unwinding the chain through the ordinary last-dependant cascade.
 *
 * Reseating supersedes, which is the point: the chain it replaces is left *detached*, so a
 * late settle from it is inert rather than merely unread.
 *
 * Deliberately not a {@link ComputableSource} — it terminates the graph on the dependant
 * side, so nothing can depend on it in turn. For the same reason it exposes no value: put a
 * `then` on the chain before seating it, so the graph delivers the result (and reports its
 * failure — a sink reads nothing, so a seated chain still answers for its own errors).
 */
export class ComputableHandle<T> {
  private readonly sink: Sink<T>;

  /** `onSettled`, if given, fires on every settlement of the seated chain from
   *  seating onward — including a revalidation that changed no value, which no
   *  `then` tail is notified of. A chain already settled when seated reports
   *  nothing until its next settlement. Fixed at construction, like a sink's
   *  handlers. */
  constructor(onSettled?: (source: ComputableSource<T>) => void) {
    this.sink = new Sink<T>(onSettled);
  }

  /** Hold `source`, releasing whatever was held before. */
  public seat(source: ComputableSource<T>): void {
    this.sink.seat(source);
  }

  /** Withdraw demand, unwinding the held chain. Idempotent. */
  public release(): void {
    this.sink.clear();
  }
}
