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
 * The constraint naming the build operation ('build', 'test', 'run', 'files',
 * ...): `fabr test foo` builds `foo<BUILD_OPERATION=test>`. A rule is selected
 * for an operation by a guard on it. The constraint propagates to a target's
 * dependencies, so an operation-specific rule requests BUILD_OPERATION=build
 * for its dependencies explicitly.
 */
export const BUILD_OPERATION = "BUILD_OPERATION";

/**
 * The constraint naming the platform fabr runs on, as a clang/LLVM triple
 * (`arm64-apple-macosx15.0`, `x86_64-linux-gnu`). Set by the driver, and not
 * meant to be overridden.
 */
export const HOST = "HOST";

/** The constraint keys the driver sets on every configuration, left out where
 *  constraints are displayed. */
export const AMBIENT_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([BUILD_OPERATION, HOST]);

/** The operations {@link preferredOperation} suggests, most preferred first. */
const OPERATION_PREFERENCE = ["build", "test", "run"];

/**
 * @return the operation to suggest for a target whose type supports
 * `operations` (as BuildModel.getOperations reports them, `"*"` being any):
 * the first of build, test and run it supports, or undefined.
 */
export function preferredOperation(operations: string[]): string | undefined {
  if (operations.includes("*")) {
    return OPERATION_PREFERENCE[0];
  }
  return OPERATION_PREFERENCE.find(operation => operations.includes(operation));
}

/**
 * The property naming the platform being built for, a triple as {@link HOST}
 * is. STD.fabr defaults it to `${HOST}`; set it per build (`-D TARGET=…`) or per
 * reference (`ref<TARGET=…>`) to cross-compile. Platform-specific package
 * selection reads it. A target resolved to be run has it set to HOST (see
 * TargetContext.runOverrides).
 */
export const TARGET = "TARGET";

/**
 * Select the entries of `constraints` to display: all but the `ambient` keys, a
 * TARGET equal to HOST, and COVERAGE off (the values a tool's run pins).
 */
export function shownConstraints(
  constraints: Iterable<[string, string]> & { get(key: string): string | undefined },
  ambient: ReadonlySet<string> = AMBIENT_CONSTRAINT_KEYS
): Array<[string, string]> {
  return [...constraints].filter(
    ([key, value]) =>
      !ambient.has(key) && !(key === TARGET && value === constraints.get(HOST)) && !(key === COVERAGE && value === "off")
  );
}

/**
 * The property saying what a test run does where output differs from a
 * recorded expectation: `check` (fail; the default, declared in STD.fabr) or
 * `update` (rewrite the record and offer it back to the source tree). `fabr
 * test -u` sets it.
 */
export const TEST_EXPECTATIONS = "TEST_EXPECTATIONS";

/** The {@link TEST_EXPECTATIONS} value that rewrites recorded expectations. */
export const UPDATE_EXPECTATIONS = "update";

/**
 * The property holding the regular expression selecting the tests a test run
 * runs: those whose name, as the runner names it (suite and test names joined
 * by spaces for the js runners, `Class#method` for JUnit), it matches part of.
 * Empty (the default, declared in STD.fabr) runs them all. `fabr test -t` sets
 * it.
 */
export const TEST_NAME_PATTERN = "TEST_NAME_PATTERN";

/**
 * The property saying whether what is built and tested is measured for code
 * coverage: `on` or `off` (the default, declared in STD.fabr). `fabr test
 * --coverage` sets it; a tool is resolved with it `off` where it is set (see
 * TargetContext.runOverrides).
 */
export const COVERAGE = "COVERAGE";

/** The {@link COVERAGE} value that turns measurement on. */
export const COVERAGE_ON = "on";

/**
 * The `files` operation: a target's output files, and nothing more. The
 * default `files` rule answers it with the target's `build` result as plain
 * files; a registry answers it with a package's own files, its dependencies
 * neither resolved nor fetched. The driver's `ls`, `cat` and `cp` resolve under
 * it.
 */
export const FILES_OPERATION = "files";

/** The `doc` operation: a target's documentation, generated from its sources,
 * or the documentation a registry publishes beside a package. */
export const DOC_OPERATION = "doc";

/** The `sources` operation: the source tree a target is built from, or the
 * sources a registry publishes beside a package. */
export const SOURCES_OPERATION = "sources";

/**
 * @return true if a registry's reference under `operation` is answered with
 * files alone, fetched at its lower bound with no closure and no joint
 * resolution (`files`, `doc`, `sources`), otherwise false.
 */
export function isFilesOperation(operation: string | undefined): boolean {
  return operation === FILES_OPERATION || operation === DOC_OPERATION || operation === SOURCES_OPERATION;
}

/** Get the operation a configuration of `constraints` is under: the
 * `BUILD_OPERATION` it was given, or `build`, as STD.fabr defaults it. */
export function operationOf(constraints: Constraints): string {
  return constraints.get(BUILD_OPERATION) ?? "build";
}

/**
 * An immutable set of build constraints, key to scalar value
 * (`BUILD_OPERATION`, `TARGET`, `BUILD_TYPE`, and `-D`/`<k=v>` overrides). Each
 * distinct set is a distinct {@link BuildContext}; sets equal by value
 * ({@link equals}) denote the same one.
 *
 * Make one with {@link of} or {@link with}. The common operation overrides are
 * {@link BUILD_OVERRIDE}, {@link RUN_OVERRIDE} and {@link FILES_OVERRIDE}.
 */
export class Constraints {
  /** The empty configuration (the ambient default build). */
  public static readonly EMPTY = new Constraints(new Map());

  private constructor(private readonly values: ReadonlyMap<string, string>) {}

  /** Make a constraint set from a plain record (`-D` flags, host properties,
   *  a merged override map). */
  public static of(values: Record<string, string>): Constraints {
    return new Constraints(new Map(Object.entries(values)));
  }

  /** Get the value for `key`, or undefined if unconstrained. */
  public get(key: string): string | undefined {
    return this.values.get(key);
  }

  /** @return true if `key` is constrained, otherwise false. */
  public has(key: string): boolean {
    return this.values.has(key);
  }

  public get size(): number {
    return this.values.size;
  }

  public isEmpty(): boolean {
    return this.values.size === 0;
  }

  /** Layer `overrides` on top of this set, their values winning; returns this
   *  set itself where `overrides` is absent or empty. */
  public with(overrides?: Constraints): Constraints {
    if (!overrides || overrides.values.size === 0) {
      return this;
    }
    return new Constraints(new Map([...this.values, ...overrides.values]));
  }

  /** Get the constrained keys, in insertion order. */
  public keys(): IterableIterator<string> {
    return this.values.keys();
  }

  public entries(): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  public [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  /** @return true if `other` holds the same keys mapping to the same values, otherwise false. */
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

/** The override `BUILD_OPERATION=build`, which an operation-specific rule
 *  applies to its dependencies to read their build output. */
export const BUILD_OVERRIDE = Constraints.of({ [BUILD_OPERATION]: "build" });

/** The override `BUILD_OPERATION=run`, to resolve a target to run it. It
 *  does not set TARGET to HOST; TargetContext.runOverrides does both. */
export const RUN_OVERRIDE = Constraints.of({ [BUILD_OPERATION]: "run" });

/** The override `BUILD_OPERATION=files`, to read a dependency's output files
 *  only (see {@link FILES_OPERATION}). */
export const FILES_OVERRIDE = Constraints.of({ [BUILD_OPERATION]: FILES_OPERATION });
