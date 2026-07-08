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
 * toolchain — `TSC` (a build tool, independent of what it compiles) as a
 * **runnable** (`BUILD_OPERATION=run`), so it needn't know how to launch it —
 * and its own `JS_TARGET`, derives the tsconfig, and lays out the working
 * directory. The tool is **mounted apart** from the workspace (under `TOOL_DIR`,
 * not merged into `node_modules`): the tool's own dependencies must not collide
 * with — nor be visible to — the sources' `node_modules`. It runs with cwd at
 * the workspace root and yields the `exec` action (output: `build/**`). The
 * `runtime` input carries the ES lib level (from the target's `es*` flags,
 * which can't survive materialization into `deps`).
 */

import { Computable, createExecAction, FileSet, MemoryFile, RuleRegistration, RuleResult, TargetContext } from "@fabr/core";
import { parseJSTarget } from "../JSPackage";

/** Where the toolchain is mounted in the working dir — disjoint from src/node_modules/build. */
const TOOL_DIR = ".tools/tsc";

function compileTypescript(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSet("deps"),
      context.getRequiredString("runtime"),
      context.getGlobalString("JS_TARGET"),
      context.getGlobalRunnable("TSC"),
    ],
    (srcs, deps, runtime, target, tsc) => {
      const jsTarget = parseJSTarget(target);
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
        node_modules: deps,
        src: srcs,
        "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
        [TOOL_DIR]: tsc,
      });

      /* The tool launches from its own mount (its deps resolve there); cwd is the
       * workspace root, so `include`/`node_modules` resolve against the sources. */
      return createExecAction(workingDir, tsc.toCommandLine([], { base: TOOL_DIR }), "build:**", "compile");
    }
  );
}

export const jsCompileRule: RuleRegistration = { type: "js_compile", constraints: {}, evaluate: compileTypescript };
