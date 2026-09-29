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
 * The sass_compile rule: lower a Sass source tree to plain CSS, a
 * self-contained target `{ srcs = FILES; deps = FILES }`. `srcs` are the Sass
 * sources (.scss/.sass, modules included — the `.module.` marker rides through
 * to the output name, since lowering is not scoping); `deps` are scss packages
 * mounted for Sass `@use`/`@import` resolution. Beside each stylesheet the step
 * writes its source map (when the build carries them) and nothing else;
 * scoping and shims are the css_postcss step's, which consumes this step's
 * output. The compiler is a build *tool*, independent of what it lowers,
 * so it is resolved apart as the SASS_DRIVER runnable (fabr's own Sass
 * driver, declared in JS.fabr — the TSC precedent) and mounted under a tool dir
 * (its deps must not collide with — nor be visible to — the styled tree). The
 * driver runs with cwd at the working root and yields the generic `exec` action
 * (output: `out/**`).
 */

import { BUILD_OPERATION, Computable, EMPTY_FILESET, FileSet, MemoryFile, RuleRegistration, RuleResult, TargetContext } from "@fabr-build/core";
import { buildSassOptions, CSS_OUTDIR, CSS_SRC_ROOT, CSS_TOOL_DIR } from "../CSSCompile";
import { emitsSourceMap } from "../JSPackage";
import { createNodeExecAction, PNP } from "../NodeExecAction";

function buildSassCompile(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [context.getFileSetProperties(["srcs", "deps"]), context.getGlobalRunnable("SASS_DRIVER"), context.getGlobalString("BUILD_TYPE")],
    ({ srcs: srcSets, deps }, compiler, buildType): RuleResult => {
      const srcs = FileSet.unionAll(...srcSets);
      /* Maps ride the same BUILD_TYPE axis as the JavaScript ones. */
      const options = buildSassOptions([...srcs].map(([name]) => name), emitsSourceMap(buildType));
      if (options.sources.length === 0) {
        /* Nothing to lower — every source is a partial, or there are none. */
        return EMPTY_FILESET;
      }
      const workspace = {
        [CSS_SRC_ROOT]: srcs,
        [CSS_TOOL_DIR]: compiler,
        "sass-manifest.json": MemoryFile.from(JSON.stringify(options)),
      };
      /* The driver launches from its own mount (its deps resolve there); cwd is
       * the working root, so the manifest and src/out roots resolve against it. */
      const argv = compiler.toCommandLine(["--manifest=sass-manifest.json"], { base: CSS_TOOL_DIR });
      /* Nothing is mounted: the stylesheets' dependency closure is a table the
       * step generates beside them on a miss, which the driver's importer
       * reads. */
      return createNodeExecAction(FileSet.layout(workspace), deps, argv, `${CSS_OUTDIR}:**`, {
        layout: PNP,
        label: "compile-sass",
      });
    }
  );
}

export const buildSassCompileRule: RuleRegistration = {
  type: "sass_compile",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildSassCompile,
};
