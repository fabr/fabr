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
 * The js_installation rule: build a `node_modules` tree of every package in
 * `deps` and every package they require, linked as any install the plugin
 * makes or, with `layout/hoisted` among `deps`, hoisted with no links, or,
 * with `layout/pnp`, a PnP installation holding its packages' trees; and the
 * loose files in `deps` at their own paths.
 */

import { defineRule, FileSet, Flag, PackageFileSet } from "@fabr-build/core";
import { layoutOf } from "../JSPackage";
import { HOISTED, PNP, pnpInstallation } from "../Layout";
import { assembleHoistedNodeModules, assembleNodeModules } from "../NodeModules";
import { NPM_FORMAT } from "../NPMProtocol";

/** The `js_installation` rule. */
export default defineRule({
  requirements(context) {
    return { run: { deps: context.getPackageProperty("deps", undefined, NPM_FORMAT) }, result: "files" };
  },
  evaluateMaterialized(context, { deps }: { deps: FileSet[] }) {
    const packages = deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
    const flags = deps.filter((dep): dep is Flag => dep instanceof Flag);
    const loose = deps.filter(dep => !(dep instanceof PackageFileSet) && !(dep instanceof Flag));
    const layout = layoutOf(flags);
    if (layout === PNP) {
      return pnpInstallation(context, packages).then(installed => FileSet.unionAll(installed, ...loose));
    }
    const tree = layout === HOISTED ? assembleHoistedNodeModules(packages) : assembleNodeModules(packages);
    return FileSet.unionAll(FileSet.layout({ node_modules: tree }), ...loose);
  },
});
