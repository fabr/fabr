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

/**
 * The generic `zip` target: its `srcs` written as one zip archive, named after
 * the target (`<name>.zip`), a symlink among them stored as a symlink.
 */

import * as path from "path";
import { ActionContext } from "../core/BuildCache";
import { BuildAction, BuildResult, fileSetInput, IBuildActionDefinition, stringConfig } from "../core/BuildAction";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { ITaskReport } from "../support/Execute";
import { writeZip } from "../support/PackZip";
import { defineRule } from "./Types";

/** The `zip` rule. */
export default defineRule({
  requirements(context) {
    return { build: { srcs: context.getFileProperty("srcs") } };
  },
  evaluateMaterialized(context, { srcs }) {
    return Computable.resolve(new BuildAction(ZIP_ACTION, { files: FileSet.unionAll(...srcs) }, { name: zipName(context.name) }));
  },
});

/** @return the name of the archive a target builds: the last part of its name (`deploy/app` → `app.zip`). */
function zipName(target: string): string {
  return `${path.posix.basename(target)}.zip`;
}

/** Write the archive named by the action's `name` from its `files`, straight into the store. */
function runZip(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const name = stringConfig(action, "name");
  return ctx
    .admit(report, () => writeZip(fileSetInput(action, "files"), ctx.createOutput(), name, { symlinks: true }))
    .then(zip => ({ result: new FileSet(new Map([[name, zip]])) }));
}

export const ZIP_ACTION: IBuildActionDefinition = { id: "core:zip", version: 1, run: runZip };
