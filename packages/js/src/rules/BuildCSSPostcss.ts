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
 * The css_postcss rule: run the postcss chain over a plain-CSS tree, a
 * self-contained target `{ srcs = FILES; deps = PACKAGES; package_name = STRING }`.
 * `srcs` are stylesheets (authored `.css`, or a sass_compile step's lowered
 * output with its maps beside it); `package_name` is the identity css-module
 * scoped names are derived from. css-modules is the chain's first plugin: a
 * `.module.css` input is scoped and published under its final name with the JS
 * shim carrying its class-name map; any other stylesheet is copied through, its
 * map carried beside it.
 *
 * `deps` are readable, never published: a cross-file `composes` resolves within
 * this step's own inputs, or — for a package-shaped specifier — under the
 * dependency's location in the PnP table the step stages beside the sources.
 * The tool is resolved apart as the POSTCSS_DRIVER runnable and mounted under a
 * tool dir.
 */

import {
  BUILD_OPERATION,
  Computable,
  EMPTY_FILESET,
  FileSet,
  MemoryFile,
  PackageFileSet,
  RuleDefinition,
  defineRule,
  RuleResult,
  TargetContext,
} from "@fabr-build/core";
import { buildPostcssOptions, CSS_OUTDIR, CSS_SRC_ROOT, CSS_TOOL_DIR } from "../CSSCompile";
import { emitsSourceMap } from "../JSPackage";
import { DEPS_REPORT_FILE, DEPS_REPORT_FLAG, SOURCE_PATHS_FILE, SOURCE_PATHS_FLAG } from "@fabr-build/js-tools";
import { createNodeExecAction, PNP } from "../NodeExecAction";

function buildCssPostcss(context: TargetContext, collected: { srcs: FileSet[]; deps: FileSet[] }): Computable<RuleResult> {
  return Computable.forAll(
    [
      Computable.resolve(collected),
      context.getGlobalRunnable("POSTCSS_DRIVER"),
      context.getProperty("package_name"),
      context.getGlobalString("BUILD_TYPE"),
    ],
    ({ srcs: srcSets, deps }, compiler, packageNameProp, buildType): RuleResult => {
      const srcs = FileSet.unionAll(...srcSets);
      const fileNames = [...srcs].map(([name]) => name);
      if (fileNames.length === 0) {
        return EMPTY_FILESET;
      }
      /* The package identity scoped class names are derived from. A target with
       * none (a bundle's own sources) scopes by path alone, which is still
       * unique within the one delivery it can appear in. */
      /* Only a PACKAGE is composable: its stylesheets have a name a specifier
       * can spell. A loose content dep has no such name. */
      const packages = deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
      const options = buildPostcssOptions(fileNames, packageNameProp?.toString() ?? "", emitsSourceMap(buildType), packages);
      const workspace = {
        [CSS_SRC_ROOT]: srcs,
        [CSS_TOOL_DIR]: compiler,
        "postcss-manifest.json": MemoryFile.from(JSON.stringify(options)),
      };
      /* Its maps name each source by the reference resolving to it, from the
       * table the step stages: the stylesheets and the packages they reach.
       * Nothing is mounted: a dependency's stylesheet is located through the
       * table the step generates beside the sources. */
      const argv = compiler.toCommandLine(
        ["--manifest=postcss-manifest.json", SOURCE_PATHS_FLAG, SOURCE_PATHS_FILE, DEPS_REPORT_FLAG, DEPS_REPORT_FILE],
        { base: CSS_TOOL_DIR }
      );
      return createNodeExecAction(FileSet.layout(workspace), deps, argv, `${CSS_OUTDIR}:**`, {
        label: "postcss",
        layout: PNP,
        sourcePaths: SOURCE_PATHS_FILE,
        packageSourcePaths: true,
        depsReport: DEPS_REPORT_FILE,
      });
    }
  );
}

export const buildCssPostcssRule: RuleDefinition = defineRule({
  type: "css_postcss",
  properties: { [BUILD_OPERATION]: "build" },
  requirements: context => ({ srcs: context.getFileProperty("srcs"), deps: context.getPackageProperty("deps") }),
  evaluateMaterialized: (context, collected) => buildCssPostcss(context, collected),
});
