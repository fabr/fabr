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
 * The java_program rule: a program run on `JAVA`, its `srcs` compiled against
 * its `deps`, starting its `main_class`, with its own classes and everything
 * `deps` require on the classpath.
 */

import * as path from "path";
import {
  BUILD_OVERRIDE,
  Computable,
  defineRule,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  PackageFileSet,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import { checkMainClass, compileOutputOf, COMPILED_CLASSES_DIR, jarMainClass, makeJarRunnable, packageOf, processorsOf } from "../JarPackage";

interface ProgramInputs {
  srcs: FileSet[];
  deps: FileSet[];
  agents: FileSet[];
}

/** The `java_program` rule, under `run`. */
export default defineRule({
  /* Read under build rather than the run operation the rule is selected by. The
   * program is run and never compiled against, so its packages are collected
   * permissively, as a tool's are. */
  requirements(context) {
    return {
      requirements: {
        srcs: context.getFileProperty("srcs", BUILD_OVERRIDE),
        deps: context.getPackageProperty("deps", BUILD_OVERRIDE),
        agents: context.getPackageProperty("agents", BUILD_OVERRIDE),
      },
      permissive: true,
    };
  },
  evaluateMaterialized(context, inputs) {
    return Computable.forAll(
      [context.getProperty("main_class"), context.getProperty("args"), context.getProperty("jvm_args")],
      (mainClass, args, jvmArgs) =>
        runnableProgram(context, inputs, mainClass?.toString(), { args: args?.getValues() ?? [], jvmArgs: jvmArgs?.getValues() ?? [] })
    );
  },
});

function runnableProgram(
  context: TargetContext,
  { srcs, deps, agents }: ProgramInputs,
  stated: string | undefined,
  options: { args: string[]; jvmArgs: string[] }
): Computable<RunnableFileSet> {
  const sources = FileSet.unionAll(...srcs);
  const classes = sources.isEmpty()
    ? Computable.resolve(EMPTY_FILESET)
    : processorsOf(context).then(processors =>
        context.subTarget(
          "java_compile",
          { srcs: sources, deps, ...(processors.length === 0 ? {} : { processors }) },
          { label: "Compiling", constraints: BUILD_OVERRIDE }
        )
      );
  return classes.then(output => compileOutputOf(output, COMPILED_CLASSES_DIR)).then(compiled =>
    mainClassOf(context, stated, sources, compiled, deps).then(mainClass => makeJarRunnable(context, deps, mainClass, { classes: compiled, agents, ...options }))
  );
}

/**
 * @return the class the program starts in: the one stated, checked against
 * what it runs; else the class of its sole source; else, with no sources, the
 * `Main-Class` its sole package's jar names.
 */
function mainClassOf(context: TargetContext, stated: string | undefined, sources: FileSet, classes: FileSet, deps: FileSet[]): Computable<string> {
  if (stated !== undefined) {
    return checkMainClass(context.name, stated, classes, deps).then(() => stated);
  }
  const needed = (): never => {
    throw new FabrError(`${context.name} names no main class`).withHelp("set `main_class` to the class the program starts in");
  };
  const files = [...sources];
  if (files.length === 1) {
    const [[name, file]] = files;
    return file.readString().then(text => {
      const declared = packageOf(text);
      const className = path.posix.basename(name, ".java");
      return declared === "" ? className : `${declared}.${className}`;
    });
  }
  const packages = deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
  if (files.length === 0 && packages.length === 1) {
    return jarMainClass(packages[0]).then(mainClass => mainClass ?? needed());
  }
  return needed();
}
