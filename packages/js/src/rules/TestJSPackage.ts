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
 * The js_package[test] rule: in-package test sugar — the tests property is
 * compiled together with the package's own source tree (so relative imports
 * resolve) and run against the package's deps.
 */

import { BUILD_OPERATION, BUILD_OVERRIDE, Computable, FileSet, RuleRegistration, RuleResult, TargetContext } from "@fabr-build/core";
import { compileAndRunTests } from "../TestPipeline";

function testJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSetProperties(["srcs", "tests"], BUILD_OVERRIDE),
      context.getGlobalString("JS_TARGET", BUILD_OVERRIDE),
      context.getFileProperty("deps", BUILD_OVERRIDE),
      context.getFileProperty("provided_deps", BUILD_OVERRIDE),
      context.getFileProperty("test_deps", BUILD_OVERRIDE),
    ],
    ({ srcs, tests }, target, depSources, providedSources, testDepSources) =>
      /* A test install is self-contained — there is no fabr host to supply the
       * provided (peer) deps — so they are just more `deps` here: compiled and
       * installed identically, with no manifest to distinguish them. */
      compileAndRunTests(context, {
        sources: FileSet.unionAll(...srcs),
        tests: FileSet.unionAll(...tests),
        target,
        depSources: [...depSources, ...providedSources],
        testDepSources,
      })
  );
}

export const testJsPackageRule: RuleRegistration = {
  type: "js_package",
  constraints: { [BUILD_OPERATION]: "test" },
  evaluate: testJsPackage,
};
