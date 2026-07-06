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

import { BUILD_OPERATION, Computable, registerRule, RuleResult, TargetContext } from "@fabr/core";
import { BUILD_OP, compileAndRunTests } from "../TestPipeline";

function testJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs", BUILD_OP),
      context.getFlags("deps", BUILD_OP),
      context.getFileSet("tests", BUILD_OP),
      context.getGlobalString("JS_TARGET", BUILD_OP),
      context.getFileSources("deps", BUILD_OP),
      context.getFileSources("test_deps", BUILD_OP),
    ],
    (sources, flags, tests, target, depSources, testDepSources) =>
      compileAndRunTests(context, { sources, tests, flags, target, depSources, testDepSources, runnerSources: [] })
  );
}

registerRule("js_package", { [BUILD_OPERATION]: "test" }, testJsPackage);
