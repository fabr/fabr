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
 * are compiled and run under fabr's own runner; `deps` are given explicitly and
 * carry both packages and any plain-source support (e.g. a test harness), which
 * compiles as a sibling but is never run.
 */

import { BUILD_OPERATION, Computable, EMPTY_FILESET, RuleRegistration, RuleResult, TargetContext } from "@fabr/core";
import { BUILD_OP, compileAndRunTests } from "../TestPipeline";

function runJsTest(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("tests", BUILD_OP),
      context.getGlobalString("JS_TARGET", BUILD_OP),
      context.getFileSources("deps", BUILD_OP),
    ],
    (tests, target, depSources) =>
      compileAndRunTests(context, { sources: EMPTY_FILESET, tests, target, depSources, testDepSources: [] })
  );
}

export const jsTestRule: RuleRegistration = { type: "js_test", constraints: { [BUILD_OPERATION]: "test" }, evaluate: runJsTest };
