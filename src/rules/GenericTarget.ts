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

import { BuildContext } from "../model/BuildContext";
import { PropertyType, ResolvedType } from "./Types";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { registerTargetRule } from "./Registry";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";

const GenericSchema = {
  properties: {
    command: {
      required: true,
      type: PropertyType.String,
    },
    inputs: {
      type: PropertyType.FileSet,
    },
    outs: {
      required: true,
      type: PropertyType.OutputFileSet,
    },
  },
  globals: {},
} as const;
type GenericType = ResolvedType<typeof GenericSchema>;

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
export function runGeneric(spec: GenericType, config: BuildContext): Computable<FileSet> {
  const tmpdir = getExecRoot(config);
  if (spec.inputs) {
    filesetToDir(tmpdir, spec.inputs);
  }

  return Computable.resolve(EMPTY_FILESET);
}

/**
 * Create a dir in which we're going to run the thing; We're usually going to want
 * to do this inside the build cache so that we can just rename files to their final
 * locations.
 */
function getExecRoot(config: BuildContext): string {
  return "/tmp/fixme";
}

function filesetToDir(dir: string, files: FileSet): void {
  for (const [path, file] of files) {
  }
}

function execute(cmd: string, args: string[], cwd: string, env: Record<string, string>): Computable<void> {
  return Computable.from((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, windowsHide: true });
    proc.stdout.on("data", data => {});
    proc.stderr.on("data", data => {});
    proc.on("close", (code, signal) => {
      if (signal) {
        reject("Terminated by signal " + signal);
      } else if (code !== 0) {
        reject("Exited with error code " + code);
      } else {
        resolve();
      }
    });
  });
}

registerTargetRule("script", GenericSchema, runGeneric);
