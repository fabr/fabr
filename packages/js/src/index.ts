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
 * @fabr-build/js: the Javascript/NPM ecosystem support for fabr, loaded as a fabr
 * plugin (`plugin @fabr-build/js;` — see PLUGINS.md for the plugin contract):
 * activation contributes the js rules, the npm repository type, and this
 * package's lib/ (JS.fabr), which the plugin declaration auto-includes.
 *
 * The package also ships the test runners the js test rules run (the
 * `js_script` declarations in JS.fabr, over the compiled entries in this
 * installation). Those runtimes live in src/testRunner/, src/jestRunner/ and
 * src/vitestRunner/, disjoint from this side of the package: they execute
 * standalone inside client test processes (no dependency on the host's core at
 * runtime), and nothing here imports them.
 */

import { packageLibFile, PluginContribution } from "@fabr-build/core";
import { buildJsPackageRule } from "./rules/BuildJSPackage";
import { runJsPackageRule } from "./rules/RunJSPackage";
import { jsCompileRule } from "./rules/BuildJSCompile";
import { buildJsBundleRule } from "./rules/BuildJSBundle";
import { buildSassCompileRule } from "./rules/BuildSassCompile";
import { buildCssPostcssRule } from "./rules/BuildCSSPostcss";
import { testJsPackageRules } from "./rules/TestJSPackage";
import { jsTestRules } from "./rules/TestJSTest";
import { jsScriptRule } from "./rules/RunJSScript";
import { npmRepositoryRegistration } from "./NPMRepository";

/* The compile pipeline helpers, for other js rules to build on (in-tree only:
 * cross-plugin extension isn't supported yet — see PLUGINS.md) */
export { assembleNodeModules } from "./NodeModules";
export {
  classifySources,
  compileJsSources,
  IJsSources,
  JSTarget,
  parseJSTarget,
  passthroughFiles,
} from "./JSPackage";

/**
 * Plugin entry point: return this package's contribution — the js rules
 * (js_package build/run/test, js_test, js_script, js_compile, js_bundle,
 * sass_compile, css_postcss), the npm
 * repository type, and this package's `.fabr` library (JS.fabr), which a
 * `plugin @fabr-build/js;` declaration auto-includes. Pure: no global registration
 * (see PLUGINS.md); the host merges this into the build model's rule tables.
 */
export function activate(): PluginContribution {
  return {
    rules: [
      buildJsPackageRule,
      runJsPackageRule,
      jsCompileRule,
      buildJsBundleRule,
      buildSassCompileRule,
      buildCssPostcssRule,
      ...testJsPackageRules,
      ...jsTestRules,
      jsScriptRule,
    ],
    repositories: [npmRepositoryRegistration],
    includes: [packageLibFile("@fabr-build/js", "JS.fabr")],
  };
}
