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
 * The engine layer's typed errors, every one the core can reject with (the
 * model layer's are in model/Errors.ts). Errors carry data; the driver renders
 * them.
 */

import { STATUS_CODES } from "node:http";

import { describeProvenance, IProvenanceStep } from "./Provenance";
import type { Reference } from "./Reference";
import type { RepositoryRef } from "./Repository";
import type { OutputStream } from "../support/Execute";
import type { ITestReport } from "../support/TestResult";
import type { Package } from "./PackageFileSet";

/** Coerce an arbitrary thrown value to an Error. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new FabrError(String(err));
}

/**
 * The base of fabr's errors. The message states the problem; `help` holds the
 * remedy, one entry per `help:` line of the report (several for a multi-line
 * remedy such as a set of overrides to paste), empty where there is none.
 * `cause` is the error this one was raised in response to, where there is one.
 * An error wrapping another holds no copy of its help: read the help for a
 * failure with {@link helpOf}.
 */
export class FabrError extends Error {
  public help: string[];
  public readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.help = [];
    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  /** Set this error's help, replacing any it has, and return the same error:
   *  for a remedy known only to a caller of the code that raised it. */
  public withHelp(help: string | string[]): this {
    this.help = Array.isArray(help) ? help : [help];
    return this;
  }
}

/** The name a node of the Computable graph is reported by when it is on a
 * dependency cycle: the name it answers for, or the written reference it was
 * made for. */
export interface Label {
  readonly name: string;
}

/**
 * A dependency cycle in the Computable graph. `labels` are those of the nodes
 * on it that have one: the node that closed the cycle first, then each node
 * it depends on in turn. The message names the first; the whole cycle is
 * read off the labels.
 */
export class CycleError extends FabrError {
  constructor(public readonly labels: ReadonlyArray<Label>) {
    super(
      labels.length > 0 ? `Circular dependency: '${labels[0].name}' depends on itself` : "A computation depends on its own result"
    );
  }
}

/**
 * Find the help for a failure: that of the nearest error along `err`'s chain of
 * causes, itself included, that carries any; empty when none does.
 */
export function helpOf(err: Error): string[] {
  for (let current: Error | undefined = err; current instanceof FabrError; current = current.cause) {
    if (current.help.length > 0) {
      return current.help;
    }
  }
  return [];
}

/** Several independent errors (several dependencies of a computation failing,
 *  say), as one flat list. */
export class MultiError extends FabrError {
  public readonly errors: ReadonlyArray<Error>;

  private constructor(errors: Error[]) {
    super(errors.map(err => err.message).join("\n"));
    this.errors = errors;
  }

  /**
   * Aggregate `errors`: nested MultiErrors are flattened and duplicates (by
   * object identity) dropped, so one cause reaching a computation by several
   * paths is reported once. Where one distinct error remains, it is returned
   * itself, unwrapped. Throws where `errors` is empty.
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
      throw new FabrError("MultiError.of() requires at least one error");
    }
    const flat = [...distinct];
    return flat.length === 1 ? flat[0] : new MultiError(flat);
  }
}

/**
 * A non-200 HTTP response. A caller may translate a status (a registry's 404,
 * say) into a message of its own. The message's reason phrase is the standard
 * one for the code (`STATUS_CODES`), not the response's.
 */
export class HttpStatusError extends FabrError {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    /** A 401's `WWW-Authenticate` challenges, as sent; empty for any other status. */
    public readonly challenges: readonly string[] = []
  ) {
    super(`${statusCode}${STATUS_CODES[statusCode] ? " " + STATUS_CODES[statusCode] : ""}: ${url}`);
  }
}

/**
 * Content that does not match the integrity digest stated for it (by registry
 * metadata, or a `fetch` declaration). Raised while a download streams, before
 * it is committed to the cache, and against stored content a declared digest
 * does not match. `algorithm` names the digest compared (`sha512`, `sha1`, …);
 * `expected` and `actual` are its encoded values, `expected` listing every
 * acceptable value joined by ` | `.
 */
export class IntegrityError extends FabrError {
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
 * A mechanical failure while executing a build step (spawning a process,
 * staging files, ...), as opposed to a diagnostic such as a conflict or a
 * resolution failure. The failure report groups a target's execution errors
 * under the target.
 */
export class ExecutionError extends FabrError {}

/** One line of a command's output, and the stream it arrived on. */
export interface ICommandOutputLine {
  stream: OutputStream;
  text: string;
}

/**
 * A command that ran and failed: its command line (`$ cmd args…`), its output
 * lines in arrival order, and how it ended ("exited with error code 2"). The
 * message is the three, plain; a reporter that knows whose command it was
 * renders the output lines attributed, as the live stream does.
 */
export class CommandFailedError extends ExecutionError {
  constructor(
    public readonly commandLine: string,
    public readonly output: readonly ICommandOutputLine[],
    public readonly outcome: string
  ) {
    super([commandLine, ...output.map(line => line.text), outcome].join("\n"));
  }
}

/**
 * A test run that completed with some tests failed, as distinct from an
 * ExecutionError (the run could not be performed). The message is a rendered
 * summary ("N of M tests failed: ..."); the driver reports it against the
 * target under test as test outcomes, not as a build failure.
 */
export class TestsFailedError extends FabrError {
  /** Number of failing tests */
  public readonly failed: number;
  /** Total number of tests that ran */
  public readonly total: number;
  /** The run's report, each test's outcome, where the run made one. */
  public readonly report?: ITestReport;

  constructor(message: string, failed: number, total: number, report?: ITestReport) {
    super(message);
    this.failed = failed;
    this.total = total;
    this.report = report;
  }
}

/**
 * One side of a conflict: the contributor's provenance and an optional
 * `detail` (a file's display name, a package's version), which labels the side
 * where the provenance describes nothing.
 */
export interface IConflictSource {
  provenance?: IProvenanceStep;
  detail?: string;
}

/** A conflict side as reported, with its label: the provenance's description,
 *  else the `detail`, else "unknown". */
export interface IConflictSide extends IConflictSource {
  label: string;
}

/**
 * A naming conflict: two sources supply the same `key` with different content.
 * `kind` names what collides ("files", "catalog entries", ...); each side
 * carries its provenance, so a report can point at both.
 */
export class ConflictError extends FabrError {
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
 * A resolution walk's failure to read the metadata of `packageName` at
 * `version` from its registry (a fetch failure, an unpublished version).
 * `requirerPath` is the chain of requirers that first reached the package,
 * nearest first, empty where it is a root requirement; `rootName` is the root
 * it leads back to, so a repository can attribute the failure to the written
 * references that required that root. An unsatisfied constraint is no such
 * failure: it is listed in the MVSResolution's `violations`.
 */
export class MetadataFetchError extends FabrError {
  declare public readonly cause: Error;

  constructor(
    public readonly packageName: string,
    public readonly version: string,
    public readonly requirerPath: ReadonlyArray<string>,
    public readonly rootName: string,
    cause: Error
  ) {
    super(requirerPath.length > 0 ? `${cause.message} (required by ${requirerPath.join(" < ")})` : cause.message, cause);
  }
}

/**
 * The problems a resolution walk listed in its `errors` (an unparseable
 * constraint in registry metadata, a package required only without a lower
 * bound, ...), each with the root package whose subtree holds it (`rootName`),
 * so a repository can attribute it to the written references requiring that
 * root.
 */
export class ResolutionWalkError extends FabrError {
  constructor(
    public readonly failures: ReadonlyArray<{
      message: string;
      rootName: string;
      name?: string;
      publishedName?: string;
      requiredBy?: string;
      floorless?: ReadonlyArray<{ name: string; publishedName?: string }>;
      help?: string[];
    }>
  ) {
    super(failures.map(failure => failure.message).join("\n"));
  }
}

/**
 * A package version its registry does not have (a 404 for the version's
 * document). The resolver takes a lower bound that answers this as never
 * published, and meets it from a published version (see resolveMVS); any
 * other fetch failure fails the walk.
 */
export class VersionNotFoundError extends FabrError {
  constructor(
    public readonly packageName: string,
    public readonly version: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * A requirement on a package that was bound, by its name, to a target of the
 * project that builds no package. `requirer` is the package that states the
 * requirement, or the registry's reference the target answers; `constraint` is
 * what a package's requirement asked for, where that is known.
 */
export class TargetNotPackageError extends FabrError {
  constructor(
    public readonly requirer: Package | RepositoryRef,
    public readonly dependency: Package,
    public readonly constraint?: string
  ) {
    const name = dependency.packageName;
    super(
      (!("packageName" in requirer)
        ? `'${requirer.repositoryName === undefined ? "" : `${requirer.repositoryName}:`}${requirer.toString()}' is`
        : `${requirer.packageName}${requirer.version === undefined ? "" : `:${requirer.version}`} depends on ` +
          `${name}${constraint === undefined ? "" : `:${constraint}`}, which is`) +
        ` provided by the target '${name}', but '${name}' is not a package`
    );
    this.withHelp(`either build '${name}' as a package, or rename it to avoid the name collision`);
  }
}

/**
 * A repository failure attributed to the written references it traces back
 * to: the underlying error (a registry's 404, say) wrapped with the references
 * whose requirement, or whose closure's root requirement, it arose from. Their
 * provenance lets the driver point at the written requirement as well as the
 * consuming target.
 */
export class RequirementResolutionError extends FabrError {
  declare public readonly cause: Error;

  constructor(
    public readonly refs: ReadonlyArray<Reference>,
    cause: Error,
    /** Where each package built in the project that takes part was required. */
    public readonly builds: ReadonlyArray<IProvenanceStep> = [],
    /** For a reference answered by content with an origin of its own (a
     * catalog member: the catalog's entry for it), where that content came
     * from. */
    public readonly delivered: ReadonlyMap<Reference, IProvenanceStep> = new Map()
  ) {
    super(cause.message, cause);
  }
}
