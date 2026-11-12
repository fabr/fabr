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

/** The state of a node in the reactive graph. */
export enum ComputableState {
  /**
   * Out of the graph: registered with none of its inputs and holding no
   * subscription. Whatever value it last held is not current.
   */
  Detached = "detached",
  /**
   * In the graph and awaiting a value: its first, or its next after it
   * attached again or ran again.
   */
  Unresolved = "unresolved",
  /**
   * Held a value, and something it depends on has since been marked
   * maybe-invalid: it may or may not have to compute again.
   */
  MaybeValid = "maybevalid",
  /**
   * Held an error, and something it depends on has since been marked
   * maybe-invalid: it may or may not have to compute again.
   */
  MaybeError = "maybeerror",
  /**
   * Must produce a new value: an input settled to a changed value and the
   * node has not run since, or, for a raw source, a new value is about to be
   * settled.
   */
  Invalid = "invalid",
  /** Holds a current value. */
  Valid = "valid",
  /** Holds a current error. */
  Error = "error",
}

type CatchHandler<U> = (err: Error) => U | ComputableSource<U>;

/** The depth of nested {@link ComputableSource.notifyDependants} calls in
 * progress, and the cycle closers (see {@link Computable.recheckCycle}) that
 * asked to decide during one. Each deferred closer decides when the outermost
 * call returns: until then, a node that looks unable to move may not yet have
 * been told of an input that settled. */
let cascadeDepth = 0;
const deferredClosers = new Set<ComputableSource<unknown>>();

/**
 * A node of the reactive graph that other nodes can depend on: it holds a
 * value or an error, tells its dependants when that changes, and stays in the
 * graph only while something depends on it. A source is either a derived
 * {@link Computable} or a raw source that settles itself from outside (a
 * filesystem query). A raw source subclasses this, calls {@link invalidate}
 * and {@link settle} as what it reads changes, and overrides {@link attach}
 * and {@link detach} to take and drop its subscription.
 *
 * Read a node through `state`, `value` and `isSettled()`; derive from it with
 * `then`, `catch` and `finally`, or consume its result once with `once`.
 *
 * Attachment:
 * - A raw source, and a node made by {@link Computable.detached}, is born
 *   {@link ComputableState.Detached} and attaches when it gains its first
 *   dependant. Every other node is in the graph from birth: a derived node
 *   attaches as it is made (so a tail nothing depends on still runs), a
 *   `from` cell attaches and runs its executor in its factory, and
 *   `resolve`/`reject` are born settled.
 * - A node that loses its last dependant detaches: it unregisters from its
 *   inputs, and each input left with no dependant detaches in turn, so an
 *   unused subgraph drops its filesystem subscriptions. A node that never had
 *   a dependant stays attached.
 * - A node that regains a dependant attaches again and derives its state
 *   afresh: a derived node computes again where its inputs are all settled,
 *   and otherwise waits Unresolved; a raw source reads again.
 * - Only a node that can make its value again detaches: a derived node with
 *   an `fn`, or a raw source. A node without one (a constant, a `from` cell, a
 *   final node, see {@link isFinal}) keeps its value with no dependants.
 * - {@link settle} and {@link revalidate} do nothing while Detached, so a
 *   superseded evaluation's late result is dropped. A subclass whose async
 *   work changes its own state before settling must still discard superseded
 *   completions itself (as TreeQuery's `attachGeneration` does): after a
 *   reattach the node is attached again, and its settle lands.
 *
 * Changes: a derived node computes again when an input settles to a changed
 * value, and so on through the attached graph, errors included. A node whose
 * inputs failed gets their errors combined in one MultiError.
 */
export abstract class ComputableSource<T> {
  /** The value when Valid, the error when Error; otherwise the last one held,
   * or undefined. */
  protected currentValue: T | Error | undefined;
  /** The node's state, Detached while it is out of the graph. */
  protected currentState: ComputableState = ComputableState.Detached;
  /** The nodes that depend on this one. */
  private readonly dependants: ComputableSource<any>[] = [];

  /** What this node stands for, to a reader of a cycle it is found in. */
  public label?: Label;

  /** Set when a dependant has read this node's error since it settled, so the
   * error is not reported as unhandled once a final dependant has let go of
   * this node. */
  private errorObserved = false;

  /**
   * Called with an error nothing will read: one a node settled with and no
   * dependant reads, one that reached a {@link once} tail with no `onError`,
   * or one a {@link ComputableHandle}'s `onSettled` threw. Unset, nothing is
   * reported.
   */
  public static onUnhandledError: ((err: Error) => void) | undefined;

  public get state(): ComputableState {
    return this.currentState;
  }

  public get value(): T | Error | undefined {
    return this.currentValue;
  }

  /** @return true if the node is Valid or Error, otherwise false. */
  public isSettled(): boolean {
    return this.currentState === ComputableState.Valid || this.currentState === ComputableState.Error;
  }

  /**
   * @return true if this node's outcome can never change, otherwise false. A
   * raw source never is: it settles itself again whenever what it reads
   * changes.
   */
  public isFinal(): boolean {
    return false;
  }

  /** Record that a dependant has read `node`'s error (see {@link isUnhandledError}). */
  protected static observeError(node: ComputableSource<unknown>): void {
    node.errorObserved = true;
  }

  /**
   * Derive a node computing `fn` over this node's value, or `onError` over its
   * error (without `onError`, the error passes on). Where the callback returns
   * a source, the derived node takes that source's outcome. Unlike a
   * Promise's, the callback runs synchronously where this node is already
   * settled: do not rely on it running on a later tick.
   */
  public then<U>(fn: (value: T) => U | ComputableSource<U>, onError?: CatchHandler<U>): Computable<U> {
    return Computable.deriving([this], fn, onError, true);
  }

  /** Derive a node passing this node's value through, or computing `onError`
   * over its error. */
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
    const after = (complete: () => T): T | ComputableSource<T> => {
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
   * Call `fn` with this node's value, or `onError` with its error, exactly
   * once, without keeping this node in the graph: the tail made for the call
   * stops depending on this node as it consumes the result, so where it was
   * the last dependant this node detaches. Without `onError` the error is
   * reported through {@link onUnhandledError}. Use it where the result is
   * applied outside the graph and a second call would be wrong.
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
    /* An already-settled node ran the tail inside `then`, before `release`
     * was set: withdraw it now. */
    if (consumed) {
      release();
    }
  }

  /** Register `dep` as a dependant, attaching this node where it was
   * detached. Reached through the dependant's {@link attachTo}. */
  protected addDependant(dep: ComputableSource<any>): void {
    this.dependants.push(dep);
    if (this.currentState === ComputableState.Detached) {
      this.attach();
    }
  }

  /** Remove a dependant. Where it was the last, this node detaches, and each
   * of its inputs left with no dependant in turn. */
  protected removeDependant(dep: ComputableSource<any>): void {
    if (this.dropDependant(dep)) {
      ComputableSource.release([this]);
    }
  }

  /** Remove `dep` from the dependants, detaching nothing. @return true if
   * that left this node attached with no dependants, to be detached,
   * otherwise false. */
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
   * Enter the graph from {@link ComputableState.Detached} as Unresolved; a
   * no-op where already attached. {@link Computable} overrides it to register
   * with its inputs and compute; a raw source overrides it to subscribe and
   * read what it reports.
   */
  protected attach(): void {
    if (this.currentState === ComputableState.Detached) {
      this.currentState = ComputableState.Unresolved;
    }
  }

  /** Leave the graph: unregister from the inputs, or drop the subscription,
   * and become Detached. Detaches nothing further: @return the inputs left
   * with no dependants, which {@link release} detaches in turn. */
  protected detach(): ComputableSource<unknown>[] {
    this.currentState = ComputableState.Detached;
    return [];
  }

  /** Register as a dependant of each of `dependencies`: the way a subclass
   * reaches their protected {@link addDependant}. */
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
   * @return those left with no dependants. */
  protected dropFrom(dependencies: ComputableSource<unknown>[]): ComputableSource<unknown>[] {
    return dependencies.filter(dep => dep.dropDependant(this));
  }

  /**
   * Mark this node Invalid and its dependants maybe-invalid, computing
   * nothing: the new value comes with a later {@link settle}. A raw source
   * calls it to begin a batched change (see WatchController's
   * `PreparedUpdate`). Does nothing while Detached, nor while Unresolved
   * unless {@link recomputesWhileUnresolved}.
   */
  public invalidate(): void {
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

  /**
   * Settle with `value`, becoming final where it can
   * ({@link becomeFinalIfDone}), and tell the dependants: where `value`
   * differs (by identity) from the value held, each is first invalidated;
   * then each is asked to recompute. Does nothing while Detached.
   */
  protected settle(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    this.currentState = state;
    this.errorObserved = false;
    const changed = value !== this.currentValue;
    this.currentValue = value;
    this.becomeFinalIfDone();
    const dependants = this.dependants.length === 0 ? NO_DEPENDANTS : this.dependants.slice();
    if (changed) {
      for (const dep of dependants) {
        dep.invalidate();
      }
    }
    this.notifyDependants(dependants);
    this.checkUnhandledError();
  }

  /** Become final where this node, just settled, can never change: called
   * before its dependants are told, so each can become final in turn. A raw
   * source never does. */
  protected becomeFinalIfDone(): void {}

  /**
   * Return from a maybe state to the settled state held before, and tell the
   * dependants: what it depends on settled again with no value changed. Does
   * nothing while Detached.
   */
  protected revalidate(): void {
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    this.currentState = this.currentState === ComputableState.MaybeError ? ComputableState.Error : ComputableState.Valid;
    this.notifyDependants();
  }

  /**
   * Mark this node maybe-invalid, and everything that depends on it in turn
   * (a maybe-invalid wave): each settled node becomes MaybeValid or
   * MaybeError and keeps its outcome until what it depends on settles again.
   * Then call {@link afterMaybeInvalidWave} on each node marked. Works from a
   * list rather than the stack, so a long chain does not overflow it.
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
   * Mark this node alone maybe-invalid, where it is settled. @return the
   * nodes to mark next: its dependants, or none where it was not settled.
   */
  protected markSelfMaybeInvalid(): ComputableSource<unknown>[] {
    if (!this.isSettled()) {
      return [];
    }
    this.currentState = this.currentState === ComputableState.Error ? ComputableState.MaybeError : ComputableState.MaybeValid;
    return this.dependants.slice();
  }

  /** Ask each of `dependants` (a snapshot of them; by default taken now) to
   *  recompute, this node having settled or revalidated. When the outermost
   *  such call returns, run the cycle decisions deferred during it. */
  private notifyDependants(
    dependants: ReadonlyArray<ComputableSource<unknown>> = this.dependants.length === 0 ? NO_DEPENDANTS : this.dependants.slice()
  ): void {
    cascadeDepth++;
    try {
      for (const dep of dependants) {
        dep.maybeRecompute();
      }
    } finally {
      if (--cascadeDepth === 0) {
        for (const closer of deferredClosers) {
          deferredClosers.delete(closer);
          closer.recheckCycle();
        }
      }
    }
  }

  /** Call `fn` on a snapshot of the dependants: the cascade may detach one
   * meanwhile, changing the list. */
  private eachDependant(fn: (dep: ComputableSource<any>) => void): void {
    this.dependants.slice().forEach(fn);
  }

  /**
   * Respond to an input settling or revalidating. A raw source does nothing;
   * {@link Computable} overrides it to run, or revalidate, from its inputs.
   */
  protected maybeRecompute(): void {}

  /**
   * Decide, as a node that closed a cycle, whether to settle its error again. A
   * raw source closes no cycle; {@link Computable} overrides this.
   */
  protected recheckCycle(): void {}

  /**
   * @return true if this node's error would go unread, otherwise false: it is
   * settled Error, no dependant has read the error since, and no dependant
   * reads errors (see {@link observesErrors}). {@link Computable} also excludes
   * a binding.
   */
  protected isUnhandledError(): boolean {
    return this.currentState === ComputableState.Error && !this.errorObserved && !this.dependants.some(dep => dep.observesErrors());
  }

  /**
   * @return true if depending on this node reads its error, otherwise false:
   * false for the {@link Sink} behind a {@link ComputableHandle}, which holds a
   * chain without reading it, so a seated chain's error is still reported.
   */
  protected observesErrors(): boolean {
    return true;
  }

  /**
   * Report this node's error through {@link onUnhandledError} where it would
   * go unread, checking again one microtask later, so that a handler attached
   * just after (`const c = x.then(f); c.catch(g)`) suppresses the report. A
   * node that errors again later, under watch, is reported again.
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
 * A node derived from other {@link ComputableSource}s: like a Promise, but it
 * may depend on any number of inputs, and it computes again whenever one of
 * them changes. Made with `then`, `catch` and `finally`, {@link forAll},
 * {@link deriving} and {@link detached}; {@link from}, {@link resolve} and
 * {@link reject} make cells with no `fn`.
 *
 * - Running: once every input is settled, `fn` runs over their values. Where
 *   any input is Error, `errfn` runs instead over their errors combined in a
 *   MultiError, or, with no `errfn`, the node settles with them. A throw
 *   settles the node with the error.
 * - A source as the result: where `fn` returns a {@link ComputableSource},
 *   the node takes that source's outcome, now and as it changes, without
 *   running `fn` again (see {@link resolveTo}).
 * - Finality: a node settled Valid whose inputs, and whose source if it took
 *   one, are all final becomes final itself and lets go of them (see
 *   {@link becomeFinalIfDone}).
 * - Cycles: where the source `fn` returns depends on the node itself, the
 *   node settles with a {@link CycleError} (see {@link checkCycle}), and takes
 *   the source's value once the cycle is gone.
 */
export class Computable<T> extends ComputableSource<T> {
  /** The inputs `fn` runs over. */
  private dependsOn: ComputableSource<any>[] = [];
  /** The computation; undefined on a cell and on a final node. */
  private fn: ((...args: any[]) => any) | undefined = undefined;
  /** The computation run over the inputs' errors, in place of `fn`. */
  private errfn: CatchHandler<any> | undefined = undefined;
  /** The binding to the source `fn` last returned, where it returned one (see
   * {@link resolveTo}). Detached when `fn` runs again, so the old source's
   * subgraph detaches where nothing else depends on it. */
  private binding?: Computable<T>;
  /** On a binding: the node whose result it passes on. */
  private outer?: Computable<T>;
  /** On a binding: true while the source it depends on depends on its
   * `outer`, closing a cycle. The outer then holds the cycle's error and
   * refuses what the binding passes on (see {@link fromBinding}). */
  private cyclic = false;
  /** Set on a cyclic binding while a maybe-invalid wave it carried into its
   * outer is still being marked (see {@link afterMaybeInvalidWave}). */
  private carriedWave = false;
  /** Set where a cycle search reached this node and did not follow its
   * binding, the node being liable to run again (see {@link inputsWaitedOn}):
   * the binding is checked once the node's inputs come back unchanged (see
   * {@link maybeRecompute}). */
  private unsearched = false;
  /** The cycle closers holding on this node (see {@link recheckCycle}): each
   * is asked to decide again whenever this node moves. */
  private closedBy: Set<Computable<unknown>> | undefined;
  /** On a cycle closer: the nodes it holds on, those of the pending region
   * behind its binding (see {@link pendingRegion}) as each wave or ask finds
   * it. Released when the binding passes on a value, and when this node runs
   * again, detaches or becomes final. */
  private holding: Set<Computable<unknown>> | undefined;

  /** Label this node, and return it. */
  public labelled(label: Label | undefined): Computable<T> {
    this.label = label;
    return this;
  }

  /** Derive a node computing `fn` over `deps`, or `errfn` over their errors.
   *  Pass `owned` where `deps` was made for the node and is held by no one
   *  else, so it is kept rather than copied. */
  public static deriving<U>(
    deps: ComputableSource<any>[],
    fn: (...args: any[]) => U | ComputableSource<U>,
    errfn?: CatchHandler<U>,
    owned = false
  ): Computable<U> {
    const result = new Computable<U>();
    result.errfn = errfn;
    result.setDerivation(owned ? deps : deps.slice(), fn);
    return result;
  }

  /**
   * Make a node that computes `fn` when it is first depended on, not when it
   * is made: it is born Detached, as a raw source is. A memo filing such a
   * node holds it before `fn` runs, so a request for the same thing made
   * while `fn` runs finds the node and depends on it, and a cycle through it
   * is found (see {@link checkCycle}).
   */
  public static detached<U>(fn: () => U | ComputableSource<U>): Computable<U> {
    const result = new Computable<U>();
    result.fn = fn;
    return result;
  }

  /** Set a derived node's inputs and `fn`, and attach it. */
  private setDerivation(deps: ComputableSource<any>[], fn: (...args: any[]) => any): void {
    this.dependsOn = deps;
    this.fn = fn;
    this.attach();
  }

  /**
   * Derive a node computing `fn` over the values of `deps`, once all of them
   * are settled. Where any failed, `onError` runs over their errors combined
   * in a MultiError, or, without it, the node settles with them.
   */
  public static forAll<U, D extends readonly ComputableSource<unknown>[] | []>(
    deps: D,
    fn: (...deps: { -readonly [P in keyof D]: Awaited<D[P]> }) => U | ComputableSource<U>,
    onError?: CatchHandler<U>
  ): Computable<U> {
    return Computable.deriving(deps as unknown as ComputableSource<any>[], fn as (...args: any[]) => U | ComputableSource<U>, onError);
  }

  /** Make a constant node holding `value`. */
  public static resolve<T>(value: T): Computable<T> {
    const result = new Computable<T>();
    result.currentValue = value;
    result.currentState = ComputableState.Valid;
    return result;
  }

  /** Make a constant node holding `err`. */
  public static reject<T>(err: Error): Computable<T> {
    const result = new Computable<T>();
    /* Set directly, as resolve() does: settle() would drop the error on a
     * node still Detached. */
    result.currentValue = err;
    result.currentState = ComputableState.Error;
    return result;
  }

  /**
   * Make a cell settled by `fn`'s executor, which runs at once: the first
   * call of `resolve` or `reject` settles it (resolving with a source takes
   * that source's outcome), a synchronous throw rejects it, and any later call
   * is ignored, so a callback API that reports again after its outcome (a
   * stream's `error` after its `end`, a failed spawn's `close` after its
   * `error`) cannot settle it twice. The cell has no `fn`, so it never
   * detaches.
   */
  public static from<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: Error) => void) => void): Computable<T> {
    const result = new Computable<T>();
    /* Attach before the executor runs: settle does nothing while Detached, so
     * a resolve during it would be dropped. */
    result.attach();
    let settled = false;
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

  /** Register with the inputs and become Unresolved, then compute where every
   * input is settled, discarding any value held from before a detach;
   * otherwise wait for an input to settle. A cell with no `fn` just waits. */
  protected override attach(): void {
    /* Register while still Detached, so maybeRecompute ignores an input that
     * attaches and settles during registration: the node runs once, below,
     * with every input registered. */
    this.attachTo(this.dependsOn);
    super.attach();
    if (this.canRun() && this.fn) {
      this.run();
    }
  }

  /** Leave the graph, dropping the inputs and the binding; a node with no
   * `fn` (a constant, a cell, a final node) cannot compute its value again,
   * so it stays attached and keeps its value. */
  protected override detach(): ComputableSource<unknown>[] {
    this.releaseHolds();
    if (!this.fn) {
      return [];
    }
    super.detach();
    return [...this.dropFrom(this.dependsOn), ...this.dropBinding()];
  }

  protected override recomputesWhileUnresolved(): boolean {
    return this.fn !== undefined;
  }

  /** @return true if this node is MaybeValid or MaybeError, otherwise false. */
  private isMaybe(): boolean {
    return this.currentState === ComputableState.MaybeValid || this.currentState === ComputableState.MaybeError;
  }

  /** @return true if every input is settled, otherwise false. */
  private canRun(): boolean {
    return this.dependsOn.every(dep => dep.isSettled());
  }

  /** Run `fn` over the inputs' values, or `errfn` over their errors (or settle
   * with them), and take the result (see {@link resolveTo}). A throw settles
   * the node with the error. */
  private run(): void {
    /* The previous binding is replaced: detach it, so the old source's
     * subgraph detaches where nothing else depends on it. */
    this.unbind();
    this.unsearched = false;
    this.releaseHolds();
    /* No run is owed any longer: the node awaits what `fn` gives it. */
    if (this.currentState === ComputableState.Invalid) {
      this.currentState = ComputableState.Unresolved;
    }
    let errors: Error[] | undefined;
    for (const dep of this.dependsOn) {
      if (dep.state === ComputableState.Error) {
        ComputableSource.observeError(dep);
        (errors ??= []).push(dep.value as Error);
      }
    }
    try {
      if (errors !== undefined) {
        const error = MultiError.of(errors);
        if (this.errfn) {
          this.resolveTo(this.errfn(error));
        } else {
          this.rejectWith(error);
        }
      } else if (this.dependsOn.length === 1) {
        this.resolveTo(this.fn && this.fn(this.dependsOn[0].value));
      } else {
        const inputs = this.dependsOn.map(dep => dep.value);
        this.resolveTo(this.fn && this.fn(...inputs));
      }
    } catch (err) {
      this.rejectWith(toError(err));
    }
  }

  /**
   * Take `value` as this node's result, detaching any previous binding. A
   * plain value settles the node Valid. A final source's outcome is taken
   * outright. Any other source is bound: a binding, a node depending on the
   * source with this node as its `outer`, passes the source's changes on to
   * this node.
   * - A maybe-invalid wave, or an invalidate (as a maybe-invalid mark): this
   *   node and its dependants wait while the source recomputes.
   * - A settle: taken as this node's outcome, without running `fn` again.
   * - A revalidation: this node revalidates.
   *
   * A settle or revalidation lands only where this node's own inputs are
   * settled and no run is owed ({@link acceptFromBinding},
   * {@link revalidateFromBinding}), so a dependant never sees this node's
   * outcome from one batch beside an input's from another. A source already
   * settled settles this node at once. Then checks whether the binding closes
   * a cycle ({@link checkCycle}).
   */
  private resolveTo(value: T | ComputableSource<T>): void {
    this.unbind();
    if (!(value instanceof ComputableSource)) {
      this.settle(ComputableState.Valid, value);
      this.askClosers();
      return;
    }
    if (value.isFinal()) {
      if (value.state === ComputableState.Error) {
        ComputableSource.observeError(value);
        this.settle(ComputableState.Error, value.value as Error);
      } else {
        this.settle(ComputableState.Valid, value.value as T);
      }
      this.askClosers();
      return;
    }
    const binding = new Computable<T>();
    /* Set `outer` before attaching: an already-settled source settles the
     * binding during setDerivation's attach, which must reach this node. */
    binding.outer = this;
    this.binding = binding;
    binding.setDerivation([value], IDENTITY);
    this.checkCycle();
    this.askClosers();
  }

  /**
   * Check whether a pending binding closes a dependency cycle: whether the
   * source it depends on depends on this node, through nodes each waiting on
   * the next for certain ({@link inputsWaitedOn}). Where it does, settle with
   * the cycle's error ({@link settleCycle}) and keep the binding, marked
   * `cyclic`: the node keeps the error until its own inputs run it again, or
   * the binding passes on a value that no longer depends on it (see
   * {@link fromBinding}).
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

  /** Mark the binding cyclic and settle with a CycleError holding the labels
   * on the cycle: this node's, then those along `path`, from the binding round
   * to this node. */
  private settleCycle(path: ComputableSource<unknown>[]): void {
    const labels = [this, ...path].map(node => node.label).filter((label): label is Label => label !== undefined);
    /* The same cycle found again settles the error already held, an unchanged
     * value. */
    const held = this.currentValue;
    const same =
      held instanceof CycleError && held.labels.length === labels.length && held.labels.every((label, i) => label === labels[i]);
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
   * List the nodes this one is waiting on, for a cycle search: none where it
   * is settled; otherwise its inputs, and its binding where it is waiting on
   * that for certain, its inputs settled and no run owed. A node with a
   * binding whose inputs are unsettled, or which owes a run, may run again
   * and drop the binding, so the binding is left out and the node marked
   * `unsearched`: a run checks its new binding, and inputs coming back
   * unchanged check the old one ({@link maybeRecompute}).
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

  /** Detach the binding, and the source it depends on where nothing else
   * does. */
  private unbind(): void {
    ComputableSource.release(this.dropBinding());
  }

  /** Detach the binding, detaching nothing further: @return the source it
   * depends on where the binding was its last dependant. */
  private dropBinding(): ComputableSource<unknown>[] {
    const binding = this.binding;
    this.binding = undefined;
    return binding === undefined ? [] : binding.detach();
  }

  /** Settle with `err`, detaching the binding first, so that a source a
   * `from` executor resolved with before rejecting cannot settle this node
   * later. */
  private rejectWith(err: Error): void {
    this.unbind();
    this.settle(ComputableState.Error, err);
    this.askClosers();
  }

  /**
   * @return true if this node's outcome can never change, otherwise false: it
   * is settled, with no `fn` to run again and no binding to settle it again — a
   * constant, a settled {@link from} cell, or a derived node that has become
   * final (see {@link becomeFinalIfDone}).
   */
  public override isFinal(): boolean {
    return this.fn === undefined && this.binding === undefined && this.isSettled();
  }

  /**
   * Become final where this node is settled Valid and its inputs and its
   * binding are final: it then holds its value alone, letting go of its
   * inputs, its `fn` and its binding. They are final already, so letting go of
   * them detaches nothing. An error is not held this way: the node keeps its
   * `fn`, so it detaches when its last dependant leaves and computes again when
   * next depended on.
   */
  protected override becomeFinalIfDone(): void {
    const binding = this.binding;
    if (
      this.isFinal() ||
      this.currentState !== ComputableState.Valid ||
      !this.dependsOn.every(dep => dep.isFinal()) ||
      (binding !== undefined && !binding.isFinal())
    ) {
      return;
    }
    this.dropFrom(this.dependsOn);
    this.dependsOn = [];
    this.binding = undefined;
    this.fn = undefined;
    this.errfn = undefined;
    this.releaseHolds();
  }

  /** A binding passes its error to its `outer`, so its error is never
   * unhandled. */
  protected override isUnhandledError(): boolean {
    return this.outer === undefined && super.isUnhandledError();
  }

  /**
   * Respond to an input settling or revalidating, once every input is
   * settled. A node owed a run, or awaiting its first value, runs. A node in
   * a maybe state, its inputs back unchanged, revalidates where it has no
   * binding, takes a settled binding's result, and otherwise waits on the
   * binding, deciding a cyclic one ({@link recheckCycle}) and checking an
   * `unsearched` one for a cycle ({@link checkCycle}). Then asks the closers
   * holding on this node to decide again. Ignored while Detached, including
   * during {@link attach}.
   */
  protected override maybeRecompute(): void {
    if (this.currentState === ComputableState.Detached) {
      return;
    }
    if (!this.isSettled() && this.canRun()) {
      if (this.isMaybe()) {
        /* With a binding, the node is settled again only once the binding is
         * too: do not revalidate while a pending binding may still bring a
         * changed value, and settle with a settled binding's result, which
         * may have changed, rather than revalidating. */
        const binding = this.binding;
        if (!binding) {
          this.revalidate();
        } else if (binding.isSettled()) {
          this.fromBinding(binding.state as ComputableState.Valid | ComputableState.Error, binding.value as T | Error);
        } else if (binding.cyclic) {
          this.recheckCycle();
        } else if (this.unsearched) {
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
   * Decide, as a cycle closer (a node whose binding is `cyclic`), whether to
   * settle its error again while the binding is pending. Asked when its own
   * inputs come back unchanged from a maybe-invalid wave, and whenever a node
   * it holds on moves. It holds on every node of the pending region behind
   * the binding ({@link pendingRegion}, {@link holdOn}), and revalidates only
   * when it is in a maybe state with its inputs settled and no node of the
   * region can move ({@link canMove}): until then the batch may still cut
   * the cycle. A binding whose source no longer depends on this node decides
   * by the value it passes on ({@link fromBinding}). Asked during a
   * notification cascade, it decides when the outermost cascade ends, since
   * a node not yet told of an input that settled may be about to move.
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

  /** Hold on each derived node of `region`: each asks this node to decide
   * again whenever it moves (see {@link recheckCycle}). */
  private holdOn(region: ReadonlyArray<ComputableSource<unknown>>): void {
    for (const node of region) {
      if (node instanceof Computable && this.holding?.has(node) !== true) {
        (node.closedBy ??= new Set()).add(this);
        (this.holding ??= new Set()).add(node);
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
    if (this.holding === undefined) {
      return;
    }
    for (const node of this.holding) {
      node.closedBy?.delete(this);
    }
    this.holding = undefined;
  }

  /** @return true if this node can move on its own — a derived node owed a
   * run it can make, or a cell still to be resolved by its executor —
   * otherwise false. */
  private canMove(): boolean {
    if (this.fn === undefined) {
      return this.binding === undefined && !this.isSettled();
    }
    return (
      this.canRun() &&
      (this.currentState === ComputableState.Invalid ||
        (this.currentState === ComputableState.Unresolved && this.binding === undefined))
    );
  }

  /**
   * Get the pending region behind `binding`: every unsettled node it waits on,
   * directly or through other unsettled nodes, up to `closer`; undefined
   * where it does not wait on `closer` at all. A raw source still to settle
   * is in it as a leaf.
   */
  private static pendingRegion(
    binding: ComputableSource<unknown>,
    closer: ComputableSource<unknown>
  ): Array<ComputableSource<unknown>> | undefined {
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
   * Take the source's settled result from the binding, where this node's own
   * inputs are settled and no run is owed (it is not Invalid); otherwise
   * ignore it. An owed run binds afresh, and inputs coming back unchanged take
   * the binding's result then ({@link maybeRecompute}). Do not settle while
   * Invalid: maybeRecompute would see a settled node and skip the owed run.
   */
  private acceptFromBinding(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    if (this.canRun() && this.currentState !== ComputableState.Invalid) {
      this.fromBinding(state, value);
    }
  }

  /**
   * Settle with what the binding passes on, unless the binding is cyclic and
   * its source still depends on this node: then keep the cycle's error,
   * revalidating from a maybe state. Once the source no longer depends on
   * this node, clear `cyclic`, release the holds and settle.
   */
  private fromBinding(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
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
   * Take the binding's report that its source revalidated: revalidate where
   * this node's own inputs are settled and it is in a maybe state; otherwise
   * its inputs settle it through {@link maybeRecompute}.
   */
  private revalidateFromBinding(): void {
    if (this.canRun() && this.isMaybe()) {
      this.revalidate();
    }
  }

  /* The overrides below act on a binding (`outer` set) and pass its source's
   * changes on to the outer; on any other node they add nothing. */

  /** Invalidate, and on a binding mark the outer maybe-invalid, so the
   * outer's dependants do not read its old value before the new one arrives
   * with the settle. Not on a cyclic binding: while the cycle stands, what its
   * source settles to is the outer's own error coming back, or a change
   * inside the cycle; a value that cuts the cycle reaches the outer through
   * {@link fromBinding}. */
  public override invalidate(): void {
    super.invalidate();
    if (this.outer !== undefined && !this.cyclic) {
      this.outer.markMaybeInvalid();
    }
  }

  /** Mark this node alone maybe-invalid, returning the nodes to mark after
   * it: on a binding, its outer too. A cyclic binding passes the wave on only
   * where it was settled, so that the outer waits while the batch may cut
   * the cycle (see {@link recheckCycle}); a pending one does not, the wave
   * then being the outer's own error coming back. */
  protected override markSelfMaybeInvalid(): ComputableSource<unknown>[] {
    const settled = this.isSettled();
    const next = super.markSelfMaybeInvalid();
    this.carriedWave = this.cyclic && settled;
    return this.outer !== undefined && (!this.cyclic || settled) ? [...next, this.outer] : next;
  }

  /** On a cyclic binding that carried a wave into its outer, have the outer
   * hold on its pending region, now marked in full, so that whichever of its
   * nodes moves first asks the outer to decide. */
  protected override afterMaybeInvalidWave(): void {
    if (this.carriedWave) {
      this.carriedWave = false;
      this.outer?.holdOn(Computable.pendingRegion(this, this.outer) ?? []);
    }
  }

  protected override revalidate(): void {
    super.revalidate();
    /* Pass on only what landed: the base ignores a revalidate while
     * Detached. */
    if (this.currentState !== ComputableState.Detached) {
      this.outer?.revalidateFromBinding();
    }
  }

  protected override settle(state: ComputableState.Valid | ComputableState.Error, value: T | Error): void {
    super.settle(state, value);
    /* Pass on only what landed: the base ignores a settle while Detached, as
     * a binding is once its outer has run again. */
    if (this.currentState !== ComputableState.Detached) {
      this.outer?.acceptFromBinding(state, value);
    }
  }
}

/** The `fn` of every binding. */
const IDENTITY = (value: unknown): unknown => value;

/** The snapshot of a node with no dependants: shared, there being nothing in it. */
const NO_DEPENDANTS: ReadonlyArray<ComputableSource<unknown>> = [];

/**
 * Report `err` through {@link ComputableSource.onUnhandledError} at once: an
 * error that reached a {@link ComputableSource.once} tail with no `onError`,
 * or that a {@link ComputableHandle}'s `onSettled` threw. Not deferred as
 * {@link ComputableSource.checkUnhandledError} is, since no handler can be
 * added to either later.
 */
function reportUnobserved(err: Error): void {
  ComputableSource.onUnhandledError?.(err);
}

/**
 * The dependant a {@link ComputableHandle} registers on the chain it holds: a
 * ComputableSource, since only a source can be a dependant, kept apart so
 * that the handle itself cannot be depended on. Nothing depends on the sink,
 * so it stays Detached and ignores every cascade but {@link maybeRecompute},
 * through which it reports each settlement of the chain.
 */
class Sink<T> extends ComputableSource<never> {
  /** The chain held. */
  private seated: ComputableSource<T> | undefined;

  constructor(private readonly onSettled?: (source: ComputableSource<T>) => void) {
    super();
  }

  /** Hold `source`, releasing what was held: as its dependant, the sink keeps
   * it attached, and starts a raw source. */
  public seat(source: ComputableSource<T>): void {
    this.clear();
    this.seated = source;
    this.attachTo([source]);
  }

  /** Call `onSettled` on each settlement of the held chain: a settle, or a
   * revalidation with no value changed. A throw from it is reported through
   * {@link reportUnobserved}, never into the chain. */
  protected override maybeRecompute(): void {
    const source = this.seated;
    if (source?.isSettled()) {
      try {
        this.onSettled?.(source);
      } catch (err) {
        reportUnobserved(toError(err));
      }
    }
  }

  /** Release the held chain: where the sink was its last dependant, it
   * detaches. */
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
 * A hold on a chain in the graph, for something outside the graph. A chain
 * nothing depends on never detaches; {@link seat} makes the handle a
 * dependant of the chain, and {@link release}, or seating another chain,
 * withdraws it, so the chain detaches where nothing else depends on it. A
 * chain seated over is left Detached, so a late settle from it does nothing.
 *
 * A handle is not a source: nothing can depend on it, and it exposes no
 * value. Put a `then` on the chain before seating it to have its result. The
 * handle does not read the chain's error, so an error nothing else reads is
 * still reported as unhandled.
 */
export class ComputableHandle<T> {
  private readonly sink: Sink<T>;

  /** `onSettled`, if given, is called on every settlement of the seated
   *  chain from seating onward, including a revalidation that changed no
   *  value, which no `then` tail is told of. A chain already settled when
   *  seated reports nothing until it next settles. */
  constructor(onSettled?: (source: ComputableSource<T>) => void) {
    this.sink = new Sink<T>(onSettled);
  }

  /** Hold `source`, releasing whatever was held before. */
  public seat(source: ComputableSource<T>): void {
    this.sink.seat(source);
  }

  /** Release the held chain, which detaches where nothing else depends on
   * it. Idempotent. */
  public release(): void {
    this.sink.clear();
  }
}
