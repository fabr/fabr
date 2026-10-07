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

import { BUILD_OPERATION, BUILD_OVERRIDE, Computable, RuleDefinition, RuleResult, TargetContext } from "@fabr-build/core";
import { compileAndRunTests, ITestFramework, TEST_FRAMEWORKS } from "../TestPipeline";

function runJsTest(context: TargetContext, framework: ITestFramework): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileProperty("tests", BUILD_OVERRIDE),
      context.getGlobalString("JS_TARGET", BUILD_OVERRIDE),
      context.getFileProperty("deps", BUILD_OVERRIDE),
      context.getFileProperty("resources", BUILD_OVERRIDE),
      context.getFileProperty("expectations", BUILD_OVERRIDE),
      context.getMap("env"),
    ],
    (testRefs, target, depSources, testResourceSources, expectationSources, env) =>
      compileAndRunTests(context, framework, {
        sourceRefs: [],
        testRefs,
        target,
        depSources,
        testDepSources: [],
        testResourceSources,
        expectationSources,
        env,
      })
  );
}

/** One rule per test framework, selected on the target's `framework`. */
export const jsTestRules: RuleDefinition[] = [...TEST_FRAMEWORKS].map(([name, framework]) => ({
  type: "js_test",
  properties: { [BUILD_OPERATION]: "test" },
  targetProperties: { framework: name },
  evaluate: context => runJsTest(context, framework),
}));
