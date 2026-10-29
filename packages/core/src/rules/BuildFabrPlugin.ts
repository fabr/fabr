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
 * The `fabr_plugin` target as a package: its base package (`srcs`) with its
 * `.fabr` files (`libs`) and further files (`resources`) added, named as the
 * target is, at the base package's version and with its requirements. Its
 * `package.json` is the base package's, named as the plugin and listing the
 * `libs` under `"@fabr-build/plugin"`, which marks it a plugin. This is the
 * plugin as it is published and installed.
 */

import { FabrError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { MANIFEST, pluginLibsOf, pluginPackageJson } from "../model/Plugin";
import { defineRule } from "./Types";

/** The `fabr_plugin` rule. */
export default defineRule({
  requirements(context) {
    return {
      extends: context.getPackageProperty("srcs"),
      libs: context.getFileProperty("libs"),
      optional_libs: context.getFileProperty("optional_libs"),
      resources: context.getFileProperty("resources"),
    };
  },
  evaluateMaterialized(context, { extends: srcs, libs, optional_libs: optionalLibs, resources }) {
    const [base] = srcs;
    if (srcs.length !== 1 || !(base instanceof PackageFileSet)) {
      throw new FabrError(`a 'fabr_plugin' target's 'srcs' is one package, the plugin's code`);
    }
    const files = [...FileSet.unionAll(base, ...libs, ...optionalLibs, ...resources)].filter(([name]) => name !== MANIFEST);
    return pluginPackageJson(base.getFile(MANIFEST), context.name, pluginLibsOf(libs, optionalLibs)).then(
      manifest =>
        new PackageFileSet(new FileSet(new Map([...files, [MANIFEST, manifest]])), context.name, base.version, base.dependencies, base.origin, base.provided)
    );
  },
});

