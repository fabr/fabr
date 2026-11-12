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
 * Describing a Java target for an editor (see core's Description): as BSP's
 * `jvm` target, its `javacOptions` naming the classpath's jars, which the
 * description lays out, and the Java release it compiles for. A required
 * package that is itself described adds no jar: it appears as the target that
 * builds it, among the target's dependencies.
 */

import { Computable, describeTarget, descriptionFile, FileSet, ResolvedRequirements, TargetContext } from "@fabr-build/core";
import { classpathOf, javaRelease, stagedJars } from "./JarPackage";

/** BSP's `dataKind` of a JVM target. */
export const JVM_DATA_KIND = "jvm";

/** Where a description lays out the classpath's jars. */
const CLASSPATH_DIR = "classpath";

/** The class directory a description names. Nothing writes it: an editor's compiler keeps its own output. */
const CLASS_DIRECTORY = "classes/";

/** What a Java target is described as compiling. */
export interface IJavaUnit {
  /** The Java sources. */
  sources: FileSet;
  /** What they are compiled against, described where a target builds them. */
  deps: FileSet[];
  /** BSP's tags. */
  tags: string[];
}

/**
 * Describe the Java target `context` evaluates, compiling `unit`, with
 * `resolved` its rule's requirements.
 */
export function describeJava(context: TargetContext, resolved: ResolvedRequirements, unit: IJavaUnit): Computable<FileSet> {
  return context.getGlobalString("JVM_TARGET").then(jvmTarget => {
    const release = String(javaRelease(jvmTarget, unit.deps));
    const jars = classpathOf(unit.deps);
    return describeTarget(context, resolved, {
      sources: [unit.sources],
      tags: unit.tags,
      languageIds: ["java"],
      dataKind: JVM_DATA_KIND,
      /* BSP's `JvmBuildTarget`. */
      data: { javaVersion: release },
      javacOptions: {
        options: ["--release", release, "-encoding", "UTF-8"],
        classpath: jars.map(([name]) => `${CLASSPATH_DIR}/${name}`),
        classDirectory: CLASS_DIRECTORY,
      },
    }).then(description => FileSet.unionAll(descriptionFile(description), stagedJars(CLASSPATH_DIR, jars)));
  });
}
