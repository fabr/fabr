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

/*
 * The engine-layer error vocabulary: every typed error the core can reject
 * with, in one place (the model layer's own errors live in model/Errors.ts —
 * they reference model types the core doesn't know). Errors carry data;
 * presentation is exclusively the driver's job.
 */

import { STATUS_CODES } from "node:http";

import { describeProvenance, IProvenanceStep } from "./Provenance";
import { RepositoryRef } from "./Repository";

/**
 * Coerce an arbitrary thrown value to an Error.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Attach remedy text to an error, to be rendered as a `help:` line when the
 * error is reported (the message states the problem; the help suggests the
 * fix). Carried as a plain optional property so any typed error can bear one.
 */
export function attachHelp<T extends Error>(err: T, help: string): T {
  return Object.assign(err, { help });
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

/**
 * A non-200 HTTP response, with the status carried as data so a caller can
 * translate specific statuses (e.g. a registry 404) into domain messages.
 *
 * The rendered reason phrase is the standard one for the code, not the
 * response's own: HTTP/2 has no reason phrase and the client doesn't surface
 * one over HTTP/1 either, so the alternative is the bare number.
 */
export class HttpStatusError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string
  ) {
    super(`${statusCode}${STATUS_CODES[statusCode] ? " " + STATUS_CODES[statusCode] : ""}: ${url}`);
  }
}

/**
 * Downloaded content failed to match the integrity digest its metadata
 * promised — TLS alone can't catch a truncated-but-valid payload or a tampered
 * mirror, so a mismatch fails the fetch (and, since it throws inside the fetch
 * `process` callback, the entry is never cached). `algorithm` names the digest
 * compared (`sha512`, `sha1`, …); `expected`/`actual` are its encoded values.
 */
export class IntegrityError extends Error {
  constructor(
    public readonly url: string,
    public readonly algorithm: string,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(`integrity check failed for ${url}: ${algorithm} expected ${expected}, got ${actual}`);
  }
}

/**
 * A mechanical failure while executing a build step (spawning processes,
 * staging files, ...) — as opposed to a semantic diagnostic like a conflict or
 * resolution failure. Multiple execution errors from one target are reported
 * grouped under the target rather than as individual diagnostics.
 */
export class ExecutionError extends Error {}

/**
 * A test run completed mechanically but some tests failed — as distinct from
 * an ExecutionError (the run itself couldn't be performed). Test rules throw
 * this with a pre-rendered summary ("N of M tests failed: ..."), which the
 * driver reports against the target under test rather than as a build failure.
 */
export class TestsFailedError extends Error {
  /** Number of failing tests */
  public readonly failed: number;
  /** Total number of tests that ran */
  public readonly total: number;

  constructor(message: string, failed: number, total: number) {
    super(message);
    this.failed = failed;
    this.total = total;
  }
}

/**
 * One side of a conflict: the provenance chain of the contributor and, for
 * disambiguating same-provenance conflicts, an optional concrete `detail` (a
 * file's display name, a package's version).
 */
export interface IConflictSource {
  provenance?: IProvenanceStep;
  detail?: string;
}

/** A conflict side as reported: the label is derived from the provenance. */
export interface IConflictSide extends IConflictSource {
  label: string;
}

/**
 * Two provenance-attributed sources supply the same `key` with different
 * content — a naming conflict. `kind` names what collides ("files", "catalog
 * entries", ...); both sides are attributed so whoever reports it (the driver)
 * can point at each. A single joint version-selection already coalesces two
 * versions of one package, so a package-name collision here is genuinely
 * distinct sources, not a version disagreement.
 */
export class ConflictError extends Error {
  public readonly left: IConflictSide;
  public readonly right: IConflictSide;

  constructor(
    public readonly kind: string,
    public readonly key: string,
    left: IConflictSource,
    right: IConflictSource
  ) {
    const leftSide = describeSide(left);
    const rightSide = describeSide(right);
    super(
      leftSide.label === rightSide.label
        ? `Conflicting ${kind} for ${key} (within '${leftSide.label}')`
        : `Conflicting ${kind} for ${key} (from '${leftSide.label}' and '${rightSide.label}')`
    );
    this.left = leftSide;
    this.right = rightSide;
  }
}

function describeSide(source: IConflictSource): IConflictSide {
  return { ...source, label: describeProvenance(source.provenance) ?? source.detail ?? "unknown" };
}

/**
 * Rejection raised when the registry cannot supply the metadata needed to
 * continue a resolution walk (a fetch failure, an unpublished package) —
 * unlike a constraint violation, which is reported via Resolution.errors.
 * Carries the failing package, the chain of requirers that first reached it
 * (nearest first; empty when the package is itself a root requirement), and
 * the root package name the chain leads back to — so a repository can
 * attribute the failure to the written reference(s) whose requirement pulled
 * the package in.
 */
export class MetadataFetchError extends Error {
  constructor(
    public readonly pkg: string,
    public readonly version: string,
    public readonly requirerPath: ReadonlyArray<string>,
    public readonly rootPkg: string,
    public readonly cause: Error
  ) {
    super(requirerPath.length > 0 ? `${cause.message} (required by ${requirerPath.join(" < ")})` : cause.message);
  }
}

/**
 * Hard errors found during a resolution walk (an unparseable constraint in
 * registry metadata, an unconstrained-only requirement), each attributed to
 * the root package whose subtree contains it — carried structured so the
 * repository can map every failure back to the written reference(s) requiring
 * that root (the walk-errors analogue of MetadataFetchError's rootPkg).
 */
export class ResolutionWalkError extends Error {
  constructor(public readonly failures: ReadonlyArray<{ message: string; rootPkg: string }>) {
    super(failures.map(failure => failure.message).join("\n"));
  }
}

/**
 * A specific package version does not exist in its registry (the translated
 * 404 for a version document) — distinguished from transport failures so the
 * resolver can attempt the floor-raise repair (an unpublished declared floor)
 * rather than treating it as an unreachable registry.
 */
export class VersionNotFoundError extends Error {
  constructor(
    public readonly pkg: string,
    public readonly version: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * A repository failure attributed to the written reference(s) it traces back
 * to: the underlying error (e.g. a registry 404) wrapped with the refs whose
 * requirement — or whose closure's root requirement — the failure arose from.
 * The refs' carried provenance (model-ref steps) is what lets the driver point
 * back at the written requirement rather than only at the consuming target.
 */
export class RequirementResolutionError extends Error {
  constructor(
    public readonly refs: ReadonlyArray<RepositoryRef>,
    public readonly cause: Error
  ) {
    super(cause.message);
  }
}

