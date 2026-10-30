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
 * The jar_package[test] rule: compile the tests against the package's own jar,
 * and run the test classes they compile to on the JUnit Platform with
 * `JAVA_TEST_RUNNER`, which finds them itself, with the jar and everything it
 * and the tests require on the classpath, the platform's launcher among them.
 */

import * as path from "path";
import { BUILD_OVERRIDE, Computable, defineRule, EMPTY_FILESET, FabrError, FileSet, IFile, MemoryFile, RuleResult, TargetContext, TREE_MOUNT } from "@fabr-build/core";
import { classpathOf, compileOutputOf, COMPILED_CLASSES_DIR, packageOf, processorsOf } from "../JarPackage";
import { createTestRunAction } from "../TestRunAction";

interface TestInputs {
  pkg: FileSet[];
  tests: FileSet[];
  test_resources: FileSet[];
  provided: FileSet[];
  optional_provided: FileSet[];
  compile_deps: FileSet[];
  test_deps: FileSet[];
}

/** The `jar_package` rule, under `test`. */
export default defineRule({
  /* The package under test is its own build. */
  requirements(context) {
    return {
      requirements: {
        pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE),
        tests: context.getFileProperty("tests"),
        test_resources: context.getFileProperty("test_resources"),
        provided: context.getPackageProperty("provided_deps"),
        optional_provided: context.getPackageProperty("optional_provided_deps"),
        compile_deps: context.getPackageProperty("compile_deps"),
        test_deps: context.getPackageProperty("test_deps"),
      },
    };
  },
  evaluateMaterialized(context, inputs) {
    return testJar(context, inputs);
  },
});

/** Where the compiled test classes are staged, which the runner searches for tests. */
const TEST_CLASSES_DIR = "test-classes";
/** Where the test resources are staged. */
const TEST_RESOURCES_DIR = "test-resources";
/** Where the classpath's jars are staged. */
const CLASSPATH_DIR = ".classpath";
/** The runner's jar. */
const RUNNER_JAR = ".fabr-junit-runner.jar";
/** The class → source path table the runner names results by. */
const SOURCES_FILE = ".fabr-test-sources";
/** The runner's main class. */
const RUNNER_CLASS = "build.fabr.junit.Runner";

function testJar(context: TargetContext, inputs: TestInputs): Computable<RuleResult> {
  const tests = FileSet.unionAll(...inputs.tests);
  if (tests.isEmpty()) {
    /* No tests declared: trivially green, with nothing to run. */
    return Computable.resolve(EMPTY_FILESET);
  }
  const runtime = [...inputs.pkg, ...inputs.provided, ...inputs.optional_provided, ...inputs.test_deps];
  const classes = processorsOf(context).then(processors =>
    context.subTarget(
      "java_compile",
      { srcs: tests, deps: [...runtime, ...inputs.compile_deps], ...(processors.length === 0 ? {} : { processors }) },
      { label: "Compiling tests for", constraints: BUILD_OVERRIDE }
    )
  );
  const runner = context
    .getGlobalFileProperty("JAVA_TEST_RUNNER", BUILD_OVERRIDE)
    .then(found => context.materializeSources(found))
    .then(found => {
      const file = FileSet.unionAll(...found.filter((source): source is FileSet => source instanceof FileSet)).getSingleFile();
      if (file === undefined) {
        throw new FabrError("JAVA_TEST_RUNNER names no single jar");
      }
      return file;
    });
  return Computable.forAll([classes, runner, sourcesTable(tests), context.getGlobalRunnable("JAVA")], (output, runnerJar, sources, java) => {
    const compiled = compileOutputOf(output, COMPILED_CLASSES_DIR);
    const pool = context.execution.buildCache;
    return pool.ensureTree(java).then(() => {
      const jars = classpathOf(runtime);
      const classpath = [TEST_CLASSES_DIR, TEST_RESOURCES_DIR, RUNNER_JAR, ...jars.map(([name]) => path.posix.join(CLASSPATH_DIR, name))].join(path.delimiter);
      const staged = FileSet.unionAll(
        compiled.mountedAt(TEST_CLASSES_DIR),
        FileSet.unionAll(...inputs.test_resources).mountedAt(TEST_RESOURCES_DIR),
        new FileSet(new Map(jars.map(([name, file]): [string, IFile] => [path.posix.join(CLASSPATH_DIR, name), file]))),
        new FileSet(
          new Map<string, IFile>([
            [RUNNER_JAR, runnerJar],
            [SOURCES_FILE, MemoryFile.from(sources)],
            [TREE_MOUNT, pool.treePoolLink],
          ])
        )
      );
      const argv = java.toCommandLine(["-cp", classpath, RUNNER_CLASS, `--sources=${SOURCES_FILE}`, `--scan=${TEST_CLASSES_DIR}`], {
        base: path.posix.join(TREE_MOUNT, java.toManifestHash()),
      });
      return createTestRunAction(staged, argv);
    });
  });
}

/**
 * Make the table the runner names results by: a line per test source, the
 * class it declares (its package and file name) and its source path.
 */
function sourcesTable(tests: FileSet): Computable<string> {
  const names = [...tests].map(([name]) => name).sort();
  return Computable.forAll(
    names.map(name => tests.getFile(name)!.readString()),
    (...texts) =>
      names
        .map((name, index) => {
          const declared = packageOf(texts[index]);
          const className = path.posix.basename(name, ".java");
          const sourcePath = (tests.sourcePathOf(name) ?? name).replace(/^\.\//, "");
          return `${declared === "" ? className : `${declared}.${className}`}\t${sourcePath}\n`;
        })
        .join("")
  );
}
