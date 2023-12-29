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

import { BuildConfig } from "../../model/BuildModel";
import { PropertyType, ResolvedType } from "../Types";
import { Computable } from "../../core/Computable";
import { FileSet } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";

const NodeJSSchema = {
  properties: {
    entry: {
      required: true,
      type: PropertyType.String,
    },
    deps: {
      type: PropertyType.FileSetList,
    },
    outs: {
      required: true,
      type: PropertyType.OutputFileSet,
    },
  },
  globals: {
    js_target: PropertyType.String,
    node: PropertyType.String,
  },
} as const;
type NodeJSType = ResolvedType<typeof NodeJSSchema>;

/**
 * Execute a NodeJS script, yielding some set of output files.
 * @param spec
 * @param config
 */
function runNodeJs(spec: NodeJSType, config: BuildConfig): Computable<FileSet> {
    return runGene
}

registerTargetRule("js_run", NodeJSSchema, runNodeJs);
