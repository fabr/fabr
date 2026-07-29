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

/**
 * The build *verb* constraint ('build', 'test', 'run', 'files', ...): `fabr test foo`
 * is sugar for constraining BUILD_OPERATION=test. Rule selection matches against it,
 * so a target type provides an operation by registering a rule constrained to it.
 * An operation-specific rule is responsible for explicitly requesting
 * BUILD_OPERATION=build for its dependencies (the constraint otherwise propagates).
 */
export const BUILD_OPERATION = "BUILD_OPERATION";

/**
 * The platform triple (clang/LLVM form, e.g. `arm64-apple-macosx15.0`,
 * `x86_64-linux-gnu`) fabr is actually running on — a driver-injected fact, not
 * meant to be overridden. Native rules consume it verbatim; the npm gate reads a
 * lossy {os,cpu,libc} projection off it.
 */
export const HOST = "HOST";

/**
 * The platform triple we are *building for*. `default TARGET = ${HOST};` (STD.fabr),
 * overridable per build (`-D TARGET=…`) or per reference (`ref<TARGET=…>`) to
 * cross-compile. Repository/native selection gates on this, not HOST. Running a
 * target (`BUILD_OPERATION=run`) forces TARGET back to HOST — you can only execute
 * what was built for the machine you're on, and it makes build *tools* resolve
 * host-side automatically.
 */
export const TARGET = "TARGET";

/**
 * The `files` operation: "give me the output files, and do no more than that."
 * A weaker form of `build` — it has no type-specific rules of its own; a generic
 * default rule (see rules/DefaultFilesRule) delegates it to the target's `build`
 * result. Its value is that a consumer reading the operation off its context can
 * do strictly less work when only the files are wanted: notably an `@npm:`
 * repository delivers a package's own files without resolving its dependency
 * closure. The driver's `ls`/`cat` verbs resolve under it.
 */
export const FILES_OPERATION = "files";

/**
 * An immutable, interned set of scalar build-config constraints (`BUILD_OPERATION`,
 * `TARGET`, `BUILD_TYPE`, and `-D`/`<k=v>` overrides). A distinct constraint set is
 * a distinct {@link BuildContext} (interned by value — see {@link equals}).
 *
 * Construct via {@link of} (from a plain record) or {@link with} (layer another set
 * on top); there is no public constructor. The common operation overrides are the
 * shared {@link BUILD_OVERRIDE} / {@link RUN_OVERRIDE} / {@link FILES_OVERRIDE}.
 */
export class Constraints {
  /** The empty configuration (the ambient default build). */
  public static readonly EMPTY = new Constraints(new Map());

  private constructor(private readonly values: ReadonlyMap<string, string>) {}

  /** Build a constraint set from a plain record (the funnel from raw key/value
   * data — `-D` flags, host properties, a merged override map). */
  public static of(values: Record<string, string>): Constraints {
    return new Constraints(new Map(Object.entries(values)));
  }

  /** The value for `key`, or undefined if unconstrained. */
  public get(key: string): string | undefined {
    return this.values.get(key);
  }

  /** Whether `key` is constrained. */
  public has(key: string): boolean {
    return this.values.has(key);
  }

  public get size(): number {
    return this.values.size;
  }

  public isEmpty(): boolean {
    return this.values.size === 0;
  }

  /** This set with `overrides` layered on top — a later key wins; returns this set
   * unchanged when `overrides` is absent or empty. */
  public with(overrides?: Constraints): Constraints {
    if (!overrides || overrides.values.size === 0) {
      return this;
    }
    return new Constraints(new Map([...this.values, ...overrides.values]));
  }

  /** The constrained keys, in insertion order. */
  public keys(): IterableIterator<string> {
    return this.values.keys();
  }

  public entries(): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  public [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  /** Value equality — same keys mapping to same values (the interning key). */
  public equals(other: Constraints): boolean {
    if (other === this) {
      return true;
    }
    if (this.values.size !== other.values.size) {
      return false;
    }
    for (const [key, value] of this.values) {
      if (other.values.get(key) !== value) {
        return false;
      }
    }
    return true;
  }
}

/** Resolve a dependency for its build output — `BUILD_OPERATION=build`. The
 * override an operation-specific rule applies to its deps (which otherwise inherit
 * the rule's own operation). */
export const BUILD_OVERRIDE = Constraints.of({ [BUILD_OPERATION]: "build" });

/** Resolve a target in order to *run* it — `BUILD_OPERATION=run`. Note TARGET is
 * pinned back to HOST separately (see BuildContext.runOverrides). */
export const RUN_OVERRIDE = Constraints.of({ [BUILD_OPERATION]: "run" });

/** Resolve a dependency for its output files only — `BUILD_OPERATION=files` (see
 * {@link FILES_OPERATION}). */
export const FILES_OVERRIDE = Constraints.of({ [BUILD_OPERATION]: FILES_OPERATION });
