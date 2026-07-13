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

import {
  BUILD_OPERATION,
  chainSteps,
  constraintText,
  declPosn,
  DependencyFailedError,
  describeUseSite,
  Diagnostic,
  ExecutionError,
  ConflictError,
  IDiagnosticDetail,
  IDiagnosticNote,
  IModelRefStep,
  IProvenanceStep,
  ISourceSpan,
  Log,
  MODEL_REF_PROVENANCE,
  MultiError,
  NameResolutionError,
  NoRuleFoundError,
  ReferenceFailedError,
  renderProvenance,
  RepositoryRef,
  RequirementResolutionError,
  TestsFailedError,
} from "@fabr/core";

/** All failures render through one template: describe() produces the final
 * message, and the structured detail (span, label, notes, help) rides along. */
const DIAG_FAILURE = Diagnostic.Error<{ message: string }>("{message}");

type IDiagnostic = { message: string } & IDiagnosticDetail;

/** Verb phrasing for "Cannot <verb> '<target>'", by operation. */
const NO_RULE_VERBS: Record<string, string> = { build: "build", test: "test", run: "run", files: "resolve the files of" };

/**
 * Converts a build failure (tree) into human-readable diagnostics on the log:
 * owns every detail of how an error report reads. Swappable — the driver
 * holds one; an alternative presentation (JSON, IDE integration) implements
 * the same interface.
 */
export interface ErrorFormatter {
  report(log: Log, err: Error): void;
}

/**
 * The diagnostics of one report, deduplicated by rendered content: the same
 * root cause can surface as distinct error instances from several collection
 * points, and can be reached through several dependant chains — it gets one
 * diagnostic carrying every distinct requirer trail, not one copy per path.
 */
interface Trail {
  notes: IDiagnosticNote[];
  /** The outermost requirer (the requested target this trail descends from). */
  root: string | undefined;
}

class PendingReport {
  private readonly pending = new Map<string, { diagnostic: IDiagnostic; trails: Trail[] }>();

  public add(diagnostic: IDiagnostic, trail: IDiagnosticNote[], root: string | undefined): void {
    const key = JSON.stringify([diagnostic.message, spanKey(diagnostic.loc), (diagnostic.notes ?? []).map(noteKey)]);
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { diagnostic, trails: [] };
      this.pending.set(key, entry);
    }
    if (trail.length > 0 && !entry.trails.some(existing => trailKey(existing.notes) === trailKey(trail))) {
      entry.trails.push({ notes: trail, root });
    }
  }

  public flush(log: Log): void {
    for (const { diagnostic, trails } of this.pending.values()) {
      /* Several paths can reach the same failure; one is enough to explain why
       * it's in the build, so keep just the shortest trail per requesting root —
       * an alternate longer route to a root already shown is noise. */
      const shortestByRoot = new Map<string | undefined, IDiagnosticNote[]>();
      for (const { notes, root } of trails) {
        const shortest = shortestByRoot.get(root);
        if (!shortest || notes.length < shortest.length) {
          shortestByRoot.set(root, notes);
        }
      }
      /* Trails accumulate outermost-first during descent; the report reads
       * outward from the failure, so each renders nearest dependant first */
      const trailNotes = [...shortestByRoot.values()].flatMap(trail => [...trail].reverse());
      const notes = [...(diagnostic.notes ?? []), ...trailNotes];
      log.log(DIAG_FAILURE, { ...diagnostic, notes: notes.length > 0 ? notes : undefined });
    }
  }
}

/**
 * The default presentation: each root cause is reported once, anchored at the
 * written reference that induced it where one is known (falling back to the
 * failing target's declaration), with the chain of dependants that required
 * it rendered as "required by <target> <property>" notes underlining each
 * written reference.
 */
export class DiagnosticErrorFormatter implements ErrorFormatter {
  /** Ambient constraint keys (host facts, BUILD_OPERATION), elided from every
   * constraint display exactly as progress lines elide them. */
  constructor(private readonly ambientConstraintKeys: ReadonlySet<string>) {}

  public report(log: Log, err: Error): void {
    const report = new PendingReport();
    this.walk(report, err, [], undefined, undefined);
    report.flush(log);
  }

  /**
   * Traverse the failure tree: fan out aggregates, turn each written-reference
   * crossing into a "required by" hop on the trail, descend through dependant
   * failures (`owner` is the nearest enclosing failed target, the anchor for
   * causes that carry no position of their own), and describe each root cause.
   * `root` names the outermost requirer (the requested target the current trail
   * descends from), captured at the first hop — the report keeps one trail per
   * root, so alternate longer paths to an already-shown root are dropped.
   */
  private walk(
    report: PendingReport,
    err: Error,
    trail: IDiagnosticNote[],
    owner: DependencyFailedError | undefined,
    root: string | undefined
  ): void {
    if (err instanceof MultiError) {
      err.errors.forEach(cause => this.walk(report, cause, trail, owner, root));
    } else if (err instanceof ReferenceFailedError) {
      const hop = { message: `required by ${describeUseSite(err.property, err.target)}`, loc: declPosn(err.value) };
      this.walk(report, err.cause, [...trail, hop], owner, root ?? err.target?.name);
    } else if (err instanceof DependencyFailedError) {
      const causes = err.cause instanceof MultiError ? err.cause.errors : [err.cause];
      /* Mechanical failures of the target's execution report as one group */
      const execution = causes.filter(cause => cause instanceof ExecutionError);
      for (const cause of causes.filter(cause => !(cause instanceof ExecutionError))) {
        /* A dependency reached without a written reference (a rule resolving
         * a target directly) gets a hop against the requiring declaration; an
         * anonymous sub-target (label set) is part of its declared target. */
        const direct = cause instanceof DependencyFailedError && !cause.label;
        const hops = direct ? [...trail, { message: `required by ${err.target.name}`, loc: declPosn(err.target) }] : trail;
        this.walk(report, cause, hops, err, direct ? root ?? err.target.name : root);
      }
      if (execution.length > 0) {
        report.add(this.describeExecution(err, execution), trail, root);
      }
    } else {
      report.add(this.describe(err, owner), trail, root);
    }
  }

  /** One root cause → its final message and structured detail. */
  private describe(cause: Error, owner: DependencyFailedError | undefined): IDiagnostic {
    if (cause instanceof NoRuleFoundError) {
      return this.describeNoRule(cause);
    }
    if (cause instanceof RequirementResolutionError) {
      return this.describeRequirement(cause, owner);
    }
    if (cause instanceof NameResolutionError) {
      const site = cause.useSite ? ` - required by ${describeUseSite(cause.useSite.property, cause.useSite.target)}` : "";
      return { message: cause.message + site, loc: cause.position, help: helpOf(cause) };
    }
    if (owner && cause instanceof ConflictError) {
      /* Both contributors that claim `key`, each traced to where it was written;
       * the concrete detail keeps identical-provenance conflicts diagnosable. */
      const notes = [cause.left, cause.right].flatMap(side => [
        ...this.chainNotes(side.provenance, side.label, cause.key),
        ...(side.detail ? [{ message: `at ${side.detail}` }] : []),
      ]);
      return { message: `Failed to build ${owner.target.name}: ${cause.message}`, loc: declPosn(owner.target), notes };
    }
    if (owner && cause instanceof TestsFailedError) {
      /* Tests failed: the target built fine, so report the (pre-rendered)
       * test summary rather than a build failure */
      return { message: `${owner.target.name}: ${cause.message}`, loc: declPosn(owner.target) };
    }
    if (owner) {
      return { message: `Failed to build ${owner.target.name}: ${cause.message}`, loc: declPosn(owner.target), help: helpOf(cause) };
    }
    return { message: cause.message, help: helpOf(cause) };
  }

  /** No rule matched the target's type: anchored at the declaration, the verb
   * from the operation in effect, only the override constraints shown. */
  private describeNoRule(cause: NoRuleFoundError): IDiagnostic {
    const operation = cause.constraints[BUILD_OPERATION] ?? "build";
    const verb = NO_RULE_VERBS[operation] ?? `perform '${operation}' on`;
    const overrides = Object.entries(cause.constraints)
      .filter(([key]) => !this.ambientConstraintKeys.has(key))
      .map(([key, value]) => `${key}=${value}`);
    const suffix = overrides.length > 0 ? ` (${overrides.join(", ")})` : "";
    return {
      message: `Cannot ${verb} '${cause.target.name}': no rule matches target type '${cause.target.type}'${suffix}`,
      loc: declPosn(cause.target),
    };
  }

  /**
   * A repository failure attributed to written reference(s): anchored at the
   * first culpable reference's own use site (underlining the written
   * requirement, the use site on the headline, any constraint delta as the
   * underline's label); deeper provenance hops and further culpable
   * references follow as notes. Without a written use site (a CLI name), it
   * anchors like any other cause.
   */
  private describeRequirement(cause: RequirementResolutionError, owner: DependencyFailedError | undefined): IDiagnostic {
    const help = helpOf(cause) ?? helpOf(cause.cause);
    const [first, ...rest] = cause.refs;
    const chain = first ? chainSteps(first.steps, undefined) : undefined;
    if (chain?.kind !== MODEL_REF_PROVENANCE) {
      const anchor = owner
        ? { message: `Failed to build ${owner.target.name}: ${cause.message}`, loc: declPosn(owner.target) }
        : { message: cause.message };
      return { ...anchor, notes: this.refNotes(cause.refs), help };
    }
    const head = chain as IModelRefStep;
    return {
      message: `${cause.message} - required by ${describeUseSite(head.property, head.target)}`,
      loc: declPosn(head.value),
      label: constraintText(head, { elideConstraintKeys: this.ambientConstraintKeys }),
      notes: [...this.chainNotes(chain.parent), ...this.refNotes(rest)],
      help,
    };
  }

  /** Execution failures of one target, as a single diagnostic; an anonymous
   * sub-target (label set) reports with its verb ("Compiling X failed"). */
  private describeExecution(err: DependencyFailedError, causes: Error[]): IDiagnostic {
    const detail = describeCauses(causes);
    const message = err.label
      ? `${err.label} ${err.target.name} failed:\n${detail}`
      : `Failed to build ${err.target.name}: ${detail}`;
    return { message, loc: declPosn(err.target) };
  }

  /** A provenance chain as notes, or a no-origin fallback line. */
  private chainNotes(chain: IProvenanceStep | undefined, label?: string, path?: string): IDiagnosticNote[] {
    const notes = renderProvenance(chain, { path, elideConstraintKeys: this.ambientConstraintKeys });
    if (notes.length === 0 && label !== undefined) {
      return [{ message: `from '${label}' (no origin information)` }];
    }
    return notes;
  }

  /** Full provenance chains of culpable references, as notes. */
  private refNotes(refs: ReadonlyArray<RepositoryRef>): IDiagnosticNote[] {
    return refs.flatMap(ref => this.chainNotes(chainSteps(ref.steps, undefined), ref.name.toString()));
  }
}

function helpOf(err: Error): string[] | undefined {
  const help = (err as { help?: string }).help;
  return help ? [help] : undefined;
}

function spanKey(loc: ISourceSpan | undefined): string {
  return loc ? `${loc.file}:${loc.offset}:${loc.endOffset ?? ""}` : "";
}

function noteKey(note: IDiagnosticNote): string {
  return `${note.message}@${spanKey(note.loc)}`;
}

function trailKey(trail: IDiagnosticNote[]): string {
  return JSON.stringify(trail.map(noteKey));
}

/**
 * Format the execution errors of a target as a single message: one error
 * inline, several as an indented list.
 */
function describeCauses(causes: Error[]): string {
  if (causes.length === 1) {
    return causes[0].message;
  }
  return `${causes.length} errors:\n` + causes.map(cause => "  " + cause.message.split("\n").join("\n  ")).join("\n");
}
