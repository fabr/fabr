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
 * @fabr/js: the Javascript/NPM ecosystem support for fabr, loaded as a fabr
 * plugin (`plugin @fabr/js;` — see PLUGINS.md for the plugin contract):
 * activation registers the js rules (js_package build+test, js_test,
 * js_script, npm_repository) and this package's lib/ (JS.fabr) on the system
 * include path.
 *
 * The package doubles as fabr's test runner: the js test rules source the
 * runner runtime straight from this installation's own testRunner/ (see
 * TestPipeline.getHostRunner), never resolving it as a build target. That
 * runtime lives in src/testRunner/ and is deliberately disjoint from this side
 * of the package: it executes standalone inside client test processes (no
 * dependency on the host's core at runtime), and nothing here imports it.
 */

import type * as fabr from "@fabr/core";
import { buildJsPackageRule } from "./rules/BuildJSPackage";
import { runJsPackageRule } from "./rules/RunJSPackage";
import { jsCompileRule } from "./rules/BuildJSCompile";
import { buildJsBundleRule } from "./rules/BuildJSBundle";
import { buildCssCompileRule } from "./rules/BuildCSSCompile";
import { testJsPackageRule } from "./rules/TestJSPackage";
import { jsTestRule } from "./rules/TestJSTest";
import { jsScriptRule } from "./rules/RunJSScript";
import { npmRepositoryRegistration } from "./NPMRepository";

/* The compile pipeline helpers, for other js rules to build on (in-tree only:
 * cross-plugin extension isn't supported yet — see PLUGINS.md) */
export { assembleNodeModules, compileJsSources, ICompiledSources, JSTarget, parseJSTarget } from "./JSPackage";

/**
 * Plugin entry point: return this package's contribution — the js rules
 * (js_package build/run/test, js_test, js_script, js_compile, js_bundle), the npm
 * repository type, and this package's `.fabr` library (JS.fabr), which a
 * `plugin @fabr/js;` declaration auto-includes. Pure: no global registration
 * (see PLUGINS.md); the host merges this into the build model's rule tables.
 */
export function activate(api: typeof fabr): fabr.PluginContribution {
  return {
    rules: [
      buildJsPackageRule,
      runJsPackageRule,
      jsCompileRule,
      buildJsBundleRule,
      buildCssCompileRule,
      testJsPackageRule,
      jsTestRule,
      jsScriptRule,
    ],
    repositories: [npmRepositoryRegistration],
    includes: [api.packageLibFile("@fabr/js", "JS.fabr")],
  };
}
