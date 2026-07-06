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

/**
 * The js_compile rule: the one TS-compile path, a self-contained target
 * `{ srcs = FILES; deps = FILES }`. `deps` is the node_modules the sources are
 * compiled against (package deps + any @types, already resolved by the caller
 * so `getFileSet` here is a no-op materialization). It resolves its *own*
 * toolchain — `TSC` (a build tool, independent of what it compiles) — and its
 * own `JS_TARGET`, derives the tsconfig, lays out the tsc working directory
 * and yields the `exec` action that runs the compiler (output: `build/**`).
 * The `runtime` input carries the ES lib level (from the target's `es*` flags,
 * which can't survive materialization into `deps`).
 */

import { Computable, createExecAction, FileSet, MemoryFile, registerRule, RuleResult, TargetContext } from "@fabr/core";
import { assembleNodeModules, parseJSTarget } from "../JSPackage";

function compileTypescript(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSet("deps"),
      context.getRequiredString("runtime"),
      context.getGlobalString("JS_TARGET"),
      context.getGlobalTarget("TSC"),
    ],
    (srcs, deps, runtime, target, tscSources) => {
      const jsTarget = parseJSTarget(target);
      const modules = FileSet.unionAll(deps, assembleNodeModules(tscSources.filter((s): s is FileSet => s instanceof FileSet)));
      const tsconfig = {
        compilerOptions: {
          declaration: true,
          declarationMap: true,
          outDir: "build",
          rootDir: "src",
          /* Strict by default; TODO: needs a way to flag it off per target */
          strict: true,
          target: jsTarget.version,
          lib: jsTarget.environment === "browser" ? [runtime, "dom"] : [runtime],
          module: jsTarget.module === "esm" ? "esnext" : "commonjs",
          moduleResolution: "node",
        },
        exclude: ["node_modules"],
        include: ["./src/**/*.ts"],
      };

      const workingDir = FileSet.layout({
        node_modules: modules,
        src: srcs,
        "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
      });

      return createExecAction(workingDir, ["node", "node_modules/typescript/bin/tsc"], "build:**", "compile");
    }
  );
}

registerRule("js_compile", {}, compileTypescript);
