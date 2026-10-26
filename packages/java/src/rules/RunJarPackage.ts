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
 * The jar_package[run] rule: run the package's `entry` class on `JAVA`, with
 * the package and everything it requires on the classpath (see
 * {@link makeJarRunnable}).
 */

import { BUILD_OPERATION, BUILD_OVERRIDE, Computable, defineRule, FabrError, FileSet, PackageFileSet, RuleDefinition, RunnableFileSet, TargetContext } from "@fabr-build/core";
import { mainClassOf, makeJarRunnable } from "../JarPackage";

function runnableJar(context: TargetContext, pkg: FileSet[], entry: FileSet[]): Computable<RunnableFileSet> {
  const built = pkg.find((source): source is PackageFileSet => source instanceof PackageFileSet);
  if (!built) {
    throw new FabrError("internal: jar_package[build] did not yield a package");
  }
  const mainClass = mainClassOf(entry);
  if (mainClass === undefined) {
    throw new FabrError(`${context.name} has no entry, so it cannot be run`).withHelp("set `entry` to the source of the class the program starts in");
  }
  return makeJarRunnable(context, built, mainClass);
}

export const runJarPackageRule: RuleDefinition = defineRule({
  type: "jar_package",
  properties: { [BUILD_OPERATION]: "run" },
  requirements: context => ({ pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE), entry: context.getFileProperty("entry") }),
  evaluateMaterialized: (context, { pkg, entry }) => runnableJar(context, pkg, entry),
});
