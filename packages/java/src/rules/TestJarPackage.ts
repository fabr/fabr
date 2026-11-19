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
 * The jar_package[test] rule: compile the tests against the package's own jar,
 * and run them with the jar and everything it and the tests require on the
 * classpath ({@link runJavaTests}), with `test_defines`, `test_jvm_args`,
 * `test_env` and `test_stability`. A measured run measures the package's own
 * jar.
 */

import { BUILD_OVERRIDE, defineRule, EMPTY_FILESET, FileSet } from "@fabr-build/core";
import { describeJava } from "../Description";
import { MAVEN_FORMAT } from "../MavenProtocol";
import { measuredPackages, ownJars, runJavaTests } from "../TestPipeline";

/** The `jar_package` rule, under `test`. */
export default defineRule({
  /* The package under test is its own build. The tests are compiled against
   * the packages as `build` resolves them, and run with them as `run` does. */
  requirements(context) {
    return {
      build: {
        pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE),
        srcs: context.getFileProperty("srcs", BUILD_OVERRIDE),
        tests: context.getFileProperty("tests", BUILD_OVERRIDE),
        test_resources: context.getFileProperty("test_resources", BUILD_OVERRIDE),
        provided: context.getPackageProperty("provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        optional_provided: context.getPackageProperty("optional_provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        compile_deps: context.getPackageProperty("compile_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        test_deps: context.getPackageProperty("test_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
      },
      run: {
        run_pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE),
        run_provided: context.getPackageProperty("provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        run_optional_provided: context.getPackageProperty("optional_provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        run_test_deps: context.getPackageProperty("test_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
      },
    };
  },
  evaluateMaterialized(context, inputs) {
    const tests = FileSet.unionAll(...inputs.tests);
    return runJavaTests(
      context,
      {
        jvmArgsProperty: "test_jvm_args",
        definesProperty: "test_defines",
        envProperty: "test_env",
        stabilityProperty: "test_stability",
      },
      {
        tests,
        compile: [...inputs.pkg, ...inputs.provided, ...inputs.optional_provided, ...inputs.test_deps, ...inputs.compile_deps],
        runtime: [...inputs.run_pkg, ...inputs.run_provided, ...inputs.run_optional_provided, ...inputs.run_test_deps],
        resources: inputs.test_resources,
        sources: [tests, ...inputs.srcs],
        measured: { jars: ownJars(inputs.run_pkg), packages: measuredPackages(inputs.srcs) },
      }
    );
  },
  /* Describe the tests as an editor compiles them: against the package's own build, as the run does. */
  describe(context, requirements) {
    return requirements.describeAll().then(inputs => {
      const tests = FileSet.unionAll(...inputs.tests);
      return tests.isEmpty()
        ? EMPTY_FILESET
        : describeJava(context, requirements.resolved, {
            sources: tests,
            deps: [...inputs.pkg, ...inputs.provided, ...inputs.optional_provided, ...inputs.test_deps, ...inputs.compile_deps],
            tags: ["test"],
          });
    });
  },
});
