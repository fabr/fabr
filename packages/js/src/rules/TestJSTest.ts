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
 * The js_test[test] rule: compile srcs against deps and run the *.test.* files
 * under the runner (a standalone test target, deps + runner given explicitly).
 */

import { BUILD_OPERATION, Computable, registerRule, RuleResult, TargetContext } from "@fabr/core";
import { BUILD_OP, compileAndRunTests, TEST_FILE_PATTERN } from "../TestPipeline";

function runJsTest(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs", BUILD_OP),
      context.getFlags("deps", BUILD_OP),
      context.getGlobalString("JS_TARGET", BUILD_OP),
      context.getFileSources("deps", BUILD_OP),
      context.getFileSources("runner", BUILD_OP),
    ],
    (sources, flags, target, depSources, runnerSources) => {
      const tests = sources.remap(name => (TEST_FILE_PATTERN.test(name) ? name : undefined));
      return compileAndRunTests(context, { sources, tests, flags, target, depSources, testDepSources: [], runnerSources });
    }
  );
}

registerRule("js_test", { [BUILD_OPERATION]: "test" }, runJsTest);
