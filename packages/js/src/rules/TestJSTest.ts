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
 * The js_test[test] rule: a standalone test target `{ tests, deps }`. The `tests`
 * are compiled and run under the runner of the framework the target's
 * `framework` selects; `deps` are given explicitly and
 * carry both packages and any plain-source support (e.g. a test harness), which
 * compiles as a sibling but is never run.
 */

import { BUILD_OVERRIDE, Computable, defineRule, PackageSources, ResolutionSpec, TargetContext } from "@fabr-build/core";
import { compileAndRunTests, TestRequirements, testFramework, testRequirements } from "../TestPipeline";

/** The `js_test` rule: the tests, run under the test framework the target's `framework` names. */
export default defineRule({
  requirements(context: TargetContext): Computable<ResolutionSpec<TestRequirements>> {
    return Computable.forAll(
      [
        context.getFileProperty("tests", BUILD_OVERRIDE),
        context.getPackageProperty("deps", BUILD_OVERRIDE),
        context.getFileProperty("resources", BUILD_OVERRIDE),
        context.getFileProperty("expectations", BUILD_OVERRIDE),
      ],
      (tests, deps, test_resources, expectations) =>
        testRequirements({ srcs: [], tests, deps, test_deps: new PackageSources([]), test_resources, expectations })
    );
  },
  evaluateMaterialized(context, collected) {
    return testFramework(context, "framework").then(framework => compileAndRunTests(context, framework, { envProperty: "env" }, collected));
  },
});
