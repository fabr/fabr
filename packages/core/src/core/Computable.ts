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
 * its first dependant; every other node enters the graph at birth — a derived node
 * attaches eagerly on creation (so fire-and-forget tails run), a `from`/`once` cell
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
export abstract class ComputableSource<T> {
  /** The settled result: T when Valid, Error when Error (undefined while unresolved) */
  protected currentValue: T | Error | undefined;
  /** Doubles as the attached/detached bit; see the class doc's Attachment note. */
  protected currentState: ComputableState = ComputableState.Detached;
  /** Nodes depending on this one — typed at the base contract the cascade uses (its
   * cascade methods), not the concrete `Computable` they always are in practice (via then/forAll). */
  private readonly dependants: ComputableSource<any>[] = [];

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
    /* Inert while Detached (the enforced invariant — see the class doc): a
     * detached node is out of the graph and holds no value, which is what makes
     * detach reversible. The async tail of a superseded evaluation (an orphaned
     * TreeQuery's enumeration, a watch batch's prepared update) routinely
     * completes after the detach; dropping it here discards the stale result —
     * a reattach re-derives from current state. Without the guard a late settle
     * would strand the node serving a stale value at zero dependants, and
     * addDependant's Detached check would never reattach it. */
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
     * state and a detached node has none — the ternary below would otherwise
     * mint a Valid out of nothing if a stray cascade brushed an orphan. */
    if (this.currentState === ComputableState.Detached) {
      return;
    }
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

  /**
   * Would this node's settled error go unobserved? True when it is settled Error
   * and in the graph with no dependant to read it. {@link Computable} narrows it
   * to also exclude a binding node (which forwards to its `outer`). The
   * `dependants` check already excludes a detached node: a derived node that loses
   * its last dependant *detaches* (Detached, not Error), so only an eager,
   * still-live terminal tail reaches here.
   */
  protected isUnhandledError(): boolean {
    return this.currentState === ComputableState.Error && this.dependants.length === 0;
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

  /** Core derivation: a node computing `fn` over `deps` (or `errfn` on failure). */
  public static deriving<U>(
    deps: ComputableSource<any>[],
    fn: (...args: any[]) => U | Computable<U>,
    errfn?: CatchHandler<U>
  ): Computable<U> {
    const result = new Computable<U>();
    result.errfn = errfn;
    result.setDerivation(deps, fn);
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
   * Once-and-once only version of Computable.from, typically for non-repeatable processes that need to avoid
   * settling multiple times.
   * @param fn
   * @returns
   */
  public static once<T>(fn: (resolve: (value: T | Computable<T>) => void, reject: (err: Error) => void) => void): Computable<T> {
    const result = new Computable<T>();
    result.attach(); // in the graph from birth — see from()
    let settled = false;

    /* As from(), a synchronous executor throw rejects — but only if nothing has
     * settled yet, upholding once()'s settle-exactly-once contract. */
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

  protected override detach(): void {
    /* Detachable ⟺ reconstructable. A node with no `fn` (a resolve/reject/from
     * constant) can't be recomputed on reattach and has no inputs registered to
     * release, so it never detaches — it keeps serving its value at zero dependants. */
    if (!this.fn) {
      return;
    }
    this.detachFrom(this.dependsOn);
    this.unbind();
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
    this.unbind();
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
    /* Resolving to another source: link to it through a binding — an identity node
     * that sits on the inner as its sole dependant and mirrors the inner's cascade
     * (maybe-invalid, revalidate, settle) into us, its `outer` (the overrides
     * below). Being a real dependant is what carries the maybe-invalid frontier
     * across the boundary (a batch invalidation must reach us and our dependants);
     * forwarding the settle rather than recomputing us is what stops a
     * fresh-per-call factory (`x.then(v => build(v))`) from thrashing. Superseding
     * on re-run is handled in run(); a stray re-resolve (from() may fire more than
     * once) is superseded here via unbind. */
    if (value instanceof ComputableSource) {
      this.unbind();
      const binding = new Computable<T>();
      /* Wire the outer before entering the graph: an already-settled inner
       * settles the binding during setDerivation's attach, which must forward. */
      binding.outer = this;
      binding.setDerivation([value], IDENTITY);
      this.binding = binding;
      /* An already-settled inner settled the binding during attach, but its
       * forward may have been held: mid-re-run this node is Invalid, which the
       * forward's coherence gate cannot tell apart from a stale binding under a
       * pending re-run (see acceptFromBinding). THIS binding is definitionally
       * current — just created from the current inputs — so pull its result
       * directly. (Already delivered ⇒ settled ⇒ skipped.) */
      if (binding.isSettled() && !this.isSettled()) {
        this.settle(binding.state as ComputableState.Valid | ComputableState.Error, binding.value as T | Error);
      } else if (this.currentState === ComputableState.Invalid) {
        /* A re-run bound a still-pending inner: `fn` has now consumed the
         * (settled) inputs, so Invalid — "a re-run is owed" — no longer
         * describes this node; it is awaiting its inner, exactly the state a
         * first attach waits in. Normalizing to Unresolved is what lets
         * acceptFromBinding read Invalid as *always* meaning a pending re-run
         * (hold, the binding is about to be superseded) while the awaited
         * inner's eventual forward lands (deliver). */
        this.currentState = ComputableState.Unresolved;
      }
    } else {
      this.settle(ComputableState.Valid, value);
    }
  }

  /** Tear down the current resolveTo binding, releasing the inner subgraph once
   * it has no other dependants. */
  private unbind(): void {
    this.binding?.detach();
    this.binding = undefined;
  }

  private rejectWith(err: Error): void {
    this.settle(ComputableState.Error, err);
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
      if (this.state === ComputableState.MaybeValid || this.state === ComputableState.MaybeError) {
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
          this.settle(binding.state as ComputableState.Valid | ComputableState.Error, binding.value as T | Error);
        }
      } else {
        this.run();
      }
    }
  }

  /**
   * The binding delivering the inner's settled result. It lands only when this
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
      this.settle(state, value);
    }
  }

  /**
   * The binding reporting that the inner revalidated unchanged: return to
   * settled only if the own-dep side is settled too and we are in a maybe state
   * (the only states a revalidation can restore); otherwise hold — the own-dep
   * side's own settle/revalidate converges us through maybeRecompute.
   */
  private revalidateFromBinding(): void {
    if (
      this.canRun() &&
      (this.currentState === ComputableState.MaybeValid || this.currentState === ComputableState.MaybeError)
    ) {
      this.revalidate();
    }
  }

  /* A binding node mirrors the full cascade into its outer (no-ops elsewhere —
   * `outer` is only ever set on a binding): the maybe-invalid frontier, the
   * revalidation wave, and the settle itself (state + value adopted verbatim,
   * never recomputed — re-running the outer's fn would mint a fresh inner).
   * The invalidating direction forwards unconditionally (unsettling is always
   * safe); the SETTLING direction is coherence-gated on the outer
   * (acceptFromBinding / revalidateFromBinding): the outer returns to settled
   * only when both its own deps and the binding agree, so a consumer never
   * observes mixed-generation inputs across the boundary. */

  /** A hard invalidate (the inner re-settled a changed value with no prior
   * maybe-invalid wave) must still unsettle the outer, or a consumer sharing
   * another arm of the diamond reads the outer's stale value mid-cascade. The
   * outer only ever needs maybe: the definite new value arrives via settle. */
  public override invalidate(): void {
    super.invalidate();
    this.outer?.markMaybeInvalid();
  }

  protected override markMaybeInvalid(): void {
    super.markMaybeInvalid();
    this.outer?.markMaybeInvalid();
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
