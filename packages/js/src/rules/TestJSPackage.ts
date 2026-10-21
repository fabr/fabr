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

import { BUILD_OPERATION, BUILD_OVERRIDE, Computable, defineRule, RuleDefinition, TargetContext, PackageSources } from "@fabr-build/core";
import { compileAndRunTests, TestRequirements, TEST_FRAMEWORKS, testRequirements } from "../TestPipeline";

/**
 * State the package's test requirements. Its `provided_deps` are more `deps`
 * here, compiled and installed identically: a test install is self-contained,
 * with no host to supply them and no manifest to distinguish them.
 */
function requirements(context: TargetContext): Computable<TestRequirements> {
  return Computable.forAll(
    [
      context.getFileProperty("srcs", BUILD_OVERRIDE),
      context.getFileProperty("tests", BUILD_OVERRIDE),
      context.getPackageProperty("deps", BUILD_OVERRIDE),
      context.getPackageProperty("provided_deps", BUILD_OVERRIDE),
      context.getPackageProperty("test_deps", BUILD_OVERRIDE),
      context.getFileProperty("test_resources", BUILD_OVERRIDE),
      context.getFileProperty("test_expectations", BUILD_OVERRIDE),
    ],
    (srcs, tests, deps, provided, test_deps, test_resources, expectations) =>
      testRequirements({
        srcs,
        tests,
        deps: new PackageSources([...deps.sources, ...provided.sources]),
        test_deps,
        test_resources,
        expectations,
      })
  );
}

/** One rule per test framework, selected on the package's `test_framework`. */
export const testJsPackageRules: RuleDefinition[] = [...TEST_FRAMEWORKS].map(([name, framework]) =>
  defineRule({
    type: "js_package",
    properties: { [BUILD_OPERATION]: "test" },
    targetProperties: { test_framework: name },
    requirements,
    evaluateMaterialized: (context, collected) =>
      compileAndRunTests(context, framework, { envProperty: "test_env", packageName: context.name }, collected),
  })
);
