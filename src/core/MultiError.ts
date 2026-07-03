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

/**
 * Coerce an arbitrary thrown value to an Error.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Aggregate of multiple independent errors (e.g. several dependencies of a
 * computation failing), flattened into a single list.
 */
export class MultiError extends Error {
  public readonly errors: ReadonlyArray<Error>;

  private constructor(errors: Error[]) {
    super(errors.map(err => err.message).join("\n"));
    this.errors = errors;
  }

  /**
   * Aggregate one or more errors: nested MultiErrors are flattened, and
   * duplicates (by object identity) are dropped, so a single root cause that
   * reaches a computation via multiple paths is reported once. If only one
   * distinct error remains it is returned as-is rather than wrapped, which
   * also preserves its identity for unchanged-value propagation checks.
   *
   * @param errors a non-empty list of errors.
   */
  public static of(errors: Error[]): Error {
    const distinct = new Set<Error>();
    for (const err of errors) {
      if (err instanceof MultiError) {
        err.errors.forEach(nested => distinct.add(nested));
      } else {
        distinct.add(err);
      }
    }
    if (distinct.size === 0) {
      throw new Error("MultiError.of() requires at least one error");
    }
    const flat = [...distinct];
    return flat.length === 1 ? flat[0] : new MultiError(flat);
  }
}
