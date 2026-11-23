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
 * The java_test rule: compile the tests against `deps` and `compile_deps`, and
 * run them with `deps` on the classpath ({@link runJavaTests}), with
 * `defines`, `jvm_args`, `env` and `stability`. A measured run measures
 * nothing.
 */

import { BUILD_OVERRIDE, defineRule, EMPTY_FILESET, FileSet } from "@fabr-build/core";
import { describeJava } from "../Description";
import { MAVEN_FORMAT } from "../MavenProtocol";
import { runJavaTests } from "../TestPipeline";

/** The `java_test` rule, under `test`. */
export default defineRule({
  /* The tests are compiled against the packages as `build` resolves them, and
   * run with them as `run` does. */
  requirements(context) {
    return {
      build: {
        tests: context.getFileProperty("tests", BUILD_OVERRIDE),
        resources: context.getFileProperty("resources", BUILD_OVERRIDE),
        deps: context.getPackageProperty("deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        compile_deps: context.getPackageProperty("compile_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
      },
      run: {
        run_deps: context.getPackageProperty("deps", BUILD_OVERRIDE, MAVEN_FORMAT),
      },
    };
  },
  evaluateMaterialized(context, inputs) {
    const tests = FileSet.unionAll(...inputs.tests);
    return runJavaTests(
      context,
      { jvmArgsProperty: "jvm_args", definesProperty: "defines", envProperty: "env", stabilityProperty: "stability" },
      {
        tests,
        compile: [...inputs.deps, ...inputs.compile_deps],
        runtime: inputs.run_deps,
        resources: inputs.resources,
        sources: [tests],
      }
    );
  },
  /* Describe the tests as an editor compiles them, against what the run compiles them against. */
  describe(context, requirements) {
    return requirements.describeAll().then(inputs => {
      const tests = FileSet.unionAll(...inputs.tests);
      return tests.isEmpty()
        ? EMPTY_FILESET
        : describeJava(context, requirements.resolved, {
            sources: tests,
            deps: [...inputs.deps, ...inputs.compile_deps],
            tags: ["test"],
          });
    });
  },
});
