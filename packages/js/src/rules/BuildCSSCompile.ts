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
 * Sass `@use`/`@import` resolution (loadPaths). It resolves its *own* toolchain
 * — SASS (sass-embedded) + LIGHTNINGCSS — as libraries the fabr CSS driver
 * requires, mounted **apart** from the sources under a tool dir (their deps must
 * not collide with — nor be visible to — the styled tree). The driver runs with
 * cwd at the working root and yields the generic `exec` action (output: `out/**`).
 *
 * The bundler stays dumb about CSS: this produces plain CSS + per-module proxy
 * modules; esbuild concatenates/orders/splits them via the JS import graph.
 */

import { posix } from "node:path";
import {
  BUILD_OPERATION,
  Computable,
  createExecAction,
  EMPTY_FILESET,
  FileSet,
  MemoryFile,
  RuleRegistration,
  RuleResult,
  TargetContext,
} from "@fabr-build/core";
import { assembleNodeModules } from "../JSPackage";
import { buildCssOptions, CSS_DRIVER_ENTRY, CSS_OUTDIR, CSS_SRC_ROOT, getCssDriver, SCSS_DEPS_DIR } from "../CSSCompile";

/** Where the CSS toolchain + driver mount — disjoint from the styled tree so the
 * tools' deps neither collide with nor are visible to the sources. */
const TOOL_DIR = ".fabr-css";

function buildCssCompile(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSets("deps"),
      context.getGlobalSources("SASS"),
      context.getGlobalSources("LIGHTNINGCSS"),
    ],
    (srcs, deps, sassSources, lcssSources): RuleResult | Computable<RuleResult> => {
      const fileNames = [...srcs].map(([name]) => name);
      if (fileNames.length === 0) {
        /* No styled sources — nothing to lower. Skip staging/running the driver. */
        return EMPTY_FILESET;
      }
      /* The tools resolve separately from the sources (a build tool is
       * independent of what it processes — the TSC/esbuild precedent), so their
       * pins don't co-resolve with the styled tree's deps. */
      const tool = context.collect({ sass: sassSources, lightningcss: lcssSources });
      return tool.then(({ sass, lightningcss }) => {
        const options = buildCssOptions(fileNames);
        const staged = FileSet.unionAll(
          FileSet.layout({
            [CSS_SRC_ROOT]: srcs,
            [SCSS_DEPS_DIR]: assembleNodeModules(deps),
            [TOOL_DIR]: FileSet.unionAll(
              getCssDriver(),
              FileSet.layout({ node_modules: assembleNodeModules([...sass, ...lightningcss]) })
            ),
            "css-manifest.json": MemoryFile.from(JSON.stringify(options)),
          })
        );
        /* Bare "node": the exec step resolves it against the fabr process's PATH
         * at run time, keeping the manifest free of a host-specific absolute path. */
        const argv = ["node", posix.join(TOOL_DIR, CSS_DRIVER_ENTRY), "--manifest=css-manifest.json"];
        return createExecAction(staged, argv, `${CSS_OUTDIR}:**`, "compile-css");
      });
    }
  );
}

export const buildCssCompileRule: RuleRegistration = {
  type: "css_compile",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildCssCompile,
};
