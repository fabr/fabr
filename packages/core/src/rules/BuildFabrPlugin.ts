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

import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { PackageFileSet } from "../core/PackageFileSet";
import { PLUGIN_MANIFEST_FIELD } from "../model/Plugin";
import { parseJson, toJsonObject } from "../support/Json";
import { defineRule } from "./Types";

/** The `fabr_plugin` rule. */
export default defineRule({
  requirements(context) {
    return {
      extends: context.getPackageProperty("srcs"),
      libs: context.getFileProperty("libs"),
      resources: context.getFileProperty("resources"),
    };
  },
  evaluateMaterialized(context, { extends: srcs, libs, resources }) {
    const [base] = srcs;
    if (srcs.length !== 1 || !(base instanceof PackageFileSet)) {
      throw new FabrError(`a 'fabr_plugin' target's 'srcs' is one package, the plugin's code`);
    }
    const libNames = [...FileSet.unionAll(...libs)].map(([name]) => name).sort();
    const files = [...FileSet.unionAll(base, ...libs, ...resources)].filter(([name]) => name !== MANIFEST);
    return pluginManifest(base, context.name, libNames).then(
      manifest =>
        new PackageFileSet(new FileSet(new Map([...files, [MANIFEST, manifest]])), context.name, base.version, base.dependencies, base.origin, base.provided)
    );
  },
});

const MANIFEST = "package.json";

/** Make the base package's `package.json` named `name`, listing `libs` as the plugin's `.fabr` files. */
function pluginManifest(base: PackageFileSet, name: string, libs: string[]): Computable<IFile> {
  const file = base.getFile(MANIFEST);
  if (file === undefined) {
    throw new FabrError(`a 'fabr_plugin' target's 'srcs' is a package with a ${MANIFEST}`);
  }
  return file.readString().then(text => {
    const manifest = { ...parseJson(text, MANIFEST, toJsonObject), name, [PLUGIN_MANIFEST_FIELD]: { libs } };
    return MemoryFile.from(JSON.stringify(manifest, undefined, 2) + "\n");
  });
}
