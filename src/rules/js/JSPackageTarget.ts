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

import { BuildContext } from "../../model/BuildContext";
import { ResolvedTarget } from "../Types";
import { Computable } from "../../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";

/**
 * Build a javascript (Node/NPM compatible) package.
 *
 *
 *
 *
 * @param spec
 * @param config
 */
function buildJsPackage(spec: ResolvedTarget, config: BuildContext): Computable<FileSet> {
  /* STUB */
  console.log("Building JS Package");

  const sources = spec.getFileSet("srcs");
  const target = config.getProperty("JS_TARGET");

  console.log("target: " + target);
  /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
  const packageJsonFile = sources
    .get("package.json")
    .then(file => file?.readString())
    .then(content => content && JSON.parse(content));

  /* If we have TS files, we get to invoke the compiler */

  const sourceGroups = sources.partition(path => {
    const lower = path.toLowerCase();
    const extidx = lower.lastIndexOf(".");
    if (extidx !== -1) {
      const ext = lower.substring(extidx + 1);
      switch (ext) {
        case "ts":
          if (lower.endsWith(".d.ts")) {
            break; /* Output only */
          }
        /* fallthrough */
        case "tsx":
          return "ts";
        case "js":
        case "jsx":
          return "js";
      }
    }
    return "copy";
  });

  console.log(sources.size);
  console.log(sourceGroups);
  if ("ts" in sourceGroups) {
    config
      .getProperty("TSC")
      .then(value => config.getTarget(value.toString()))
      .then(typescript => {
        compileTypescript(sourceGroups.ts, spec.getFileSet("deps"), typescript);
      });

    console.log("Has TS: " + sourceGroups.ts);
  }
  return new Computable<FileSet>();
}

function compileTypescript(srcs: FileSet, deps: FileSet, tsc: FileSource[]): Computable<FileSet> {
  return Computable.resolve(EMPTY_FILESET);
}

registerTargetRule("js_package", {}, buildJsPackage);
