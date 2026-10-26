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
 * The Java plugin (`plugin @fabr-build/java;`): the `jar_package` and
 * `java_compile` rules, the `maven_repository` and `jdk_distribution`
 * repositories, and `JAVA.fabr`.
 */

import { getLibFile, PluginContribution } from "@fabr-build/core";
import { buildJarPackageRule } from "./rules/BuildJarPackage";
import { runJarPackageRule } from "./rules/RunJarPackage";
import { javaCompileRule } from "./rules/BuildJavaCompile";
import { mavenRepositoryRegistration } from "./MavenRepository";
import { jdkDistributionRegistration } from "./JdkDistribution";

export function activate(): PluginContribution {
  return {
    rules: [buildJarPackageRule, runJarPackageRule, javaCompileRule],
    repositories: [mavenRepositoryRegistration, jdkDistributionRegistration],
    includes: [getLibFile(__dirname, "JAVA.fabr")],
  };
}
