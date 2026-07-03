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

import { IFile } from "./FileSet";

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
}

/**
 * Render one provenance step into human-readable lines.
 */
export type ProvenanceRenderer = (step: IProvenanceStep, context: IRenderContext) => string[];

const PROVENANCE_RENDERERS = new Map<string, ProvenanceRenderer>();

export function registerProvenanceRenderer(kind: string, renderer: ProvenanceRenderer): void {
  PROVENANCE_RENDERERS.set(kind, renderer);
}

/**
 * Render a full provenance chain, nearest step first, concatenating each
 * step's lines. Steps with no registered renderer contribute a placeholder.
 */
export function renderProvenance(step: IProvenanceStep | undefined, context: IRenderContext = {}): string[] {
  const lines: string[] = [];
  let index = 0;
  for (let current = step; current; current = current.parent) {
    const renderer = PROVENANCE_RENDERERS.get(current.kind);
    lines.push(...(renderer ? renderer(current, { ...context, stepIndex: index }) : [`(${current.kind})`]));
    index++;
  }
  return lines;
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
 * One side of a file conflict: the file, and the provenance chain of the
 * fileset it arrived in.
 */
export interface IConflictSource {
  file: IFile;
  provenance?: IProvenanceStep;
}

/** A conflict side as reported: the label is derived from the provenance */
export interface IConflictSide extends IConflictSource {
  label: string;
}

export class FileConflictError extends Error {
  public readonly path: string;
  public readonly left: IConflictSide;
  public readonly right: IConflictSide;

  constructor(path: string, left: IConflictSource, right: IConflictSource) {
    const leftSide = describeSide(left);
    const rightSide = describeSide(right);
    super(
      leftSide.label === rightSide.label
        ? `Conflicting files for ${path} (within '${leftSide.label}')`
        : `Conflicting files for ${path} (from '${leftSide.label}' and '${rightSide.label}')`
    );
    this.path = path;
    this.left = leftSide;
    this.right = rightSide;
  }
}

function describeSide(source: IConflictSource): IConflictSide {
  return { ...source, label: describeProvenance(source.provenance) ?? source.file.getDisplayName() };
}
