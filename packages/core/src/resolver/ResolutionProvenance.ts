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

import { IProvenanceStep, registerProvenanceRenderer } from "../core/Provenance";
import { resolutionExplainer } from "./MVSResolution";
import type { PackageFormat } from "./PackageFormat";
import { Requirement, ROOT_REQUIRER, Selected } from "./Types";

/** Render a root requirement as it was written: the package, and the version
 * it states. */
function written(root: Requirement): string {
  return root.versionConstraint === undefined ? root.name : `${root.name}:${root.versionConstraint}`;
}

export const PACKAGE_RESOLUTION_PROVENANCE = "package-resolution";

/**
 * Provenance step of a package resolved from a registry, in any ecosystem: the
 * root requirement it was resolved for and the resolution's selections, from
 * which {@link explainResolutionPath} explains why a package of the closure is
 * there at its version, and {@link purlOf} and {@link formatOf} read the
 * package's identity.
 */
export interface IResolutionOrigin<V> extends IProvenanceStep {
  kind: typeof PACKAGE_RESOLUTION_PROVENANCE;
  /** The root requirement the closure was resolved for. */
  root: Requirement;
  /** The resolution's selections, shared with the resolution, not copied. */
  selections: Selected<V>[];
  /** Write a version as the registry's format writes it. */
  versionToString(version: V): string;
  /** The format of the registry the package was resolved from. */
  format: PackageFormat<unknown, unknown>;
}

/**
 * Get the format a package was resolved in, from its provenance `origin`, or
 * undefined where no resolution is among its steps (a target's build, a
 * package installed with fabr).
 */
export function formatOf(origin: IProvenanceStep | undefined): PackageFormat<unknown, unknown> | undefined {
  for (let step = origin; step !== undefined; step = step.parent) {
    if (step.kind === PACKAGE_RESOLUTION_PROVENANCE) {
      return (step as IResolutionOrigin<unknown>).format;
    }
  }
  return undefined;
}

/**
 * Get the package URL (purl) of the package `name` at `version`, resolved with
 * the provenance `origin`: the format's purl of the name the registry
 * publishes the package under (a renamed package's `publishedName`), or
 * undefined where no resolution is among its steps (a target's build, a
 * package installed with fabr) or its format has no purl type.
 */
export function purlOf(origin: IProvenanceStep | undefined, name: string, version: string): string | undefined {
  for (let step = origin; step !== undefined; step = step.parent) {
    if (step.kind === PACKAGE_RESOLUTION_PROVENANCE) {
      const resolution = step as IResolutionOrigin<unknown>;
      const selected = resolution.selections.find(each => each.name === name && resolution.versionToString(each.version) === version);
      return resolution.format.purl?.(selected?.publishedName ?? name, version);
    }
  }
  return undefined;
}

/**
 * Find the selection owning `path` within a mounted closure: the one whose
 * package name is the longest leading run of the path's components (a scoped
 * npm name is a two-component prefix). Undefined when nothing owns it, as for
 * a path mounted under a dependency alias, which no selection is named.
 */
function owningSelection<V>(selections: Selected<V>[], path: string): Selected<V> | undefined {
  let best: Selected<V> | undefined;
  for (const sel of selections) {
    if ((path === sel.name || path.startsWith(sel.name + "/")) && sel.name.length > (best ? best.name.length : -1)) {
      best = sel;
    }
  }
  return best;
}

/**
 * Explain how the package owning `path` came to be in the resolved closure, at
 * its version, as display lines:
 * - selected by the root requirement: one line, the package at its version and
 *   the root's constraint;
 * - selected by another package's requirement: one line, the chain of
 *   selections from the root through that requirer (`a@1 -> b@2 (^2.0.0)`),
 *   ending at the package with the constraint that selected it;
 * - selected by a requirer that is no longer among the selections (a version
 *   a higher one displaced): the chain the package is reached by, then a line
 *   naming the requirement that raised it;
 * - owned by no selection: one line saying so.
 */
export function explainResolutionPath<V>(origin: IResolutionOrigin<V>, path: string): string[] {
  const selection = owningSelection(origin.selections, path);
  if (!selection) {
    return [`'${path}' is not owned by a package in the resolution of ${written(origin.root)}`];
  }
  const { id, find, pathTo } = resolutionExplainer(origin.selections, origin.versionToString);

  const winner = selection.selectedBy;
  if (!winner || winner.requiredBy === ROOT_REQUIRER) {
    /* Directly required by the root requirement */
    return [`${id(selection)} (${winner?.versionConstraint ?? origin.root.versionConstraint})`];
  }
  const winnerNode = find(winner.requiredBy);
  if (winnerNode) {
    return [[...pathTo(winnerNode), `${id(selection)} (${winner.versionConstraint ?? "any version"})`].join(" -> ")];
  }
  /* The requirement that selected the version was declared by a version
   * since displaced: show the chain the package is reached by, and name it. */
  return [
    pathTo(selection).join(" -> "),
    `version ${origin.versionToString(selection.version)} raised by ${winner.requiredBy} requiring ${
      winner.versionConstraint ?? "any version"
    } (since superseded)`,
  ];
}

registerProvenanceRenderer<IResolutionOrigin<unknown>>(PACKAGE_RESOLUTION_PROVENANCE, (origin, context) => {
  const lines = context.path === undefined ? [`resolved from ${written(origin.root)}`] : explainResolutionPath(origin, context.path);
  return lines.map(message => ({ message }));
});
