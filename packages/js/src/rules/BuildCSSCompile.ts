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
 * target `{ srcs = FILES; deps = FILES }`. `srcs` are the styled sources
 * (.scss/.sass/.module.{scss,css}/.css); `deps` are scss packages mounted for
 * Sass `@use`/`@import` resolution (loadPaths). The compiler is a build *tool*,
 * independent of what it lowers, so it is resolved apart as the CSS_COMPILER
 * runnable (fabr's own Sass driver, declared in JS.fabr — the TSC precedent) and
 * mounted under a tool dir (its deps must not collide with — nor be visible to —
 * the styled tree). The driver runs with cwd at the working root and yields the
 * generic `exec` action (output: `out/**`).
 *
 * Lowering is all this does: css-modules lower like any other stylesheet and are
 * scoped downstream by the bundler, which also concatenates/orders/splits the
 * plain CSS produced here via the JS import graph.
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
import { createNodeExecAction } from "../NodeExecAction";
import { buildCssOptions, CSS_OUTDIR, CSS_SRC_ROOT, SCSS_DEPS_DIR } from "../CSSCompile";

/** Where the CSS toolchain + driver mount — disjoint from the styled tree so the
 * tools' deps neither collide with nor are visible to the sources. */
const TOOL_DIR = ".fabr-css";

function buildCssCompile(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [context.getFileSetProperties(["srcs", "deps"]), context.getGlobalRunnable("CSS_COMPILER")],
    ({ srcs: srcSets, deps }, compiler): RuleResult => {
      const srcs = FileSet.unionAll(...srcSets);
      const fileNames = [...srcs].map(([name]) => name);
      if (fileNames.length === 0) {
        /* No styled sources — nothing to lower. Skip staging/running the driver. */
        return EMPTY_FILESET;
      }
      const options = buildCssOptions(fileNames);
      const staged = FileSet.layout({
        [CSS_SRC_ROOT]: srcs,
        [TOOL_DIR]: compiler,
        "css-manifest.json": MemoryFile.from(JSON.stringify(options)),
      });
      /* The driver launches from its own mount (its deps resolve there); cwd is
       * the working root, so the manifest and src/out roots resolve against it. */
      const argv = compiler.toCommandLine(["--manifest=css-manifest.json"], { base: TOOL_DIR });
      /* The deps go over unassembled: mounting them is the step's work, so it
       * happens on a miss rather than on the way to asking whether there is one. */
      return createNodeExecAction(staged, deps, argv, `${CSS_OUTDIR}:**`, { mount: SCSS_DEPS_DIR, label: "compile-css" });
    }
  );
}

export const buildCssCompileRule: RuleRegistration = {
  type: "css_compile",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildCssCompile,
};
