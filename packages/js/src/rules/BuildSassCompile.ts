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
 * The sass_compile rule: compile each Sass source in `srcs` (`.scss`, `.sass`)
 * to a `.css` file of the same name (`x.module.scss` to `x.module.css`), with
 * its source map in builds that have them (`BUILD_TYPE`). Partials (`_x.scss`)
 * produce nothing. `deps` are the packages whose stylesheets the sources load
 * with `@use` or `@import`, reached through a PnP table the step writes. The
 * compiler is the `SASS_DRIVER` program, staged under its own directory so its
 * packages are not visible to the sources. The rule yields a `js:exec` action
 * collecting `out/**`.
 */

import { Computable, defineRule, EMPTY_FILESET, FileSet, MemoryFile, RuleResult, TargetContext } from "@fabr-build/core";
import { buildSassOptions, CSS_OUTDIR, CSS_SRC_ROOT, CSS_TOOL_DIR } from "../CSSCompile";
import { emitsSourceMap } from "../JSPackage";
import { DEPS_REPORT_FILE, DEPS_REPORT_FLAG, MANIFEST_FLAG, SOURCE_PATHS_FILE, SOURCE_PATHS_FLAG } from "@fabr-build/js-tools";
import { PNP } from "../Layout";
import { createNodeExecAction } from "../NodeExecAction";
import { NPM_FORMAT } from "../NPMProtocol";

/** The `sass_compile` rule. */
export default defineRule({
  requirements(context) {
    return {
      build: { srcs: context.getFileProperty("srcs"), deps: context.getPackageProperty("deps", undefined, NPM_FORMAT) },
      result: "files",
    };
  },
  evaluateMaterialized(context, collected) {
    return buildSassCompile(context, collected);
  },
});

function buildSassCompile(context: TargetContext, collected: { srcs: FileSet[]; deps: FileSet[] }): Computable<RuleResult> {
  return Computable.forAll(
    [Computable.resolve(collected), context.getGlobalRunnable("SASS_DRIVER"), context.getGlobalString("BUILD_TYPE")],
    ({ srcs: srcSets, deps }, compiler, buildType): RuleResult => {
      const srcs = FileSet.unionAll(...srcSets);
      /* Source maps follow BUILD_TYPE, as the JavaScript ones do. */
      const options = buildSassOptions(
        [...srcs].map(([name]) => name),
        emitsSourceMap(buildType)
      );
      if (options.sources.length === 0) {
        /* Nothing to compile: every source is a partial, or there are none. */
        return EMPTY_FILESET;
      }
      const workspace = {
        [CSS_SRC_ROOT]: srcs,
        [CSS_TOOL_DIR]: compiler,
        "sass-manifest.json": MemoryFile.from(JSON.stringify(options)),
      };
      /* The driver launches from its own directory (its packages resolve
       * there), with its cwd at the working root, which the manifest's paths
       * are relative to. Its maps name each source by its source path, from
       * the table the step stages for the stylesheets and the packages they
       * reach. */
      const argv = compiler.toCommandLine(
        [`${MANIFEST_FLAG}sass-manifest.json`, SOURCE_PATHS_FLAG, SOURCE_PATHS_FILE, DEPS_REPORT_FLAG, DEPS_REPORT_FILE],
        { base: CSS_TOOL_DIR }
      );
      /* The packages are not installed: on a miss the step writes a PnP table
       * of them beside the sources, which the driver's importer reads. */
      return createNodeExecAction(FileSet.layout(workspace), deps, argv, `${CSS_OUTDIR}:**`, {
        layout: PNP,
        label: "compile-sass",
        sourcePaths: SOURCE_PATHS_FILE,
        packageSourcePaths: true,
        depsReport: DEPS_REPORT_FILE,
      });
    }
  );
}
