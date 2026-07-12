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
import { assembleScopedNodeModules, JSTarget, parseJSTarget, resolveJsxImportSource } from "../JSPackage";

/** Where the toolchain is mounted in the working dir — disjoint from src/node_modules/build. */
const TOOL_DIR = ".tools/tsc";

/** The automatic-runtime jsx mode: the dev variant (source-position
 * instrumentation, `<src>/jsx-dev-runtime`) for a debug build, else production. */
export function jsxModeFor(buildType: string | undefined): "react-jsx" | "react-jsxdev" {
  return buildType === "debug" ? "react-jsxdev" : "react-jsx";
}

/**
 * The tsconfig the compile runs under. `include` matches `.tsx` as well as `.ts`
 * (both are routed to this compile), so a `.tsx` source is compiled, not silently
 * ignored. When a `jsx` runtime is given, the automatic transform is emitted — a
 * JSX source's code imports `<jsxImportSource>/jsx-runtime`, so the target must
 * carry that runtime as a dep (auto-detected, see resolveJsxImportSource).
 */
export function makeTsConfig(
  jsTarget: JSTarget,
  runtime: string,
  jsx?: { mode: string; importSource: string }
): Record<string, unknown> {
  return {
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
      ...(jsx ? { jsx: jsx.mode, jsxImportSource: jsx.importSource } : {}),
      /* tsc ignores FORCE_COLOR (it only checks its own TTY), so formatted
       * diagnostics must be forced here; unwanted codes are stripped at
       * render time. Note this also overrides the child's NO_COLOR. */
      pretty: true,
    },
    exclude: ["node_modules"],
    include: ["./src/**/*.ts", "./src/**/*.tsx"],
  };
}

function compileTypescript(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSets("deps"),
      context.getRequiredString("runtime"),
      context.getGlobalString("JS_TARGET"),
      context.getGlobalRunnable("TSC"),
      context.getGlobalString("BUILD_TYPE"),
    ],
    (srcs, deps, runtime, target, tsc, buildType) => {
      /* js_compile owns its node_modules layout (only it needs it) and its JSX
       * runtime: both read the ordered direct deps directly. TSX needs a
       * jsxImportSource (auto-detected from the deps); a JSX-free compile omits it. */
      const hasTsx = [...srcs].some(([name]) => name.toLowerCase().endsWith(".tsx"));
      const build = (jsxImportSource: string): RuleResult => {
        const jsx = jsxImportSource ? { mode: jsxModeFor(buildType), importSource: jsxImportSource } : undefined;
        const tsconfig = makeTsConfig(parseJSTarget(target), runtime, jsx);
        const workingDir = FileSet.layout({
          node_modules: assembleScopedNodeModules(deps),
          src: srcs,
          "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
          [TOOL_DIR]: tsc,
        });
        /* The tool launches from its own mount (its deps resolve there); cwd is the
         * workspace root, so `include`/`node_modules` resolve against the sources. */
        return createExecAction(workingDir, tsc.toCommandLine([], { base: TOOL_DIR }), "build:**", "compile");
      };
      return hasTsx ? resolveJsxImportSource(deps).then(build) : build("");
    }
  );
}

export const jsCompileRule: RuleRegistration = { type: "js_compile", constraints: {}, evaluate: compileTypescript };
