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

import { BuildContext, TargetContext } from "../model/BuildContext";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { registerTargetRule } from "./Registry";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";

/**
 * Execute an arbitrary script, yielding some set of output files.
 *
 * Note: this is the main execution point which nearly everything else
 * is built on top of, and can be called directly.
 *
 * Ideally this would be fully sandboxed, but for now we just kind of
 * fake it and hope the tools aren't _too_ badly behaved.
 * @param spec
 * @param config
 */
export function runGeneric(context: TargetContext): Computable<FileSet> {
  const tmpdir = getExecRoot(context);
  context.getFileSet("inputs").then(inputs => filesetToDir(tmpdir, inputs));

  return Computable.resolve(EMPTY_FILESET);
}

/**
 * Create a dir in which we're going to run the thing; We're usually going to want
 * to do this inside the build cache so that we can just rename files to their final
 * locations.
 */
function getExecRoot(config: TargetContext): string {
  return "/tmp/fixme";
}

function filesetToDir(dir: string, files: FileSet): void {
  for (const [path, file] of files) {
  }
}

registerTargetRule("script", {}, runGeneric);
