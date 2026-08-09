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
import { resolutionExplainer } from "./ResolutionGraph";
import { Requirement, ROOT_REQUIRER, Selected } from "./Types";

export const PACKAGE_RESOLUTION_PROVENANCE = "package-resolution";

/**
 * Provenance step for a FileSet produced by resolving a package requirement,
 * for any package ecosystem. The root requirement identifies the (persisted,
 * deterministic) resolution, and selections is a reference to the
 * already-loaded resolution document — retained, not copied, and only
 * consulted if an explanation is actually needed.
 *
 * The one ecosystem-specific concern is parameterized: how versions print.
 * Everything else — including which package owns a path within the resolved
 * output — is answerable from the selections themselves.
 */
export interface IResolutionOrigin<V> extends IProvenanceStep {
  kind: typeof PACKAGE_RESOLUTION_PROVENANCE;
  root: Requirement;
  selections: Selected<V>[];
  versionToString(version: V): string;
}

/**
 * The selection owning `path` within a mounted closure: the one whose package
 * name is a leading component-prefix of the path (longest wins — a scoped npm
 * name is simply a two-component prefix). Purely positional: the selections
 * carry every name in the closure, so no ecosystem naming convention is
 * needed. Undefined when nothing owns it — e.g. a path mounted under a
 * dependency *alias*, which is deliberately not a resolution name.
 */
function owningSelection<V>(selections: Selected<V>[], path: string): Selected<V> | undefined {
  let best: Selected<V> | undefined;
  for (const sel of selections) {
    if ((path === sel.pkg || path.startsWith(sel.pkg + "/")) && sel.pkg.length > (best ? best.pkg.length : -1)) {
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
    return [`'${path}' is not owned by a package in the resolution of ${origin.root.pkg}:${origin.root.constraint}`];
  }
  const { id, find, pathTo } = resolutionExplainer(origin.selections, origin.versionToString);

  const winner = selection.selectedBy;
  if (!winner || winner.requiredBy === ROOT_REQUIRER) {
    /* Directly required by the root requirement */
    return [`${id(selection)} (${winner?.constraint ?? origin.root.constraint})`];
  }
  const winnerNode = find(winner.requiredBy);
  if (winnerNode) {
    return [[...pathTo(winnerNode), `${id(selection)} (${winner.constraint})`].join(" -> ")];
  }
  /* The winning requirement was declared by a version that was itself
   * superseded; fall back to the reachability path and note the raise. */
  return [
    pathTo(selection).join(" -> "),
    `version ${origin.versionToString(selection.version)} raised by ${winner.requiredBy} requiring ${winner.constraint} (since superseded)`,
  ];
}

registerProvenanceRenderer(PACKAGE_RESOLUTION_PROVENANCE, (step, context) => {
  const origin = step as IResolutionOrigin<unknown>;
  const lines =
    context.path === undefined
      ? [`resolved from ${origin.root.pkg}:${origin.root.constraint}`]
      : explainResolutionPath(origin, context.path);
  return lines.map(message => ({ message }));
});
