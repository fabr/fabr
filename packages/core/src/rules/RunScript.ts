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
 * The `script[run]` rule: a runnable shell script. `entry` is the script file
 * itself, added to the install under its resolved name; `deps` are further
 * files, unioned flat beside it; `args` are fixed leading arguments. It is
 * launched by the runnable the global `SHELL` names. The rule yields the
 * `RunnableFileSet`, for `fabr run` or a `generate` command to run; it runs
 * nothing itself.
 */

import { BUILD_OVERRIDE } from "../model/Constraints";
import { FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { defineRule } from "./Types";
import { Property } from "../model/Property";
import { FabrError } from "../core/Errors";

/** The `script` rule, under `run`. */
export default defineRule({
  /* `deps` and `entry` are read under `build`, not the `run` operation this
   * rule is selected by, and for their files alone: a repository reference as
   * the package's own files, a target as what it built. Nothing among them is
   * resolved together. */
  requirements(context) {
    return {
      run: {
        deps: context.getFileProperty("deps", BUILD_OVERRIDE),
        entry: context.getFileProperty("entry", BUILD_OVERRIDE),
      },
    };
  },
  evaluateMaterialized(context, { deps, entry }) {
    return context
      .getProperty("args")
      .then((args: Property | undefined) => context.launchedBy(runnableScript(deps, entry, args?.getValues() ?? []), SHELL_GLOBAL));
  },
});

/** The global naming the shell a script is run with. */
const SHELL_GLOBAL = "SHELL";

/** Make the runnable of the script `entry`, with `deps` beside it, run with `args`. */
function runnableScript(deps: FileSet[], entry: FileSet[], args: string[]): RunnableFileSet {
  /* The entry must be exactly one file, the script itself. */
  const entrySet = FileSet.unionAll(...entry);
  const names = [...entrySet].map(([name]) => name);
  if (names.length !== 1) {
    throw new FabrError(
      names.length === 0
        ? "script 'entry' resolved to no file — name the script file itself"
        : `script 'entry' resolved to ${names.length} files (${names.slice(0, 5).join(", ")}) — name exactly one`
    );
  }
  const install = FileSet.unionAll(...deps, entrySet);
  return RunnableFileSet.forEntry(install, names[0], args);
}
