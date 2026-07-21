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
 * The model-layer error vocabulary: typed errors that reference build-model
 * declarations (targets, properties, written values). The engine layer's own
 * errors live in core/Errors.ts. Errors carry data; presentation is
 * exclusively the driver's job.
 */

import { INameValue, IPropertyDecl, ITargetDecl } from "./AST";
import { Name } from "../core/Name";
import { ISourceSpan } from "../support/Log";
import type { Constraints } from "./BuildContext";

/**
 * Failure of a target, as propagated to its dependants: carries the failed
 * target's declaration and the underlying cause, so that whoever ultimately
 * reports the failure (the driver) can attribute each cause to its target
 * exactly once and render dependants' failures tersely.
 */
export class DependencyFailedError extends Error {
  public readonly target: ITargetDecl;
  public readonly cause: Error;
  /**
   * Set when the failure is an anonymous sub-target's build step: the action
   * verb (e.g. "Compiling"). `target` is then the *declared* target it
   * belongs to, so the driver renders "Compiling X failed" against it and
   * collapses the intermediate hop.
   */
  public readonly label?: string;

  constructor(target: ITargetDecl, cause: Error, label?: string) {
    super(`dependency '${target.name}' failed`);
    this.target = target;
    this.cause = cause;
    this.label = label;
  }
}

/**
 * The build files contained one or more errors (a parse error, or a
 * sema/validation failure such as an unknown target type, an unexpected or
 * missing property, or a naming conflict). Loading reports each such error as
 * its own positioned diagnostic and then rejects with this to *stop* the run:
 * the model is not sound, so no operation should proceed against it. Carries
 * only the count — the individual errors are already on the log, so the driver
 * renders nothing further for this (it just fails the run). In watch mode the
 * rejection leaves the previous model resident: the reload's new (broken) model
 * never supersedes it.
 */
export class BuildFilesInvalidError extends Error {
  constructor(public readonly errorCount: number) {
    super(`build files contain ${errorCount} error${errorCount === 1 ? "" : "s"}`);
  }
}

/** A use site of a target: the written value, its property, its owning target. */
export interface IUseSite {
  value: INameValue;
  property: IPropertyDecl;
  target?: ITargetDecl;
}

/**
 * A written name that failed to resolve, positioned at the name itself (its own
 * source span) so the report underlines it, not just the enclosing target. The
 * default case is a literal (wildcard-free) name in a FILES property that named
 * no target and matched no file — there is no reading under which the user meant
 * "nothing", so it is an error rather than a silently-empty resolution (a glob
 * matching nothing stays lenient). A caller with a *specific* reason — a `sync`
 * coordinate that names no repository, names no publish target, or carries a bad
 * version — passes it as `reason` for the message.
 */
export class NameResolutionError extends Error {
  public readonly position: ISourceSpan;
  /** Where the name was written (property + owning target), when known */
  public readonly useSite?: IUseSite;

  constructor(name: Name, position: ISourceSpan, useSite?: IUseSite, reason?: string) {
    super(reason ?? `Unable to resolve '${name.toString()}'`);
    this.position = position;
    this.useSite = useSite;
  }
}

/**
 * No rule matched a target's type under the constraints in effect. Carries
 * the data — the declaration and the full constraint set — and leaves
 * presentation to the driver (notably, which constraints are worth showing:
 * explicit overrides, not the run's ambient facts). The demand chain is not
 * carried here: like a failed build, this error is wrapped per written
 * reference it crosses (ReferenceFailedError), which attributes each actual
 * demand path rather than the first demander's.
 */
export class NoRuleFoundError extends Error {
  constructor(
    public readonly target: ITargetDecl,
    public readonly constraints: Constraints
  ) {
    super(`No rule matches target '${target.name}' of type '${target.type}'`);
  }
}

/**
 * A referenced target's failure crossing the property value that referenced
 * it: records the use site — the written value, its property, and the owning
 * target — so the driver can render the dependant chain as
 * "required by <target> <property>" notes underlining each written reference.
 * Wraps only failures OF the referenced target (it failed to build, or no
 * rule matched it) — an error intrinsic to the current resolution carries its
 * own attribution and passes through unwrapped.
 */
export class ReferenceFailedError extends Error {
  constructor(
    public readonly value: INameValue,
    public readonly property: IPropertyDecl,
    public readonly target: ITargetDecl | undefined,
    public readonly cause: DependencyFailedError | NoRuleFoundError
  ) {
    super(cause.message);
  }
}
