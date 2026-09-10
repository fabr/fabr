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

/**
 * The css_compile rule: lower a styled source tree to plain CSS, a self-contained
 * target `{ srcs = FILES; deps = FILES; package_name = STRING }`. `srcs` are the
 * styled sources (.scss/.sass/.module.{scss,css}/.css); `deps` are scss packages
 * mounted for Sass `@use`/`@import` resolution (loadPaths); `package_name` is the
 * identity css-module scoped names are derived from. The compiler is a build *tool*,
 * independent of what it lowers, so it is resolved apart as the CSS_COMPILER
 * runnable (fabr's own Sass driver, declared in JS.fabr — the TSC precedent) and
 * mounted under a tool dir (its deps must not collide with — nor be visible to —
 * the styled tree). The driver runs with cwd at the working root and yields the
 * generic `exec` action (output: `out/**`).
 *
 * Lowering is not all it does: a css-module is **scoped here**, and the step also
 * emits the JS shim carrying its class-name map plus the TypeScript declarations
 * that let an import of the stylesheet typecheck — so the names exist before any
 * compile, and are the same names whether the result is bundled, tested or
 * shipped. Concatenating/ordering/splitting the plain CSS remains the bundler's,
 * via the JS import graph.
 */

import {
  BUILD_OPERATION,
  Computable,
  EMPTY_FILESET,
  FileSet,
  MemoryFile,
  RuleRegistration,
  RuleResult,
  TargetContext,
} from "@fabr-build/core";
import { buildCssOptions, CSS_OUTDIR, CSS_SRC_ROOT } from "../CSSCompile";
import { emitsSourceMap } from "../JSPackage";
import { createNodeExecAction, PNP } from "../NodeExecAction";

/** Where the CSS toolchain + driver mount — disjoint from the styled tree so the
 * tools' deps neither collide with nor are visible to the sources. */
const TOOL_DIR = ".fabr-css";

function buildCssCompile(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSetProperties(["srcs", "deps"]),
      context.getGlobalRunnable("CSS_COMPILER"),
      context.getProperty("package_name"),
      context.getGlobalString("BUILD_TYPE"),
    ],
    ({ srcs: srcSets, deps }, compiler, packageNameProp, buildType): RuleResult => {
      const srcs = FileSet.unionAll(...srcSets);
      const fileNames = [...srcs].map(([name]) => name);
      if (fileNames.length === 0) {
        /* No styled sources — nothing to lower. Skip staging/running the driver. */
        return EMPTY_FILESET;
      }
      /* The package identity scoped class names are derived from. A target with
       * none (a bundle's own sources) scopes by path alone, which is still
       * unique within the one delivery it can appear in. */
      /* Maps ride the same BUILD_TYPE axis as the JavaScript ones: a release
       * build carrying one kind and not the other would just look broken. */
      const options = buildCssOptions(fileNames, packageNameProp?.toString() ?? "", emitsSourceMap(buildType));
      const workspace = {
        [CSS_SRC_ROOT]: srcs,
        [TOOL_DIR]: compiler,
        "css-manifest.json": MemoryFile.from(JSON.stringify(options)),
      };
      /* The driver launches from its own mount (its deps resolve there); cwd is
       * the working root, so the manifest and src/out roots resolve against it. */
      const argv = compiler.toCommandLine(["--manifest=css-manifest.json"], { base: TOOL_DIR });
      /* Nothing is mounted: the stylesheets' dependency closure is a table the
       * step generates beside them on a miss, which the driver's importer
       * reads. A styled tree that imports from one large package used to stage
       * that package's every file — the cost this removes. */
      return createNodeExecAction(FileSet.layout(workspace), deps, argv, `${CSS_OUTDIR}:**`, {
        layout: PNP,
        label: "compile-css",
      });
    }
  );
}

export const buildCssCompileRule: RuleRegistration = {
  type: "css_compile",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildCssCompile,
};
