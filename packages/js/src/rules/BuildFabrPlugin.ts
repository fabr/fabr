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

import {
  Computable,
  DESCRIPTION_EXTENDS,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  FileSetRef,
  PackageFileSet,
  RequiredSources,
  defineRule,
  describeTarget,
  descriptionFile,
  pluginLibsOf,
  pluginPackageJson,
} from "@fabr-build/core";
import jsPackage from "./BuildJSPackage";

const MANIFEST = "package.json";

/** The `fabr_plugin` rule, under `build`: the plugin built as the `js_package` it is, with its `.fabr` files laid in and its `package.json` naming them. */
export default defineRule({
  requirements(context) {
    const stated = jsPackage.requirements!(context);
    return (stated instanceof Computable ? stated : Computable.resolve(stated)).then(spec => ({
      ...spec,
      build: {
        ...(Object.fromEntries(spec.build instanceof Map ? spec.build : Object.entries(spec.build ?? {})) as Record<string, RequiredSources>),
        libs: context.getFileProperty("libs"),
        optional_libs: context.getFileProperty("optional_libs"),
      },
    }));
  },
  evaluateResolved(context, requirements) {
    return Computable.forAll(
      [jsPackage.evaluate(context, requirements), requirements.materialize("libs").then(filesOf), requirements.materialize("optional_libs").then(filesOf)],
      (built, libs, optionalLibs) => {
        if (!(built instanceof PackageFileSet)) {
          throw new FabrError(`internal: js_package[build] did not build a package for '${context.name}'`);
        }
        const files = [...FileSet.unionAll(built, ...libs, ...optionalLibs)].filter(([name]) => name !== MANIFEST);
        return pluginPackageJson(built.getFile(MANIFEST), context.name, pluginLibsOf(libs, optionalLibs)).then(
          manifest =>
            new PackageFileSet(new FileSet(new Map([...files, [MANIFEST, manifest]])), built.packageName, built.version, built.dependencies, built.origin, built.provided)
        );
      }
    );
  },
  /* Describe the plugin by its `.fabr` files, and the package it is built as under `extends`. */
  describe(context, requirements) {
    return Computable.forAll(
      [jsPackage.describe!(context, requirements), requirements.describeAll()],
      (code, { libs, optional_libs: optionalLibs }) =>
        describeTarget(context, requirements.resolved, { sources: [...filesOf(libs), ...filesOf(optionalLibs)] }).then(description =>
          FileSet.unionAll(descriptionFile(description), code instanceof FileSet ? FileSet.layout({ [DESCRIPTION_EXTENDS]: code }) : EMPTY_FILESET)
        )
    );
  },
});

/** @return the file sets among `sources`: `libs` and `optional_libs` are read for their files. */
function filesOf(sources: Array<FileSet | FileSetRef>): FileSet[] {
  return sources.filter((source): source is FileSet => source instanceof FileSet);
}
