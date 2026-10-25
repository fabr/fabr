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

import { IDiagnosticNote } from "../support/Log";
import type { Label } from "./Errors";

/**
 * A single step in a provenance chain: a small, inert, kind-tagged description
 * of how some content came to be part of the build, linked to the provenance
 * of whatever it was derived from. Concrete kinds are defined by whichever
 * layer produces them (model references, target evaluations, repository
 * resolutions, ...), together with a matching renderer.
 *
 * Provenance is a runtime-only annotation: it is reconstructed from the
 * project files on every run, is never serialized into the build cache (it may
 * change from run to run without affecting the cached content), and never
 * participates in manifests, cache keys, or content equality — except as a
 * file's source path ({@link sourcePathOf}), which an action's key records for
 * each of its inputs. Rendering is
 * deferred until an explanation is actually needed (typically the failure
 * path), so steps must be cheap to construct: hold references, don't compute.
 */
export interface IProvenanceStep {
  readonly kind: string;
  /** The provenance of whatever this step derived from */
  readonly parent?: IProvenanceStep;
}

/**
 * A build step's own contribution to provenance: this content was PRODUCED,
 * from a named input, by a named step.
 *
 * Generic on purpose. Every step that maps input names to output names can have
 * two inputs land on one output — `x.module.scss` and `x.css` both lowering to
 * `x.css`, `Foo.ts` and `Foo.js` both emitting `Foo.js` — and the reader's
 * question is always the same: which inputs, and what turned them into this
 * name? Without the step recorded, a conflict can only report two paths and
 * leave the production that brought them together implicit.
 *
 * `from` is named as the producing step names it, so it matches what the user
 * would edit or rename rather than wherever the file was staged.
 */
export const DERIVED_PROVENANCE = "derived";

export interface IDerivedStep extends IProvenanceStep {
  readonly kind: typeof DERIVED_PROVENANCE;
  /** The input this content was produced from. */
  readonly from: string;
  /** The step that produced it, named as a user would recognise it. */
  readonly by: string;
}

/** Make an {@link IDerivedStep} for `from`, produced by `by`. */
export function derivedFrom(from: string, by: string): IDerivedStep {
  return { kind: DERIVED_PROVENANCE, from, by };
}

/**
 * Context supplied when rendering a provenance chain.
 */
export interface IRenderContext {
  /** The file path being explained, where relevant */
  path?: string;
  /** Index of the step being rendered among those that render something (0 = nearest) */
  stepIndex?: number;
  /**
   * Constraint keys to omit from "with k=v" annotations: the caller's ambient
   * keys (the driver's injected host facts and BUILD_OPERATION), universal for
   * the run and so noise in an explanation — matching their elision from
   * progress lines.
   */
  elideConstraintKeys?: ReadonlySet<string>;
}

/**
 * Render one provenance step as structured diagnostic notes (each optionally
 * anchored at a source span).
 */
export type ProvenanceRenderer = (step: IProvenanceStep, context: IRenderContext) => IDiagnosticNote[];

const PROVENANCE_RENDERERS = new Map<string, ProvenanceRenderer>();

export function registerProvenanceRenderer(kind: string, renderer: ProvenanceRenderer): void {
  PROVENANCE_RENDERERS.set(kind, renderer);
}

/**
 * Render a full provenance chain, nearest step first, concatenating each
 * step's notes. Steps with no registered renderer contribute a placeholder; a
 * step whose renderer says nothing is not counted in `stepIndex`.
 */
export function renderProvenance(step: IProvenanceStep | undefined, context: IRenderContext = {}): IDiagnosticNote[] {
  const notes: IDiagnosticNote[] = [];
  let index = 0;
  for (let current = step; current; current = current.parent) {
    const renderer = PROVENANCE_RENDERERS.get(current.kind);
    const rendered = renderer ? renderer(current, { ...context, stepIndex: index }) : [{ message: `(${current.kind})` }];
    notes.push(...rendered);
    if (rendered.length > 0) {
      index++;
    }
  }
  return notes;
}

/**
 * Link a sequence of collected steps (ordered innermost first) onto an existing
 * chain: used when steps are accumulated as data before their parent exists
 * (e.g. while a deferred reference travels to its resolution point).
 */
export function chainSteps(steps: ReadonlyArray<IProvenanceStep>, parent: IProvenanceStep | undefined): IProvenanceStep | undefined {
  let chain = parent;
  for (const step of steps) {
    chain = { ...step, parent: chain };
  }
  return chain;
}

/**
 * Replace the last step of the chain `origin` with `root`, as where a chain
 * was made over a stand-in for content that now has an origin of its own.
 * Either is returned alone where the other is undefined.
 */
export function rootedAt(origin: IProvenanceStep | undefined, root: IProvenanceStep | undefined): IProvenanceStep | undefined {
  if (origin === undefined || root === undefined) {
    return origin ?? root;
  }
  return origin.parent === undefined ? root : { ...origin, parent: rootedAt(origin.parent, root) };
}


/**
 * What a reference whose provenance includes a step of one kind does with
 * what crosses it: a failure of what the reference names is reported as the
 * reference's, and a cycle through it is reported by the reference's label.
 */
export interface IReferenceStep {
  /** Get the error a failure of what the reference names is reported as. */
  failure(step: IProvenanceStep, err: Error): Error;
  /** Get the label a cycle through what the reference names carries. */
  label(step: IProvenanceStep): Label;
}

const REFERENCE_STEPS = new Map<string, IReferenceStep>();

export function registerReferenceStep(kind: string, handling: IReferenceStep): void {
  REFERENCE_STEPS.set(kind, handling);
}

/** Get how a reference with `step` among its provenance answers for what
 * crosses it; undefined for a step of a kind that registered nothing. */
export function referenceStep(step: IProvenanceStep): IReferenceStep | undefined {
  return REFERENCE_STEPS.get(step.kind);
}

/**
 * Produce a short identifier from one provenance step — "the name it was
 * written as" — for attributing content in one-line messages, as opposed to
 * the full multi-line rendering.
 */
export type ProvenanceDescriber = (step: IProvenanceStep) => string;

const PROVENANCE_DESCRIBERS = new Map<string, ProvenanceDescriber>();

export function registerProvenanceDescriber(kind: string, describer: ProvenanceDescriber): void {
  PROVENANCE_DESCRIBERS.set(kind, describer);
}

/**
 * @return a short description of the nearest describable step in the chain, or
 * undefined if no step has a registered describer.
 */
export function describeProvenance(step: IProvenanceStep | undefined): string | undefined {
  for (let current = step; current; current = current.parent) {
    const describer = PROVENANCE_DESCRIBERS.get(current.kind);
    if (describer) {
      return describer(current);
    }
  }
  return undefined;
}

/**
 * How one kind of step names a file's source path — the text of the fabr
 * reference that resolves to the file (`./src/a.ts`, `gen:made.ts`,
 * `@npm:react:18.2.0:index.js`) — and what those names depend on. Registered
 * together, since an action's key records the second in place of the first.
 */
export interface IProvenanceNaming {
  /**
   * Get the source path of the file named `path` within the content the step
   * explains. `below` asks the steps beneath this one (its `parent` chain) for
   * a name; a step that renames passes the name it had there, and one that
   * stands for whole content (a target's build) answers only where nothing
   * below does, so a file that passed through unchanged keeps the source path
   * it had.
   */
  sourcePath(step: IProvenanceStep, path: string, below: (path: string) => string | undefined): string | undefined;
  /**
   * Get what the step's answers depend on, besides the names asked for, as
   * text: the same text wherever the answers are the same, for every name.
   * `below` gives the steps beneath's. Empty where the step and those beneath
   * name nothing.
   */
  digest(step: IProvenanceStep, below: () => string): string;
  /**
   * Get the prefix every file's source path is formed from, `<prefix><name>`,
   * where one prefix names every file of the content the step explains;
   * undefined otherwise, and wherever the kind cannot say. `below` gives the
   * steps beneath's.
   */
  prefix?(step: IProvenanceStep, below: () => string | undefined): string | undefined;
}

const PROVENANCE_NAMINGS = new Map<string, IProvenanceNaming>();

export function registerProvenanceNaming(kind: string, naming: IProvenanceNaming): void {
  PROVENANCE_NAMINGS.set(kind, naming);
}

/**
 * Get the source path of the file named `path` within the content `step`
 * explains: what the innermost step able to name it answers, a step of a kind
 * that registered nothing passing the name through unchanged. Undefined where
 * no reference reaches the file (it was made inside a sub-target, or read from
 * outside the project).
 */
export function sourcePathOf(step: IProvenanceStep | undefined, path: string): string | undefined {
  if (step === undefined) {
    return undefined;
  }
  const naming = PROVENANCE_NAMINGS.get(step.kind);
  const below = (name: string): string | undefined => sourcePathOf(step.parent, name);
  return naming === undefined ? below(path) : naming.sourcePath(step, path, below);
}

/**
 * Get what the source paths of the content `step` explains depend on, besides
 * the files' names: equal text means every name has the same source path.
 * Empty where nothing in the chain names a file.
 */
export function sourcePathsDigestOf(step: IProvenanceStep | undefined): string {
  if (step === undefined) {
    return "";
  }
  const naming = PROVENANCE_NAMINGS.get(step.kind);
  const below = (): string => sourcePathsDigestOf(step.parent);
  return naming === undefined ? below() : naming.digest(step, below);
}

/**
 * Get the prefix every file's source path in the content `step` explains is
 * formed from, `<prefix><name>`, where one prefix names every file; undefined
 * where they are named otherwise, or some are not named at all.
 */
export function sourcePathPrefixOf(step: IProvenanceStep | undefined): string | undefined {
  if (step === undefined) {
    return undefined;
  }
  const naming = PROVENANCE_NAMINGS.get(step.kind);
  const below = (): string | undefined => sourcePathPrefixOf(step.parent);
  return naming === undefined ? below() : naming.prefix?.(step, below);
}

/**
 * Get the prefix of a step that names whole content as `<reference>:<name>`
 * where nothing beneath names a file: the reference's, where nothing beneath
 * names any, else what beneath gives.
 */
export function wholeContentPrefix(step: IProvenanceStep, reference: string, below: () => string | undefined): string | undefined {
  return sourcePathsDigestOf(step.parent) === "" ? `${reference}:` : below();
}

/**
 * Get the text of a step that renames: what each name in `names` (new name →
 * name beneath) was called, as the one prefix mapping every name follows —
 * the name beneath is `[from, to]`'s `from` plus the name less `to` — or the
 * whole table where no single mapping fits. Either way a function of the
 * names alone.
 */
export function renamingText(names: ReadonlyMap<string, string>): string {
  const mapping = prefixMappingOf(names);
  if (mapping !== undefined) {
    return JSON.stringify(mapping);
  }
  return JSON.stringify([...names].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/** Find the `[from, to]` prefixes every entry of `names` follows, from the first
 *  entry's longest common suffix; undefined where some entry does not. */
function prefixMappingOf(names: ReadonlyMap<string, string>): [string, string] | undefined {
  const first = names.entries().next();
  if (first.done) {
    return ["", ""];
  }
  const [name, was] = first.value;
  let common = 0;
  while (common < name.length && common < was.length && name[name.length - 1 - common] === was[was.length - 1 - common]) {
    common++;
  }
  const to = name.slice(0, name.length - common);
  const from = was.slice(0, was.length - common);
  for (const [other, otherWas] of names) {
    if (!other.startsWith(to) || otherWas !== from + other.slice(to.length)) {
      return undefined;
    }
  }
  return [from, to];
}

/** Make a digest naming a step's own part, `kind` and `own`, over the steps
 *  beneath's: one line each. */
export function namingDigest(kind: string, own: string, below: string): string {
  return below === "" ? `${kind} ${own}` : `${kind} ${own}\n${below}`;
}

/**
 * The step a content's provenance carries where a reference names the content
 * whole: each file's source path is `<sourcePath>:<its name>`, where nothing
 * beneath names it otherwise. A registry's package carries one, naming the
 * package as `@npm:react:18.2.0` names it.
 */
export const SOURCE_PATH_PROVENANCE = "source-path";

export interface ISourcePathStep extends IProvenanceStep {
  readonly kind: typeof SOURCE_PATH_PROVENANCE;
  /** The reference naming the content, as written. */
  readonly sourcePath: string;
}

registerProvenanceNaming(SOURCE_PATH_PROVENANCE, {
  sourcePath: (step, path, below) => below(path) ?? `${(step as ISourcePathStep).sourcePath}:${path}`,
  digest: (step, below) => namingDigest(SOURCE_PATH_PROVENANCE, JSON.stringify((step as ISourcePathStep).sourcePath), below()),
  prefix: (step, below) => wholeContentPrefix(step, (step as ISourcePathStep).sourcePath, below),
});
/* Explains nothing a diagnostic needs: the steps beneath say why the content
 * is here. */
registerProvenanceRenderer(SOURCE_PATH_PROVENANCE, () => []);

/**
 * A step recording that a set's files were renamed: each new name to the name
 * it had in the set beneath, so a name beneath is asked by the name it had
 * there.
 */
export const RENAME_PROVENANCE = "rename";

export interface IRenameStep extends IProvenanceStep {
  readonly kind: typeof RENAME_PROVENANCE;
  /** Each renamed file's name to its name beneath; a name not here is unchanged. */
  readonly from: ReadonlyMap<string, string>;
}

registerProvenanceNaming(RENAME_PROVENANCE, {
  sourcePath: (step, path, below) => below((step as IRenameStep).from.get(path) ?? path),
  digest: (step, below) => {
    const below_ = below();
    return below_ === "" ? "" : namingDigest(RENAME_PROVENANCE, renamingText((step as IRenameStep).from), below_);
  },
});
registerProvenanceRenderer(RENAME_PROVENANCE, () => []);

registerProvenanceRenderer(DERIVED_PROVENANCE, (step, context): IDiagnosticNote[] => {
  const derived = step as IDerivedStep;
  /* The mapping is the point, so it is stated whenever there IS one: a name
   * that arrived by being renamed reads as a puzzle until the rename is on the
   * page. Where the step did not rename it, saying so twice would be noise —
   * it is just an input that happens to be called that.
   *
   * Deliberately the step's own name and no verb of its own: "compiled",
   * "lowered", "copied" belong to whichever step this is, and the step is named
   * right here for a reader who wants to know which it was. */
  return [
    {
      message:
        context.path !== undefined && context.path !== derived.from
          ? `${derived.by} produced '${context.path}' from '${derived.from}'`
          : `'${derived.from}' is an input of ${derived.by}`,
    },
  ];
});

registerProvenanceDescriber(DERIVED_PROVENANCE, step => (step as IDerivedStep).from);
