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
 * The js_package[test] rule: compile `tests` against the package as
 * js_package[build] builds it (in the module format the test framework loads),
 * with `test_deps` and the package's own requirements, and run each test file
 * under the test framework `test_framework` names, with the package installed
 * beside them. `test_resources` are staged for the tests to read,
 * `test_expectations` are the recorded snapshots and `test_env` is the test
 * processes' environment.
 */

import { BUILD_OVERRIDE, Computable, defineRule, PackageSources, ResolutionSpec, TargetContext } from "@fabr-build/core";
import {
  compileAndRunTests,
  describeTests,
  packageBuildOverrides,
  TestRequirements,
  testFramework,
  testRequirements,
} from "../TestPipeline";
import { NPM_FORMAT } from "../NPMProtocol";

/** The `js_package` rule, under `test`. */
export default defineRule({
  /**
   * State the package's test requirements. Its `provided_deps` and
   * `optional_provided_deps` are read as more `deps`, compiled against and
   * installed. Its `compile_deps` are compiled against and installed too, but
   * their flags do not set the test environment. The package itself is
   * required as its build makes it, in the module format the framework loads.
   */
  requirements(context: TargetContext): Computable<ResolutionSpec<TestRequirements>> {
    return Computable.forAll(
      [
        packageBuildOverrides(context, "test_framework").then(overrides => context.resolveSelfWithOverrides(overrides)),
        context.getFileProperty("srcs", BUILD_OVERRIDE),
        context.getFileProperty("tests", BUILD_OVERRIDE),
        context.getPackageProperty("deps", BUILD_OVERRIDE, NPM_FORMAT),
        context.getPackageProperty("provided_deps", BUILD_OVERRIDE, NPM_FORMAT),
        context.getPackageProperty("optional_provided_deps", BUILD_OVERRIDE, NPM_FORMAT),
        context.getPackageProperty("compile_deps", BUILD_OVERRIDE, NPM_FORMAT),
        context.getPackageProperty("test_deps", BUILD_OVERRIDE, NPM_FORMAT),
        context.getFileProperty("test_resources", BUILD_OVERRIDE),
        context.getFileProperty("resources", BUILD_OVERRIDE),
        context.getFileProperty("test_expectations", BUILD_OVERRIDE),
      ],
      (built, srcs, tests, deps, provided, optional, compileOnly, test_deps, test_resources, resources, expectations) =>
        testRequirements({
          package: built,
          srcs,
          tests,
          deps: new PackageSources([...deps.sources, ...provided.sources, ...optional.sources], NPM_FORMAT),
          compile_deps: compileOnly,
          test_deps,
          test_resources,
          resources,
          expectations,
        })
    );
  },
  /* Describe the tests for an editor as the compile the run makes. */
  describe(context, requirements) {
    return testFramework(context, "test_framework").then(framework =>
      describeTests(context, framework, { envProperty: "test_env", packageName: context.name }, requirements)
    );
  },
  evaluateMaterialized(context, collected) {
    return testFramework(context, "test_framework").then(framework =>
      compileAndRunTests(context, framework, { envProperty: "test_env", packageName: context.name }, collected)
    );
  },
});
