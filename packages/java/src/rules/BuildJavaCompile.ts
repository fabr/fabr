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
 * The java_compile rule: compile Java sources to class files with `JAVAC`,
 * against the classpath its `deps` make (the module path, for sources that
 * are a named module), for the release {@link javaRelease} chooses. The
 * annotation processors its `processors` name run, from a classpath of their
 * own; with none, annotation processing is off. It yields the classes under
 * `classes/` and the sources the processors generate under `generated/`, and
 * with no sources nothing.
 */

import * as path from "path";
import {
  Computable,
  createExecAction,
  EMPTY_FILESET,
  defineRule,
  FabrError,
  FileSet,
  IFile,
  MemoryFile,
  RuleResult,
  TargetContext,
  TREE_MOUNT,
} from "@fabr-build/core";
import {
  classpathOf,
  COMPILED_CLASSES_DIR,
  GENERATED_SOURCES_DIR,
  javaRelease,
  pathOption,
  placedJars,
  processorsOf,
  quotedArgument,
  stagedJars,
} from "../JarPackage";

/** The `java_compile` rule. */
export default defineRule({
  requirements(context) {
    return {
      srcs: context.getFileProperty("srcs"),
      deps: context.getPackageProperty("deps"),
    };
  },
  evaluateMaterialized(context, inputs) {
    return compileJava(context, inputs);
  },
});

/** Where the sources are staged. */
const SOURCE_DIR = "src";
/** Where the classpath's jars are staged. */
const CLASSPATH_DIR = ".classpath";
/** Where the annotation processors' jars are staged. */
const PROCESSOR_PATH_DIR = ".processorpath";
/** The argument file the compiler reads its arguments from. */
const ARGUMENTS_FILE = ".fabr-javac.args";


function compileJava(context: TargetContext, { srcs, deps }: { srcs: FileSet[]; deps: FileSet[] }): Computable<RuleResult> {
  const sources = FileSet.unionAll(...srcs);
  const notJava = [...sources].map(([name]) => name).filter(name => !name.endsWith(".java"));
  if (notJava.length > 0) {
    throw new FabrError(`java_compile compiles .java sources only, and was given ${notJava.join(", ")}`);
  }
  if (sources.isEmpty()) {
    return Computable.resolve(EMPTY_FILESET);
  }
  const jars = classpathOf(deps);
  const placed = placedJars(sources, jars);
  const processors = processorsOf(context).then(classpathOf);
  return Computable.forAll([context.getGlobalString("JVM_TARGET"), context.getGlobalRunnable("JAVAC"), processors, placed], (jvmTarget, javac, processorPath, { modulePath, classpath }) => {
    const release = javaRelease(jvmTarget, deps);
    const pool = context.execution.buildCache;
    return pool.ensureTree(javac).then(() => {
      const argumentsText = [
        "--release",
        String(release),
        "-encoding",
        "UTF-8",
        ...(processorPath.length === 0 ? ["-proc:none"] : pathOption("-processorpath", PROCESSOR_PATH_DIR, processorPath)),
        "-implicit:none",
        "-d",
        COMPILED_CLASSES_DIR,
        "-s",
        GENERATED_SOURCES_DIR,
        ...pathOption("--module-path", CLASSPATH_DIR, modulePath),
        ...pathOption("-classpath", CLASSPATH_DIR, classpath),
        ...[...sources].map(([name]) => path.posix.join(SOURCE_DIR, name)).sort(),
      ]
        .map(quotedArgument)
        .join("\n");
      const files = FileSet.unionAll(
        sources.mountedAt(SOURCE_DIR),
        stagedJars(CLASSPATH_DIR, jars),
        stagedJars(PROCESSOR_PATH_DIR, processorPath),
        new FileSet(new Map<string, IFile>([[ARGUMENTS_FILE, MemoryFile.from(argumentsText)], [TREE_MOUNT, pool.treePoolLink]]))
      );
      const argv = javac.toCommandLine([`@${ARGUMENTS_FILE}`], { base: path.posix.join(TREE_MOUNT, javac.toManifestHash()) });
      return createExecAction(files, argv, [`${COMPILED_CLASSES_DIR}/**`, `${GENERATED_SOURCES_DIR}/**`]);
    });
  });
}
