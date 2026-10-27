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
 * The `fabr_plugin` target as a program: the plugin package (its base package,
 * `srcs`, with its `libs` and `resources` and its plugin `package.json`)
 * installed with the base package's closure, for the host. This is what fabr
 * loads the plugin's code from, so its rules find its files as an installed
 * plugin's do.
 */

import * as path from "node:path";

import { FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { SymlinkFile } from "../core/SymlinkFile";
import { BUILD_OVERRIDE } from "../model/Constraints";
import { MANIFEST, pluginPackageJson } from "../model/Plugin";
import { defineRule } from "./Types";

/** The `fabr_plugin` rule, under `run`. */
export default defineRule({
  requirements(context) {
    return { libs: context.getFileProperty("libs", BUILD_OVERRIDE), resources: context.getFileProperty("resources", BUILD_OVERRIDE) };
  },
  evaluateMaterialized(context, { libs, resources }) {
    return context.getRunnableProperty("srcs").then(code => {
      const directory = packageDirectory(code);
      const manifestName = path.posix.join(directory, MANIFEST);
      const libNames = [...FileSet.unionAll(...libs)].map(([name]) => name).sort();
      return pluginPackageJson(code.getFile(manifestName), context.name, libNames).then(manifest => {
        const added = FileSet.unionAll(...libs, ...resources, new FileSet(new Map([[MANIFEST, manifest]])));
        const install = FileSet.unionAll(code.remap(name => (name === manifestName ? undefined : name)), added.mountedAt(directory));
        return new RunnableFileSet(
          install,
          code.args,
          code.interpreter,
          code.root,
          code.surface,
          code.served,
          code.launchCwd,
          code.env,
          code.origin,
          code.interpreterArgs
        );
      });
    });
  },
});

/** @return the directory the package `code` runs is laid out in within its install: its root, following the links that lead there. */
function packageDirectory(code: RunnableFileSet): string {
  let directory = code.root;
  for (let file = code.getFile(directory); file instanceof SymlinkFile; file = code.getFile(directory)) {
    directory = path.posix.normalize(path.posix.join(path.posix.dirname(directory), file.target));
  }
  return directory;
}
