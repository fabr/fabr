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
 * participates in manifests, cache keys, or content equality. Rendering is
 * deferred until an explanation is actually needed (typically the failure
 * path), so steps must be cheap to construct: hold references, don't compute.
 */
export interface IProvenanceStep {
  readonly kind: string;
  /** The provenance of whatever this step derived from */
  readonly parent?: IProvenanceStep;
}

/**
 * Context supplied when rendering a provenance chain.
 */
export interface IRenderContext {
  /** The file path being explained, where relevant */
  path?: string;
  /** Index of the step being rendered within its chain (0 = nearest) */
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
 * step's notes. Steps with no registered renderer contribute a placeholder.
 */
export function renderProvenance(step: IProvenanceStep | undefined, context: IRenderContext = {}): IDiagnosticNote[] {
  const notes: IDiagnosticNote[] = [];
  let index = 0;
  for (let current = step; current; current = current.parent) {
    const renderer = PROVENANCE_RENDERERS.get(current.kind);
    notes.push(...(renderer ? renderer(current, { ...context, stepIndex: index }) : [{ message: `(${current.kind})` }]));
    index++;
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
 * Locate one named file's origin in the USER'S SOURCE TREE: given the step and
 * the file's path within the content that step explains, the absolute path the
 * file was read from — or undefined if this step can't say (content fabr
 * produced, or a step that doesn't track locations).
 *
 * The third dispatch on a chain, alongside rendering and describing, and asked
 * of provenance for the same reason: "where did this come from" is precisely
 * what a chain records, it is runtime-only ghost data, and a step that
 * *rearranges* files (a union, a mount) already knows how to rebase a path onto
 * its contributor — so the walk composes through assembly for free.
 */
export type ProvenanceLocator = (step: IProvenanceStep, path: string) => string | undefined;

const PROVENANCE_LOCATORS = new Map<string, ProvenanceLocator>();

export function registerProvenanceLocator(kind: string, locator: ProvenanceLocator): void {
  PROVENANCE_LOCATORS.set(kind, locator);
}

/**
 * Walk a chain for the source-tree path of the file named `path` within the
 * content it explains: the nearest step that can say wins, and a step that
 * can't is transparent (the walk continues to its parent, since a step that
 * merely annotates — a model reference, a target evaluation — doesn't move
 * files). A locator that rebases (see FileSet's merge provenance) recurses on
 * its own; only a step that genuinely repositions content needs to.
 *
 * @return the absolute source path, or undefined if nothing in the chain
 * sources the file from the user's tree (it was built, generated or fetched).
 */
export function locateSource(step: IProvenanceStep | undefined, path: string): string | undefined {
  for (let current = step; current; current = current.parent) {
    const located = PROVENANCE_LOCATORS.get(current.kind)?.(current, path);
    if (located !== undefined) {
      return located;
    }
  }
  return undefined;
}

