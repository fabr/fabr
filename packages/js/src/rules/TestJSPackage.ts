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

import { BUILD_OVERRIDE, Computable, defineRule, TargetContext, PackageSources } from "@fabr-build/core";
import { compileAndRunTests, TestRequirements, testFramework, testRequirements } from "../TestPipeline";

/** The `js_package` rule, under `test`: the package's tests, run under the test framework its `test_framework` names. */
export default defineRule({
  /**
   * State the package's test requirements. Its `provided_deps`,
   * `optional_provided_deps` and `compile_deps` are more `deps` here, compiled
   * and installed identically: a test install is self-contained, with no host to
   * supply them and no manifest to distinguish them.
   */
  requirements(context: TargetContext): Computable<TestRequirements> {
    return Computable.forAll(
      [
        context.getFileProperty("srcs", BUILD_OVERRIDE),
        context.getFileProperty("tests", BUILD_OVERRIDE),
        context.getPackageProperty("deps", BUILD_OVERRIDE),
        context.getPackageProperty("provided_deps", BUILD_OVERRIDE),
        context.getPackageProperty("optional_provided_deps", BUILD_OVERRIDE),
        context.getPackageProperty("compile_deps", BUILD_OVERRIDE),
        context.getPackageProperty("test_deps", BUILD_OVERRIDE),
        context.getFileProperty("test_resources", BUILD_OVERRIDE),
        context.getFileProperty("test_expectations", BUILD_OVERRIDE),
      ],
      (srcs, tests, deps, provided, optional, compileOnly, test_deps, test_resources, expectations) =>
        testRequirements({
          srcs,
          tests,
          deps: new PackageSources([...deps.sources, ...provided.sources, ...optional.sources, ...compileOnly.sources]),
          test_deps,
          test_resources,
          expectations,
        })
    );
  },
  evaluateMaterialized(context, collected) {
    return testFramework(context, "test_framework").then(framework =>
      compileAndRunTests(context, framework, { envProperty: "test_env", packageName: context.name }, collected)
    );
  },
});
