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

import { TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION, BUILD_OVERRIDE, FILES_OPERATION } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { RuleRegistration, RuleResult } from "./Types";

/**
 * The generic `files` rule: registered as a default (all-types) rule, so it is
 * selected for any target under BUILD_OPERATION=files that has no more specific
 * rule of its own. "files" means "give me the output files and no more" — it is
 * a weaker form of `build`, so this simply re-evaluates the same target under
 * BUILD_OPERATION=build and hands back its files. The value of the distinct
 * operation is not here but at the leaves: a consumer that reads `files` off its
 * context (an `@npm:` repository, say) can deliver strictly less — a package's
 * own files with no dependency closure — when only the files are wanted.
 */
function deliverFiles(context: TargetContext): Computable<RuleResult> {
  return context.context.getTargetWithOverrides(context.name, BUILD_OVERRIDE).then(sources => {
    const files = sources.find((source): source is FileSet => source instanceof FileSet);
    if (!files) {
      throw new Error(`internal: building '${context.name}' under files did not yield file content`);
    }
    return files;
  });
}

/* No `type` → a default (all-types) rule. */
export const defaultFilesRule: RuleRegistration = { constraints: { [BUILD_OPERATION]: FILES_OPERATION }, evaluate: deliverFiles };
