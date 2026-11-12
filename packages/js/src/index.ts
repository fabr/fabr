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
 * @fabr-build/js: fabr's JavaScript and npm support, loaded as a fabr plugin
 * (`plugin @fabr-build/js;`; the plugin contract is in
 * docs/src/content/docs/developer/plugins.md). Its package.json lists
 * lib/JS.fabr, which declares the js rules and the npm, Node.js and browser
 * repository types, each implemented by a module this package exports
 * (`rules/*`, `NPMRepository`, `NodeDistribution`, `BrowserRepository`).
 *
 * The test runners and tool drivers the js rules run are bins of
 * @fabr-build/js-tools, declared as `js_script` globals in JS.fabr; nothing
 * here imports them.
 */

/* The compile pipeline helpers, for other js rules to build on. Only rules in
 * this repository can use them: one plugin cannot extend another. */
export { assembleNodeModules } from "./NodeModules";
export { classifySources, compileJsSources, IJsSources, JSTarget, parseJSTarget, passthroughFiles } from "./JSPackage";
