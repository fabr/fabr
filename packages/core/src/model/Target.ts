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
import { IProvenanceStep, namingDigest, registerProvenanceNaming } from "../core/Provenance";
import { declName, ITargetDecl } from "./AST";

export const TARGET_PROVENANCE = "target";

/**
 * Provenance step for a FileSet produced by evaluating a target: the
 * declaration of the target that built it.
 */
export interface ITargetOrigin extends IProvenanceStep {
  kind: typeof TARGET_PROVENANCE;
  decl: ITargetDecl;
}

/* What the target built is named from the target (`gen:out/x.ts`), where
 * nothing beneath names it otherwise: a file it passed through unchanged keeps
 * its own. The name is the target's in any configuration — a configuration
 * that changes what is built changes its inputs. */
registerProvenanceNaming(TARGET_PROVENANCE, {
  sourcePath: (step, path, below) => below(path) ?? `${declName((step as ITargetOrigin).decl)}:${path}`,
  digest: (step, below) => namingDigest(TARGET_PROVENANCE, JSON.stringify(declName((step as ITargetOrigin).decl)), below()),
});

/** Check whether the content `origin` explains was built in the project, that
 * is, a target produced it. */
export function builtInProject(origin: IProvenanceStep | undefined): boolean {
  for (let step = origin; step !== undefined; step = step.parent) {
    if (step.kind === TARGET_PROVENANCE) {
      return true;
    }
  }
  return false;
}

/**
 * The final evaluated result of a TargetDecl, normally consisting of a FileSet
 * and possibly additional properties.
 */
export interface Target extends FileSet {
  origin: ITargetOrigin;
}
