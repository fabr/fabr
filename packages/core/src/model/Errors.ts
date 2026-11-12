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
 * The model layer's errors: typed errors naming declarations (targets,
 * properties, written values), and the labels a cycle error is made from. They
 * carry data; the driver renders them.
 */

import { INameValue, IPropertyDecl, ITargetDecl } from "./AST";
import { FabrError, Label } from "../core/Errors";
import { describeProvenance, IProvenanceStep } from "../core/Provenance";
import { Name } from "../core/Name";
import { ISourceSpan } from "../support/Log";
import type { Constraints } from "./Constraints";

/**
 * The failure of a target, as its dependants see it: the failed target's
 * declaration and the underlying `cause`. The failure report shows each cause
 * once, against its target.
 */
export class DependencyFailedError extends FabrError {
  public readonly target: ITargetDecl;
  declare public readonly cause: Error;
  /** For a failed labelled sub-target, its participle ("Compiling");
   *  `target` is then the declared target it belongs to. */
  public readonly label?: string;
  /** For a failed target of a rule's block, or one made for it, its names,
   *  as {@link ITargetBuildTask.subtargetNames}. */
  public readonly subtargetNames?: readonly string[];

  constructor(target: ITargetDecl, cause: Error, label?: string, subtargetNames?: readonly string[]) {
    super(`dependency '${target.name}' failed`, cause);
    this.target = target;
    this.label = label;
    this.subtargetNames = subtargetNames;
  }

  /** @return true if the failure is a part of `target` rather than the target itself, otherwise false. */
  public get isPart(): boolean {
    return this.label !== undefined || (this.subtargetNames?.length ?? 0) > 0;
  }
}

/**
 * The error loading fails with where the build files held errors (a parse
 * error, an unknown target type, an unexpected or missing property, a naming
 * conflict). Each error has already been reported as its own diagnostic, so
 * this carries only their count and the failure report shows nothing for it.
 */
export class BuildFilesInvalidError extends FabrError {
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

/** The next {@link NameLabel.order}. */
let nextOrder = 0;

/** The label of a node computing what a name stands for: a target's or a
 * global's value in one configuration, or a target's build. */
export class NameLabel implements Label {
  /** Where this stands among the names asked for, earliest lowest. */
  public readonly order = nextOrder++;

  constructor(
    public readonly name: string,
    public readonly target?: ITargetDecl
  ) {}
}

/** The label of a node computing what one written reference names. */
export class ReferenceLabel implements Label {
  public readonly name: string;

  constructor(public readonly site: IUseSite) {
    this.name = site.value.value.toString();
  }
}

/**
 * The label of a node computing what a reference delivers, by the reference's
 * provenance steps; the step saying where it was written is among them.
 */
export class ProvenanceLabel implements Label {
  public readonly name: string;

  constructor(public readonly steps: ReadonlyArray<IProvenanceStep>) {
    this.name = steps.map(step => describeProvenance(step)).find(described => described !== undefined) ?? "a reference";
  }
}

/**
 * A name that depends, directly or through other names, on itself. `cycle` is
 * the written references making the cycle, the one that closed it first; a
 * self-reference (`js_package base { srcs = base:*.ts; }`, where `base` names
 * the target being declared) has one. The report is positioned at the
 * references.
 */
export class CircularDependencyError extends FabrError {
  constructor(
    public readonly name: string,
    public readonly cycle: ReadonlyArray<IUseSite>,
    /** The declaration the cycle re-entered, where `name` is a target's (a
     * property's cycle re-enters no target). */
    public readonly entered: ITargetDecl | undefined
  ) {
    super(`Circular dependency: '${name}' depends on itself`);
  }
}

/**
 * A written name that failed to resolve, positioned at the name itself: by
 * default a literal (wildcard-free) name that named no target and matched no
 * file. A caller with a specific reason (a `sync` coordinate naming no repository or publish target,
 * or carrying a bad version) passes it as `reason`.
 */
export class NameResolutionError extends FabrError {
  public readonly position: ISourceSpan;
  /** Where the name was written (property and owning target), when known. */
  public readonly useSite?: IUseSite;

  constructor(name: Name, position: ISourceSpan, useSite?: IUseSite, reason?: string) {
    super(reason ?? `Unable to resolve '${name.toString()}'`);
    this.position = position;
    this.useSite = useSite;
  }
}

/**
 * No rule of a target's type applies under the constraints in effect.
 * Carries the declaration and the whole constraint set. Like a failed build,
 * it is wrapped in a ReferenceFailedError per written reference it crosses.
 *
 * `candidates` are the type's own rules, none of which applied, each as the
 * keys of its guards were judged for this target; empty for a type with no
 * rule of its own.
 */
export class NoRuleFoundError extends FabrError {
  constructor(
    public readonly target: ITargetDecl,
    public readonly constraints: Constraints,
    public readonly candidates: ReadonlyArray<readonly IJudgedKey[]> = []
  ) {
    super(`No rule matches target '${target.name}' of type '${target.type}'`);
  }
}

/** One key of a rule's guard, as it was judged for a target. */
export interface IJudgedKey {
  /** The property the key names: the target's own where `own`, else the
   *  configuration's. */
  key: string;
  own: boolean;
  /** The pattern the rule requires of it. */
  pattern: string;
  /** What it read as, or undefined where it has no value. */
  value: string | undefined;
  matched: boolean;
}

/**
 * A referenced target's failure, wrapped where it crosses the written value
 * that referenced it: the value, its property and the owning target, which the
 * failure report shows as a "required by" note. Wraps only a failure of the
 * referenced target itself (it failed to build, or no rule applies); any other
 * error passes through unwrapped.
 */
export class ReferenceFailedError extends FabrError {
  declare public readonly cause: DependencyFailedError | NoRuleFoundError;

  constructor(
    public readonly value: INameValue,
    public readonly property: IPropertyDecl,
    public readonly target: ITargetDecl | undefined,
    cause: DependencyFailedError | NoRuleFoundError
  ) {
    super(cause.message, cause);
  }
}
