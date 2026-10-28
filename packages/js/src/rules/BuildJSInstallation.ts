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
 * The js_installation rule: a `node_modules` tree of every package `deps`
 * hold or reach, laid out as the plugin lays out any install, with the loose
 * files among `deps` at their own paths.
 */

import { defineRule, FileSet, PackageFileSet } from "@fabr-build/core";
import { assembleNodeModules } from "../NodeModules";

/** The `js_installation` rule. */
export default defineRule({
  requirements(context) {
    return { deps: context.getPackageProperty("deps") };
  },
  evaluateMaterialized(_context, { deps }: { deps: FileSet[] }) {
    const packages = deps.filter(dep => dep instanceof PackageFileSet);
    const loose = deps.filter(dep => !(dep instanceof PackageFileSet));
    return FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules(packages) }), ...loose);
  },
});
