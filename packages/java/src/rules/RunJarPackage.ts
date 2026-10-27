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
 * The jar_package[run] rule: run the package's `main_class` on `JAVA`, with
 * the package and everything it requires on the classpath (see
 * {@link makeJarRunnable}).
 */

import { BUILD_OVERRIDE, Computable, defineRule, FabrError, FileSet, PackageFileSet, RunnableFileSet, TargetContext } from "@fabr-build/core";
import { jarMainClass, makeJarRunnable } from "../JarPackage";

/** The `jar_package` rule, under `run`. */
export default defineRule({
  requirements(context) {
    return { pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE), agents: context.getPackageProperty("agents", BUILD_OVERRIDE) };
  },
  evaluateMaterialized(context, { pkg, agents }) {
    return context.getProperty("main_class").then(mainClass => runnableJar(context, pkg, agents, mainClass?.toString()));
  },
});

function runnableJar(context: TargetContext, pkg: FileSet[], agents: FileSet[], mainClass: string | undefined): Computable<RunnableFileSet> {
  const built = pkg.find((source): source is PackageFileSet => source instanceof PackageFileSet);
  if (!built) {
    throw new FabrError("internal: jar_package[build] did not yield a package");
  }
  /* Where main_class is not given, the manifest may name the class (`manifest = { Main-Class = … }`). */
  return (mainClass === undefined ? jarMainClass(built) : Computable.resolve(mainClass)).then(start => {
    if (start === undefined) {
      throw new FabrError(`${context.name} has no main_class, so it cannot be run`).withHelp("set `main_class` to the class the program starts in");
    }
    return makeJarRunnable(context, [built], start, { agents });
  });
}
