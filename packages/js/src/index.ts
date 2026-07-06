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
 * activation registers the js rules (js_package build+test, js_test, js_run,
 * npm_repository) and this package's lib/ (JS.fabr) on the system include
 * path.
 *
 * The package doubles as the default test runner (JS_TEST_RUNNER). The runner
 * runtime lives in src/testRunner/ and is deliberately disjoint from this side
 * of the package: it executes standalone inside client test processes (no
 * dependency on the host's core at runtime), and nothing here imports it.
 */

import type * as fabr from "@fabr/core";
import "./rules/BuildJSPackage";
import "./rules/BuildJSCompile";
import "./rules/TestJSPackage";
import "./rules/TestJSTest";
import "./rules/BuildJSRun";
import "./NPMRepository";

/* The compile pipeline helpers, for other js rules to build on (in-tree only:
 * cross-plugin extension isn't supported yet — see PLUGINS.md) */
export { assembleNodeModules, compileJsSources, ICompiledSources, JSTarget, parseJSTarget } from "./JSPackage";

export function activate(api: typeof fabr): void {
  api.registerSystemIncludeDir(api.packageLibDir("@fabr/js"));
}
