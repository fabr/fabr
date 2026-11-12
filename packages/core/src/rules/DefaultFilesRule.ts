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

import { TargetContext } from "../context/index";
import { BUILD_OPERATION, BUILD_OVERRIDE, Constraints, FILES_OPERATION } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { isFileSource } from "../core/Repository";
import { defineRule, RuleResult } from "./Types";
import { FabrError } from "../core/Errors";

/** The `files` rule, of every type: see {@link deliverFiles}. */
export default defineRule({
  evaluateResolved(context) {
    return deliverFiles(context);
  },
});

/**
 * Get a target's files, as the default rule under the `files` operation: build
 * the target itself under `build` and return what it built as plain files.
 * Each file source the build yields is returned as its own source, unflattened
 * (a `sync` release namespace stays itself); a package or runnable is returned
 * as a plain FileSet of its files, with no name, version or dependencies; any
 * source that is not a FileSource is left out.
 *
 * A target whose type has no rule for `build` but a rule for exactly one other
 * operation is built under that one instead: a `serve` or other program as the
 * install it would run, a test as its results (the report, coverage).
 *
 * Throws where the build yields no file source.
 */
function deliverFiles(context: TargetContext): Computable<RuleResult> {
  return context.buildSelfWithOverrides(filesOperation(context)).then(sources => {
    const files = sources.filter(isFileSource);
    if (files.length === 0) {
      throw new FabrError(`internal: building '${context.name}' under files did not yield file content`);
    }
    return files.map(source =>
      source instanceof PackageFileSet || source instanceof RunnableFileSet ? new FileSet(source, source.origin) : source
    );
  });
}

/** @return the operation a target's files are read under: `build`, or the one other operation its type has a rule for. */
function filesOperation(context: TargetContext): Constraints {
  if (context.hasTargetRule(context.name, "build")) {
    return BUILD_OVERRIDE;
  }
  const others = context.getTargetOperations(context.name).filter(operation => operation !== FILES_OPERATION);
  return others.length === 1 ? Constraints.of({ [BUILD_OPERATION]: others[0] }) : BUILD_OVERRIDE;
}
