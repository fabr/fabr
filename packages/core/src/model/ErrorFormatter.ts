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
  CommandFailedError,
  ConflictError,
  CycleError,
  ExecutionError,
  Label,
  helpOf,
  MultiError,
  RequirementResolutionError,
  TargetNotPackageError,
} from "../core/Errors";
import { chainSteps, IProvenanceStep, renderProvenance } from "../core/Provenance";
import { RepositoryRef } from "../core/Repository";
import type { Reference } from "../core/Reference";
import { Diagnostic, IDiagnosticDetail, IDiagnosticNote, ISourceSpan, Log } from "../support/Log";
import { declName, declPosn } from "./AST";
import { constraintText, describeUseSite, IModelStep, MODEL_PROVENANCE, substitutionNotes } from "./ModelProvenance";
import { AMBIENT_CONSTRAINT_KEYS, BUILD_OPERATION, operationOf, preferredOperation, shownConstraints } from "./Constraints";
import {
  BuildFilesInvalidError,
  CircularDependencyError,
  DependencyFailedError,
  IJudgedKey,
  IUseSite,
  NameLabel,
  NameResolutionError,
  NoRuleFoundError,
  ProvenanceLabel,
  ReferenceFailedError,
  ReferenceLabel,
} from "./Errors";
import { compareText } from "../support/Functional";

/** The diagnostic every failure is reported as, its message and detail made by describing the failure. */
const DIAG_FAILURE = Diagnostic.Error<{ message: string }>("{message}");

type IDiagnostic = { message: string } & IDiagnosticDetail;

/** Verb phrasing for "Cannot <verb> '<target>'", by operation. */
const NO_RULE_VERBS = new Map([
  ["build", "build"],
  ["test", "test"],
  ["run", "run"],
  ["files", "resolve the files of"],
]);

/**
 * A presentation of a build failure (a tree of errors) as diagnostics on a log.
 * {@link reportFailure} uses the default, {@link DiagnosticErrorFormatter}.
 */
export interface ErrorFormatter {
  report(log: Log, err: Error): void;
}

/** One "required by" hop of a trail. `inferred` where no written reference
 * of the requirer's own was crossed: the hop names the requirer alone. */
interface IHop extends IDiagnosticNote {
  inferred?: true;
}

/** One chain of "required by" hops that reached a failure, outermost first. */
interface Trail {
  notes: IHop[];
  /** The outermost requirer (the requested target this trail descends from). */
  root: string | undefined;
}

/**
 * The diagnostics of one report: one per distinct message, location and notes,
 * however many errors produced it, each with every distinct trail that reached
 * it.
 */
class PendingReport {
  private readonly pending = new Map<string, { diagnostic: IDiagnostic; trails: Trail[] }>();

  public add(diagnostic: IDiagnostic, trail: IHop[], root: string | undefined): void {
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
      /* Several paths can reach the same failure, and one is enough to explain
       * why it is in the build. Drop a trail another retraces with hops left
       * out, then keep the shortest trail per requesting root. */
      const shortestByRoot = new Map<string | undefined, IDiagnosticNote[]>();
      for (const { notes, root } of trails.filter(trail => !trails.some(other => other !== trail && retraces(other, trail)))) {
        const shortest = shortestByRoot.get(root);
        if (!shortest || notes.length < shortest.length) {
          shortestByRoot.set(root, notes);
        }
      }
      /* A trail is held outermost first; render it nearest requirer first. */
      const trailNotes = [...shortestByRoot.values()].flatMap(trail => [...trail].reverse());
      /* A trail hop can restate a note the cause already made (a cycle's own
       * "required by" hops are also the trail that reached it) — say it once. */
      const seen = new Set((diagnostic.notes ?? []).map(noteKey));
      const notes = [...(diagnostic.notes ?? []), ...trailNotes.filter(note => !seen.has(noteKey(note)))];
      log.log(DIAG_FAILURE, { ...diagnostic, notes: notes.length > 0 ? notes : undefined });
    }
  }
}

/**
 * The default presentation of a failure. Each root cause is reported once,
 * however many paths reach it, located at the written reference that led to it
 * where one is known and otherwise at the failing target's declaration. The
 * targets that required it follow as "required by <target> <property>" notes,
 * each at the reference written, keeping the shortest trail from each
 * requested target. A target's execution failures are reported together as
 * one diagnostic. A BuildFilesInvalidError reports nothing: its errors were
 * reported while the project was loaded.
 */
export class DiagnosticErrorFormatter implements ErrorFormatter {
  /** The constraint keys left out of every constraint shown (host facts,
   * BUILD_OPERATION), as progress lines leave them out. */
  constructor(private readonly ambientConstraintKeys: ReadonlySet<string> = AMBIENT_CONSTRAINT_KEYS) {}

  public report(log: Log, err: Error): void {
    /* Each error in the build files was reported while loading; this one only
     * marks the run failed. */
    if (err instanceof BuildFilesInvalidError) {
      return;
    }
    const report = new PendingReport();
    this.walk(report, err, [], undefined, undefined);
    report.flush(log);
  }

  /**
   * Walk the failure tree `err`, adding each root cause to `report` with the
   * trail that reached it. Each aggregate's errors are walked in turn; each
   * written reference crossed adds a "required by" hop to `trail`. `owner` is
   * the nearest enclosing failed target, where a cause with no location of its
   * own is reported. `root` is the outermost requirer of the trail, set at its
   * first hop.
   */
  private walk(
    report: PendingReport,
    err: Error,
    trail: IHop[],
    owner: DependencyFailedError | undefined,
    root: string | undefined
  ): void {
    if (err instanceof MultiError) {
      err.errors.forEach(cause => this.walk(report, cause, trail, owner, root));
    } else if (err instanceof CycleError) {
      this.walk(report, cycleErrorOf(err.labels), trail, owner, root);
    } else if (err instanceof ReferenceFailedError) {
      const hop = { message: `required by ${describeUseSite(err.property, err.target)}`, loc: declPosn(err.value) };
      this.walk(report, err.cause, [...trail, hop], owner, err.target ? (root ?? declName(err.target)) : root);
    } else if (err instanceof DependencyFailedError) {
      const causes = err.cause instanceof MultiError ? err.cause.errors : [err.cause];
      /* The target's execution failures are reported as one diagnostic. */
      const execution = causes.filter(cause => cause instanceof ExecutionError);
      for (const cause of causes.filter(cause => !(cause instanceof ExecutionError))) {
        /* A cause the target reached without a written reference of its own
         * gets a hop at the target's declaration: a rule resolving a target
         * directly, a global the target reached (one its rule read, or one a
         * property of its named), or a reference another declaration wrote (a
         * catalog's entry, reached by a member of the catalog). A sub-target's
         * failure is part of its declared target's and gets none. */
        const direct =
          (cause instanceof DependencyFailedError && !cause.isPart) ||
          (cause instanceof ReferenceFailedError && cause.target !== err.target);
        const hops: IHop[] = direct
          ? [...trail, { message: `required by ${declName(err.target)}`, loc: declPosn(err.target), inferred: true }]
          : trail;
        this.walk(report, cause, hops, err, direct ? (root ?? declName(err.target)) : root);
      }
      if (execution.length > 0) {
        report.add(this.describeExecution(err, execution), trail, root);
      }
    } else {
      report.add(this.describe(err, owner), trail, root);
    }
  }

  /** Describe one root cause as its final message and structured detail. */
  private describe(cause: Error, owner: DependencyFailedError | undefined): IDiagnostic {
    if (cause instanceof NoRuleFoundError) {
      return this.describeNoRule(cause);
    }
    if (cause instanceof RequirementResolutionError) {
      return this.describeRequirement(cause, owner);
    }
    if (cause instanceof CircularDependencyError) {
      return this.describeCircular(cause);
    }
    if (cause instanceof NameResolutionError) {
      const site = cause.useSite ? ` - required by ${describeUseSite(cause.useSite.property, cause.useSite.target)}` : "";
      return { message: cause.message + site, loc: cause.position, help: helpOf(cause) };
    }
    if (cause instanceof ConflictError) {
      /* Notes trace each side claiming `key` to where it was written. Where both
       * sides have one provenance (a case collision within one package), the
       * chain is rendered once, followed by both sides' details. A side's
       * `detail` is noted ("at <detail>") only where its chain is rendered. */
      const detailNote = (side: typeof cause.left): IDiagnosticNote[] =>
        side.detail !== undefined && side.provenance !== undefined ? [{ message: `at ${side.detail}` }] : [];
      const sameSource = cause.left.provenance !== undefined && cause.left.provenance === cause.right.provenance;
      /* A side with no provenance adds no note. */
      const notes = sameSource
        ? [...this.chainNotes(cause.left.provenance, undefined, cause.key), ...detailNote(cause.left), ...detailNote(cause.right)]
        : [cause.left, cause.right].flatMap(side => [...this.chainNotes(side.provenance, undefined, cause.key), ...detailNote(side)]);
      return owner
        ? {
            message: `Failed to build ${failedName(owner)}: ${cause.message}`,
            loc: declPosn(owner.target),
            notes,
            help: helpOf(cause),
          }
        : { message: cause.message, notes, help: helpOf(cause) };
    }
    if (cause instanceof TargetNotPackageError) {
      /* Where the requirement came from, and where the target was named. */
      const requirer = cause.requirer instanceof RepositoryRef ? chainSteps(cause.requirer.steps, undefined) : cause.requirer.origin;
      const notes = [...this.chainNotes(requirer), ...this.chainNotes(cause.dependency.origin)];
      return owner
        ? {
            message: `Failed to build ${failedName(owner)}: ${cause.message}`,
            loc: declPosn(owner.target),
            notes,
            help: helpOf(cause),
          }
        : { message: cause.message, notes, help: helpOf(cause) };
    }
    if (owner) {
      return { message: `Failed to build ${failedName(owner)}: ${cause.message}`, loc: declPosn(owner.target), help: helpOf(cause) };
    }
    return { message: cause.message, help: helpOf(cause) };
  }

  /**
   * Describe a dependency cycle, located at the reference that closed it, with
   * the rest of the cycle as "required by" notes. A name that resolves to
   * itself has no other hop, so its note points at the declaration the name
   * reached instead; where the reference projects from that name
   * (`js_package base { srcs = base:*.ts; }`), the help gives the `./` spelling
   * that names the path.
   */
  private describeCircular(cause: CircularDependencyError): IDiagnostic {
    const [closing, ...rest] = cause.cycle;
    if (!closing) {
      return { message: cause.message };
    }
    const written = closing.value.value.toString();
    const shadowed = written.startsWith(`${cause.name}:`);
    const reached = cause.entered;
    const notes =
      rest.length > 0
        ? rest.map(site => ({ message: `required by ${describeUseSite(site.property, site.target)}`, loc: declPosn(site.value) }))
        : reached
          ? [{ message: `'${cause.name}' is declared here`, loc: declPosn(reached) }]
          : [];
    return {
      message: cause.message,
      loc: declPosn(closing.value),
      notes,
      help:
        shadowed && rest.length === 0
          ? [`'${cause.name}' names this target, not the path '${cause.name}' — write './${written}' for the path`]
          : undefined,
    };
  }

  /** Describe a target no rule of its type applies to: located at its
   * declaration, the verb from the operation in effect, only the constraints not
   * ambient shown, with {@link noRuleHelp}'s help. */
  private describeNoRule(cause: NoRuleFoundError): IDiagnostic {
    const operation = operationOf(cause.constraints);
    const verb = NO_RULE_VERBS.get(operation) ?? `perform '${operation}' on`;
    const overrides = shownConstraints(cause.constraints, this.ambientConstraintKeys).map(([key, value]) => `${key}=${value}`);
    const suffix = overrides.length > 0 ? ` (${overrides.join(", ")})` : "";
    return {
      message: `Cannot ${verb} '${cause.target.name}': no rule matches target type '${cause.target.type}'${suffix}`,
      loc: declPosn(cause.target),
      help: noRuleHelp(cause),
    };
  }

  /**
   * Describe a requirement that failed to resolve. Where its first reference
   * was written in the failing target (or none is failing), it is located at
   * that reference, with the reference's substitutions and provenance as notes.
   * Otherwise (a reference carried in from a dependency, or none written) it is
   * located at the failing target, with every reference's provenance as notes.
   * The provenance of each build the error names is noted too.
   */
  private describeRequirement(cause: RequirementResolutionError, owner: DependencyFailedError | undefined): IDiagnostic {
    const help = helpOf(cause);
    const [first, ...rest] = cause.refs;
    const chain = first ? (cause.delivered.get(first) ?? chainSteps(first.steps, undefined)) : undefined;
    const written = chain?.kind === MODEL_PROVENANCE && (owner === undefined || (chain as IModelStep).target === owner.target);
    if (!written) {
      const anchor = owner
        ? { message: `Failed to build ${failedName(owner)}: ${cause.message}`, loc: declPosn(owner.target) }
        : { message: cause.message };
      return {
        ...anchor,
        notes: [...this.refNotes(cause.refs, cause.delivered), ...cause.builds.flatMap(origin => this.chainNotes(origin))],
        help,
      };
    }
    const head = chain as IModelStep;
    return {
      message: `${cause.message} - required by ${describeUseSite(head.property, head.target)}`,
      loc: declPosn(head.value),
      label: constraintText(head, { elideConstraintKeys: this.ambientConstraintKeys }),
      notes: [
        ...substitutionNotes(head),
        ...this.chainNotes(chain.parent),
        ...this.refNotes(rest, cause.delivered),
        ...cause.builds.flatMap(origin => this.chainNotes(origin)),
      ],
      help,
    };
  }

  /** Describe the execution failures of one target as a single diagnostic; an anonymous
   * sub-target (label set) reports with its verb ("Compiling X failed"), and a
   * target of a rule's block by its names ("Compiling jar for X failed"). */
  private describeExecution(err: DependencyFailedError, causes: Error[]): IDiagnostic {
    const detail = describeCauses(causes, declName(err.target));
    const name = failedName(err);
    const message = err.label ? `${err.label} ${name} failed:\n${detail}` : `Failed to build ${name}: ${detail}`;
    return { message, loc: declPosn(err.target) };
  }

  /** Render a provenance chain as notes; where it renders none and `label` is
   * given, a note that `label` has no origin information. */
  private chainNotes(chain: IProvenanceStep | undefined, label?: string, path?: string): IDiagnosticNote[] {
    const notes = renderProvenance(chain, { path, elideConstraintKeys: this.ambientConstraintKeys });
    if (notes.length === 0 && label !== undefined) {
      return [{ message: `from '${label}' (no origin information)` }];
    }
    return notes;
  }

  /** Render the provenance chain of each reference as notes: the chain
   * `delivered` records for what it resolved to, else the reference's own steps. */
  private refNotes(refs: ReadonlyArray<Reference>, delivered: ReadonlyMap<Reference, IProvenanceStep> = new Map()): IDiagnosticNote[] {
    return refs.flatMap(ref => this.chainNotes(delivered.get(ref) ?? chainSteps(ref.steps, undefined), ref.toString()));
  }
}

/**
 * Describe what a target with no applicable rule could have matched. Where its type has
 * rules for the operation asked of it, those rules are listed, each with what
 * it requires and (in parentheses) what this target has where that differs;
 * where it has none, the operations the type does support are the remedy.
 */
function noRuleHelp(cause: NoRuleFoundError): string[] | undefined {
  const type = cause.target.type;
  const isOperation = (key: IJudgedKey): boolean => !key.own && key.key === BUILD_OPERATION;
  const forOperation = cause.candidates.filter(keys => keys.every(key => !isOperation(key) || key.matched));
  if (forOperation.length === 0) {
    const operations = [...new Set(cause.candidates.map(keys => keys.find(isOperation)?.pattern ?? "*"))].sort();
    const preferred = preferredOperation(operations);
    const supported = operations.map(operation => `'${operation}'`).join(", ");
    return preferred ? [`'${type}' targets support ${supported} — try 'fabr ${preferred} ${cause.target.name}'`] : undefined;
  }
  const operation = cause.candidates.flat().find(isOperation)?.value ?? operationOf(cause.constraints);
  const name = (key: IJudgedKey): string => (key.own ? `target.${key.key}` : key.key);
  const rows = forOperation
    .map(keys => keys.filter(key => !isOperation(key)))
    .map(keys => ({
      requires: keys.map(key => `${name(key)} = ${key.pattern}`).join(", "),
      has: keys
        .filter(key => !key.matched)
        .map(key => (key.value === undefined ? `${name(key)} is unset` : `${name(key)} = ${key.value}`))
        .join(", "),
    }))
    .sort((a, b) => compareText(a.requires, b.requires));
  const width = Math.max(...rows.map(row => row.requires.length));
  return [`Available ${operation} rules for ${type}:\n${rows.map(row => `  ${row.requires.padEnd(width)}  (${row.has})`).join("\n")}`];
}

function spanKey(loc: ISourceSpan | undefined): string {
  return loc ? `${loc.file}:${loc.offset}:${loc.endOffset ?? ""}` : "";
}

function noteKey(note: IDiagnosticNote): string {
  return `${note.message}@${spanKey(note.loc)}`;
}

/**
 * @return true if `longer` passes every written hop of `shorter`, in order, and
 * has more written hops besides, otherwise false. `shorter` is then the same route with hops
 * left out, as when a failure reaches a target that holds the failed thing in
 * its graph without having written a reference to it.
 */
function retraces(longer: Trail, shorter: Trail): boolean {
  const written = shorter.notes.filter(hop => !hop.inferred).map(noteKey);
  if (written.length === 0 || longer.notes.filter(hop => !hop.inferred).length <= written.length) {
    return false;
  }
  let at = 0;
  for (const hop of longer.notes) {
    if (at < written.length && noteKey(hop) === written[at]) {
      at++;
    }
  }
  return at === written.length;
}

function trailKey(trail: IDiagnosticNote[]): string {
  return JSON.stringify(trail.map(noteKey));
}

/** @return the name a failure is reported under: its target's, after the names of the target of a rule's block it is and those that one is built for ("jar for shop"). */
function failedName(err: DependencyFailedError): string {
  return [...(err.subtargetNames ?? []), err.target.name].join(" for ");
}

/**
 * Format the execution errors of target `owner` as a single message: one error
 * inline, several as an indented list.
 */
function describeCauses(causes: Error[], owner: string): string {
  if (causes.length === 1) {
    return describeCause(causes[0], owner);
  }
  return `${causes.length} errors:\n` + causes.map(cause => "  " + describeCause(cause, owner).split("\n").join("\n  ")).join("\n");
}

/** Render an execution error's text — a failed command's output attributed to its
 *  target and stream (`app out| …`), exactly as the live stream shows it. */
function describeCause(cause: Error, owner: string): string {
  if (!(cause instanceof CommandFailedError)) {
    return cause.message;
  }
  const output = cause.output.map(line => `${owner} ${line.stream}| ${line.text}`);
  return [cause.commandLine, ...output, cause.outcome].join("\n");
}

const DEFAULT_FORMATTER: ErrorFormatter = new DiagnosticErrorFormatter();

/**
 * Summarize in one line why `err` happened, for a mark beside the work that
 * failed: the innermost cause's message (an execution error's last line), or
 * for a failed command how it ended; several failures by the first and a
 * count. @return undefined for an error with nothing to say.
 */
export function errorSummary(err: Error): string | undefined {
  if (err instanceof MultiError) {
    const first = err.errors.length > 0 ? errorSummary(err.errors[0]) : undefined;
    return first !== undefined && err.errors.length > 1 ? `${first} (and ${err.errors.length - 1} more)` : first;
  }
  if (err instanceof DependencyFailedError || err instanceof ReferenceFailedError || err instanceof RequirementResolutionError) {
    return errorSummary(err.cause);
  }
  const lines = err.message
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  /* A command's failure reads `$ command`, its output, then how it ended. */
  if (err instanceof CommandFailedError) {
    return err.outcome;
  }
  return err instanceof ExecutionError ? lines.at(-1) : lines[0];
}

/** Report a failed evaluation through `log`, rendered by the default
 *  {@link DiagnosticErrorFormatter}. The driver and the facade's watcher
 *  report failures through it. */
export function reportFailure(log: Log, err: Error): void {
  DEFAULT_FORMATTER.report(log, err);
}

/**
 * Read a dependency cycle from the labels on it (see {@link CycleError}) as
 * the report states it: named for the name on it that was asked for first,
 * with the written references that make it up, the closing one first, and
 * as that target's failure where the name is a target's.
 */
export function cycleErrorOf(labels: ReadonlyArray<Label>): Error {
  const names = labels.filter((label): label is NameLabel => label instanceof NameLabel);
  const entered = names.reduce<NameLabel | undefined>(
    (first, each) => (first === undefined || each.order < first.order ? each : first),
    undefined
  );
  const start = entered === undefined ? 0 : labels.indexOf(entered);
  const sites = [
    ...new Map([...labels.slice(start), ...labels.slice(0, start)].flatMap(siteOf).map(site => [site.value, site])).values(),
  ];
  const circular = new CircularDependencyError(
    entered?.name ?? sites[0]?.value.value.toString() ?? "a computation",
    sites.reverse(),
    entered?.target
  );
  return entered?.target === undefined ? circular : new DependencyFailedError(entered.target, circular);
}

/** Get the written reference a label stands for, where it stands for one. */
function siteOf(label: Label): IUseSite[] {
  if (label instanceof ReferenceLabel) {
    return [label.site];
  }
  const written =
    label instanceof ProvenanceLabel ? label.steps.find((step): step is IModelStep => step.kind === MODEL_PROVENANCE) : undefined;
  return written === undefined ? [] : [{ value: written.value, property: written.property, target: written.target }];
}
