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
 * The script[run] rule: *define* a runnable plain shell script — the
 * ecosystem-neutral analogue of js_script. `entry` is the script FILE itself,
 * contributed to the install at its resolved name and launched with the shell;
 * `deps` stage any further support files (their filesets union flat — no
 * package mounting, this is just files); `args` are fixed leading arguments.
 * It yields a `RunnableFileSet` — the staged files plus how to launch them —
 * for `fabr run` or a `generate` command to invoke. It does not itself
 * execute: running a runnable and collecting its output is `generate`'s job.
 */

import { BUILD_OVERRIDE } from "../model/Constraints";
import { FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { defineRule, RuleResult } from "./Types";
import { FabrError } from "../core/Errors";

/** The `script` rule, under `run`. */
export default defineRule({
  /* deps/entry are ordinary build content, read under build rather than the run
   * operation this rule is selected by (constraints otherwise propagate). Both
   * are read for their files: each requirement delivers its own — a repository
   * reference the package's files alone, a target what it built — and nothing
   * is resolved together. */
  requirements(context) {
    return {
      deps: context.getFileProperty("deps", BUILD_OVERRIDE),
      entry: context.getFileProperty("entry", BUILD_OVERRIDE),
    };
  },
  evaluateMaterialized(context, { deps, entry }) {
    return context.getProperty("args").then(args => runnableScript(deps, entry, args?.getValues() ?? []));
  },
});

/** Make the runnable of the script `entry`, with `deps` beside it, run with `args`. */
function runnableScript(deps: FileSet[], entry: FileSet[], args: string[]): RuleResult {
  /* The entry is the script file itself — exactly one. (A shell script has no
   * notion of a package bin; a packaged tool is js_script's job.) */
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
  return RunnableFileSet.forEntry(install, names[0], args, "sh");
}
