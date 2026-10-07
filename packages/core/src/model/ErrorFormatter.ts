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

import { CommandFailedError, ConflictError, ExecutionError, helpOf, MultiError, RequirementResolutionError, TestsFailedError } from "../core/Errors";
import { chainSteps, IProvenanceStep, renderProvenance } from "../core/Provenance";
import { RepositoryRef } from "../core/Repository";
import { Diagnostic, IDiagnosticDetail, IDiagnosticNote, ISourceSpan, Log } from "../support/Log";
import { declName, declPosn } from "./AST";
import { constraintText, describeUseSite, IModelRefStep, MODEL_REF_PROVENANCE, substitutionNotes } from "./BuildContext";
import { AMBIENT_CONSTRAINT_KEYS, BUILD_OPERATION, preferredOperation, shownConstraints } from "./Constraints";
import {
  BuildFilesInvalidError,
  CircularDependencyError,
  DependencyFailedError,
  IJudgedKey,
  NameResolutionError,
  NoRuleFoundError,
  ReferenceFailedError,
} from "./Errors";
import { compareText } from "../support/Functional";

/** All failures render through one template: describe() produces the final
 * message, and the structured detail (span, label, notes, help) rides along. */
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
      /* A trail hop can restate a note the cause already made (a cycle's own
       * "required by" hops are also the trail that reached it) — say it once. */
      const seen = new Set((diagnostic.notes ?? []).map(noteKey));
      const notes = [...(diagnostic.notes ?? []), ...trailNotes.filter(note => !seen.has(noteKey(note)))];
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
  constructor(private readonly ambientConstraintKeys: ReadonlySet<string> = AMBIENT_CONSTRAINT_KEYS) {}

  public report(log: Log, err: Error): void {
    /* The build files were invalid: each error was already reported as its own
     * positioned diagnostic while loading, and this error only marks the run as
     * failed. Nothing to render — the driver's "Build failed" line follows. */
    if (err instanceof BuildFilesInvalidError) {
      return;
    }
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
      this.walk(report, err.cause, [...trail, hop], owner, err.target ? (root ?? declName(err.target)) : root);
    } else if (err instanceof DependencyFailedError) {
      const causes = err.cause instanceof MultiError ? err.cause.errors : [err.cause];
      /* Mechanical failures of the target's execution report as one group */
      const execution = causes.filter(cause => cause instanceof ExecutionError);
      for (const cause of causes.filter(cause => !(cause instanceof ExecutionError))) {
        /* A dependency reached without a written reference of the target's own
         * gets a hop against the requiring declaration: a rule resolving a
         * target directly, or the target reaching it through a GLOBAL — one its
         * rule read, or one a property of its named — where the reference
         * crossed is the global's own value and says nothing of who wanted it.
         * An anonymous sub-target (label set) is part of its declared target. */
        const direct =
          (cause instanceof DependencyFailedError && !cause.label) || (cause instanceof ReferenceFailedError && cause.target === undefined);
        const hops = direct ? [...trail, { message: `required by ${declName(err.target)}`, loc: declPosn(err.target) }] : trail;
        this.walk(report, cause, hops, err, direct ? (root ?? declName(err.target)) : root);
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
    if (cause instanceof CircularDependencyError) {
      return this.describeCircular(cause);
    }
    if (cause instanceof NameResolutionError) {
      const site = cause.useSite ? ` - required by ${describeUseSite(cause.useSite.property, cause.useSite.target)}` : "";
      return { message: cause.message + site, loc: cause.position, help: helpOf(cause) };
    }
    if (cause instanceof ConflictError) {
      /* Both contributors that claim `key`, each traced to where it was written;
       * the concrete detail keeps identical-provenance conflicts diagnosable.
       * The two sides render whether or not the conflict arose inside a target
       * build (an ownerless one has no enclosing DependencyFailedError). */
      /* When both sides trace to the same source (a case-collision within one
       * package — both names have the same origin, keyed on the same path), the
       * two chains are identical: render it once and list both files, rather than
       * repeating the whole breadcrumb per side. */
      /* Only where a chain was rendered: the note places the file WITHIN that
       * chain, and with no chain to place it in it just restates what the
       * message already said. */
      const detailNote = (side: typeof cause.left): IDiagnosticNote[] =>
        side.detail !== undefined && side.provenance !== undefined ? [{ message: `at ${side.detail}` }] : [];
      const sameSource = cause.left.provenance !== undefined && cause.left.provenance === cause.right.provenance;
      /* No label passed, so a side with no provenance contributes no note at
       * all (the message already names both sides). */
      const notes = sameSource
        ? [...this.chainNotes(cause.left.provenance, undefined, cause.key), ...detailNote(cause.left), ...detailNote(cause.right)]
        : [cause.left, cause.right].flatMap(side => [...this.chainNotes(side.provenance, undefined, cause.key), ...detailNote(side)]);
      return owner
        ? { message: `Failed to build ${owner.target.name}: ${cause.message}`, loc: declPosn(owner.target), notes, help: helpOf(cause) }
        : { message: cause.message, notes, help: helpOf(cause) };
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

  /**
   * A name that resolves to itself: anchored at the reference that closed the
   * cycle — the mistake — with the rest of the loop following as the usual
   * "required by" notes. A self-reference has no such hop, so it instead points
   * at the declaration the name reached: the evidence that it resolved to a
   * target, which the like-named path it reads as would not be (and which need
   * not be anywhere near the reference). A projection makes that name shadowing
   * (`js_package base { srcs = base:*.ts; }`), so it also gets the `./` spelling
   * that reaches the path as help.
   */
  private describeCircular(cause: CircularDependencyError): IDiagnostic {
    const [closing, ...rest] = cause.cycle;
    if (!closing) {
      return { message: cause.message };
    }
    const written = closing.value.value.toString();
    const shadowed = written !== cause.name;
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
      help: shadowed && rest.length === 0 ? [`'${cause.name}' names this target, not the path '${cause.name}' — write './${written}' for the path`] : undefined,
    };
  }

  /** No rule matched the target's type: anchored at the declaration, the verb
   * from the operation in effect, only the override constraints shown. What the
   * type *does* support is the remedy, named as the command that would do it. */
  private describeNoRule(cause: NoRuleFoundError): IDiagnostic {
    const operation = cause.constraints.get(BUILD_OPERATION) ?? "build";
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
   * A requirement that failed to resolve, anchored at the reference behind it
   * when that reference was written in the failing target itself; otherwise —
   * a reference carried in from a dependency, or none written at all — at the
   * failing target, with every culprit reference as a note saying where it was
   * written.
   */
  private describeRequirement(cause: RequirementResolutionError, owner: DependencyFailedError | undefined): IDiagnostic {
    const help = helpOf(cause);
    const [first, ...rest] = cause.refs;
    const chain = first ? chainSteps(first.steps, undefined) : undefined;
    const written = chain?.kind === MODEL_REF_PROVENANCE && (owner === undefined || (chain as IModelRefStep).target === owner.target);
    if (!written) {
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
      notes: [...substitutionNotes(head), ...this.chainNotes(chain.parent), ...this.refNotes(rest)],
      help,
    };
  }

  /** Execution failures of one target, as a single diagnostic; an anonymous
   * sub-target (label set) reports with its verb ("Compiling X failed"). */
  private describeExecution(err: DependencyFailedError, causes: Error[]): IDiagnostic {
    const detail = describeCauses(causes, declName(err.target));
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
    return refs.flatMap(ref => this.chainNotes(chainSteps(ref.steps, undefined), ref.toString()));
  }
}

/**
 * What a target with no applicable rule could have matched. Where its type has
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
  const operation = cause.candidates.flat().find(isOperation)?.value ?? cause.constraints.get(BUILD_OPERATION) ?? "build";
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

function trailKey(trail: IDiagnosticNote[]): string {
  return JSON.stringify(trail.map(noteKey));
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

/** An execution error's text — a failed command's output attributed to its
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
 * One line saying why `err` happened, for a mark beside the work that failed
 * (the failure report stays the full account): the innermost cause's message,
 * or for a failed command its exit status; several failures by the first and a
 * count. Undefined for an error with nothing to say.
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
 *  {@link DiagnosticErrorFormatter} — the one error-reporting path, shared by
 *  the driver's catch sites and the facade's watch channel. */
export function reportFailure(log: Log, err: Error): void {
  DEFAULT_FORMATTER.report(log, err);
}
