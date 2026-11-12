/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { FileSet } from "../core/FileSet";
import { IProvenanceStep, namingDigest, registerProvenanceNaming, wholeContentPrefix } from "../core/Provenance";
import { declName, ITargetDecl } from "./AST";

/** The provenance kind of an {@link ITargetOrigin}. */
export const TARGET_PROVENANCE = "target";

/**
 * The provenance step of a FileSet a target built: the target's declaration.
 */
export interface ITargetOrigin extends IProvenanceStep {
  kind: typeof TARGET_PROVENANCE;
  decl: ITargetDecl;
}

/* A file a target built has the source path `<target>:<name>` (`gen:out/x.ts`)
 * where nothing beneath names it: a file passed through unchanged keeps its
 * own. The target's name is used whatever the configuration. */
registerProvenanceNaming<ITargetOrigin>(TARGET_PROVENANCE, {
  sourcePath: (step, path, below) => below(path) ?? `${declName(step.decl)}:${path}`,
  digest: (step, names, below) => namingDigest(TARGET_PROVENANCE, JSON.stringify(declName(step.decl)), below(names)),
  prefix: (step, below) => wholeContentPrefix(step, declName(step.decl), below),
});

/** @return true if the content `origin` explains was built in the project,
 * that is, a target produced it, otherwise false. */
export function builtInProject(origin: IProvenanceStep | undefined): boolean {
  for (let step = origin; step !== undefined; step = step.parent) {
    if (step.kind === TARGET_PROVENANCE) {
      return true;
    }
  }
  return false;
}

/** A target's built FileSet, its origin the target's step. */
export interface Target extends FileSet {
  origin: ITargetOrigin;
}
