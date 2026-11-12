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
 * Provenance step for a FileSet produced by resolving a package requirement,
 * for any package ecosystem. The root requirement identifies the (persisted,
 * deterministic) resolution, and selections is a reference to the
 * already-loaded resolution document — retained, not copied, and only
 * consulted if an explanation is actually needed.
 *
 * The ecosystem-specific concerns are parameterized: how versions print, and
 * the format the package was resolved in. Everything else — including which
 * package owns a path within the resolved output — is answerable from the
 * selections themselves.
 */
export interface IResolutionOrigin<V> extends IProvenanceStep {
  kind: typeof PACKAGE_RESOLUTION_PROVENANCE;
  root: Requirement;
  selections: Selected<V>[];
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
 * package name is a leading component-prefix of the path (longest wins — a
 * scoped npm name is simply a two-component prefix). Purely positional: the selections
 * carry every name in the closure, so no ecosystem naming convention is
 * needed. Undefined when nothing owns it — e.g. a path mounted under a
 * dependency *alias*, which is not a resolution name.
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
 * Reconstruct the requirement chain explaining how the package owning `path`
 * came to be in the resolved closure, as a dependency-ordered arrow chain of
 * selected versions (each annotated with the constraint its predecessor
 * declared). The chain shown is the one through the requirement that actually
 * determined the selected version, so every name in it is justified.
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
  /* The winning requirement was declared by a version that was itself
   * superseded; fall back to the reachability path and note the raise. */
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
