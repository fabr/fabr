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

import { TargetContext } from "../../model/BuildContext";
import { Computable } from "../../core/Computable";
import { EMPTY_FILESET, FileSet } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";
import { MemoryFile } from "../../core/MemoryFS";
import { getResultFileSet, writeFileSet } from "../../core/BuildCache";
import { execute } from "../../support/Execute";

/**
 * Build a javascript (Node/NPM compatible) package.
 *
 *
 * all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]>; }>;
 *
 * type Awaited<T> = T extends null | undefined ? T : // special case for `null | undefined` when not in `--strictNullChecks` mode
    T extends object & { then(onfulfilled: infer F, ...args: infer _): any; } ? // `await` only unwraps object types with a callable `then`. Non-object types are not unwrapped
        F extends ((value: infer V, ...args: infer _) => any) ? // if the argument to `then` is callable, extracts the first argument
            Awaited<V> : // recursively unwrap the value
        never : // the argument to `then` was not callable
    T; // non-object or non-thenable
 * 
 * @param spec
 * @param context
 */
function buildJsPackage(context: TargetContext): Computable<FileSet> {
  /* STUB */
  console.log("Building JS Package");

  return Computable.forAll(
    [context.getFileSet("srcs"), context.getFileSet("deps"), context.getGlobalString("JS_TARGET")],
    (sources, deps, target) => {
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

      if ("ts" in sourceGroups) {
        context.getGlobalTarget("TSC").then(typescript => {
          compileTypescript(sourceGroups.ts, deps, FileSet.unionAll(...(typescript as FileSet[])), target, context);
        });
      }

      return new Computable<FileSet>();
    }
  );
}

function compileTypescript(srcs: FileSet, deps: FileSet, tsc: FileSet, target: string, context: TargetContext): Computable<FileSet> {
  const tsconfig = {
    compilerOptions: {
      declaration: true,
      declarationMap: true,
      outDir: "build",
      rootDir: "src",
    },
    exclude: ["node_modules"],
    include: ["./src/**/*.ts"],
  };

  const workingDir = FileSet.layout({
    node_modules: [deps, tsc],
    src: srcs,
    "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
  });
  console.log(workingDir.toManifest());

  context.getCachedOrBuild(workingDir.toManifest(), targetDir =>
    writeFileSet(targetDir, workingDir)
      .then(() => execute("/home/nkeynes/.nvm/versions/node/v20.10.0/bin/node", ["node_modules/typescript/bin/tsc"], targetDir, {}))
      .then(() => getResultFileSet(targetDir, "build/**"))
  );
  return Computable.resolve(EMPTY_FILESET);
}

registerTargetRule("js_package", {}, buildJsPackage);
