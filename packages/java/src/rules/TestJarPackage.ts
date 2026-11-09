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
 * Under `COVERAGE=on` the JVM runs with `JACOCO_AGENT`, and the runner writes
 * the coverage of the package's own jar as lcov, beside the report.
 */

import * as path from "path";
import {
  BUILD_OVERRIDE,
  Computable,
  COVERAGE,
  COVERAGE_ON,
  COVERAGE_REPORT_FILENAME,
  defineRule,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  IFile,
  MemoryFile,
  PackageFileSet,
  PERMISSIVE_RESOLUTION,
  RuleResult,
  TargetContext,
  TEST_NAME_PATTERN,
  TREE_MOUNT,
} from "@fabr-build/core";
import { classpathOf, compileOutputOf, COMPILED_CLASSES_DIR, packageOf, processorsOf } from "../JarPackage";
import { describeJava } from "../Description";
import { createTestRunAction } from "../TestRunAction";
import { MAVEN_FORMAT } from "../MavenProtocol";

interface TestInputs {
  pkg: FileSet[];
  srcs: FileSet[];
  tests: FileSet[];
  test_resources: FileSet[];
  provided: FileSet[];
  optional_provided: FileSet[];
  compile_deps: FileSet[];
  test_deps: FileSet[];
  run_pkg: FileSet[];
  run_provided: FileSet[];
  run_optional_provided: FileSet[];
  run_test_deps: FileSet[];
}

/** The `jar_package` rule, under `test`. */
export default defineRule({
  /* The package under test is its own build. The tests are compiled against
   * the packages as `build` resolves them, and run with them as `run` does. */
  requirements(context) {
    return {
      build: {
        pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE),
        srcs: context.getFileProperty("srcs", BUILD_OVERRIDE),
        tests: context.getFileProperty("tests", BUILD_OVERRIDE),
        test_resources: context.getFileProperty("test_resources", BUILD_OVERRIDE),
        provided: context.getPackageProperty("provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        optional_provided: context.getPackageProperty("optional_provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        compile_deps: context.getPackageProperty("compile_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        test_deps: context.getPackageProperty("test_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
      },
      run: {
        run_pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE),
        run_provided: context.getPackageProperty("provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        run_optional_provided: context.getPackageProperty("optional_provided_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
        run_test_deps: context.getPackageProperty("test_deps", BUILD_OVERRIDE, MAVEN_FORMAT),
      },
    };
  },
  evaluateMaterialized(context, inputs) {
    return testJar(context, inputs);
  },
  /* Describe the tests as an editor compiles them: against the package's own build, as the run does. */
  describe(context, requirements) {
    return requirements.describeAll().then(inputs => {
      const tests = FileSet.unionAll(...inputs.tests);
      return tests.isEmpty()
        ? EMPTY_FILESET
        : describeJava(context, requirements.resolved, {
            sources: tests,
            deps: [...inputs.pkg, ...inputs.provided, ...inputs.optional_provided, ...inputs.test_deps, ...inputs.compile_deps],
            tags: ["test"],
          });
    });
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
/** Where a measured run's JaCoCo agent and analysis libraries are staged. */
const COVERAGE_DIR = ".coverage";

function testJar(context: TargetContext, inputs: TestInputs): Computable<RuleResult> {
  const tests = FileSet.unionAll(...inputs.tests);
  if (tests.isEmpty()) {
    /* No tests declared: trivially green, with nothing to run. */
    return Computable.resolve(EMPTY_FILESET);
  }
  const runtime = [...inputs.run_pkg, ...inputs.run_provided, ...inputs.run_optional_provided, ...inputs.run_test_deps];
  const compile = [...inputs.pkg, ...inputs.provided, ...inputs.optional_provided, ...inputs.test_deps, ...inputs.compile_deps];
  const classes = processorsOf(context).then(processors =>
    context.subTarget(
      "java_compile",
      { srcs: tests, deps: compile, ...(processors.length === 0 ? {} : { processors }) },
      { label: "Compiling tests for", constraints: BUILD_OVERRIDE }
    )
  );
  const runner = singleJar(context, "JAVA_TEST_RUNNER");
  const namePattern = context.getGlobalString(TEST_NAME_PATTERN);
  const measuring = context.getGlobalString(COVERAGE).then(coverage => (coverage === COVERAGE_ON ? coverageTools(context) : undefined));
  const sourceSets = [tests, ...inputs.srcs];
  return Computable.forAll(
    [classes, runner, sourcesTable(sourceSets), context.getGlobalRunnable("JAVA"), namePattern, measuring, measuredPackages(inputs.srcs)],
    (output, runnerJar, sources, java, pattern, tools, packages) => {
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
          ])
        )
      );
      const selection = pattern === "" ? [] : [`--name-pattern=${pattern}`];
      const measured = tools && measuredRun(tools, ownJars(inputs.run_pkg), packages);
      const argv = java.toCommandLine(
        [...(measured?.jvm ?? []), "-cp", classpath, RUNNER_CLASS, `--sources=${SOURCES_FILE}`, ...selection, ...(measured?.runner ?? []), `--scan=${TEST_CLASSES_DIR}`],
        { base: path.posix.join(TREE_MOUNT, java.toManifestHash()) }
      );
      return createTestRunAction(FileSet.unionAll(staged, measured?.staged ?? EMPTY_FILESET), argv, measured !== undefined);
    });
    }
  );
}

/** Materialize the global `name` names, under `build`, as the one jar it must be. */
function singleJar(context: TargetContext, name: string): Computable<IFile> {
  return context
    .getGlobalFileProperty(name, BUILD_OVERRIDE)
    .then(found => context.materializeSources(found))
    .then(found => {
      const file = FileSet.unionAll(...found.filter((source): source is FileSet => source instanceof FileSet)).getSingleFile();
      if (file === undefined) {
        throw new FabrError(`${name} names no single jar`);
      }
      return file;
    });
}

/** What a measured run needs: JaCoCo's agent jar, and its analysis libraries' classpath. */
interface ICoverageTools {
  agent: IFile;
  analysis: Array<[string, IFile]>;
}

/** Materialize `JACOCO_AGENT` and `JACOCO`, a tool's packages, resolved permissively. */
function coverageTools(context: TargetContext): Computable<ICoverageTools> {
  const analysis = context
    .getGlobalFileProperty("JACOCO", BUILD_OVERRIDE)
    .then(found => context.materializeSources(found, PERMISSIVE_RESOLUTION))
    .then(found => classpathOf(found.filter((source): source is FileSet => source instanceof FileSet)));
  return Computable.forAll([singleJar(context, "JACOCO_AGENT"), analysis], (agent, jars) => ({ agent, analysis: jars }));
}

/**
 * Stage what a measured run adds, and make its JVM and runner options: the
 * agent instruments the classes of the packages the sources declare, keeping
 * what it records for the runner, which converts the coverage of `measured`
 * (staged jar paths) to {@link COVERAGE_REPORT_FILENAME}.
 */
function measuredRun(tools: ICoverageTools, measured: string[], packages: string[]): { staged: FileSet; jvm: string[]; runner: string[] } {
  const agent = path.posix.join(COVERAGE_DIR, "jacocoagent.jar");
  const analysis = tools.analysis.map(([name, file]): [string, IFile] => [path.posix.join(COVERAGE_DIR, name), file]);
  const includes = packages.includes("") ? "*" : packages.map(name => `${name}.*`).join(":");
  return {
    staged: new FileSet(new Map<string, IFile>([[agent, tools.agent], ...analysis])),
    jvm: [`-javaagent:${agent}=output=none,includes=${includes}`],
    runner: [
      `--coverage=${COVERAGE_REPORT_FILENAME}`,
      `--coverage-classpath=${analysis.map(([name]) => name).join(path.delimiter)}`,
      ...measured.map(jar => `--measure=${jar}`),
    ],
  };
}

/** @return the staged paths of the package under test's own jars, as {@link classpathOf} names them. */
function ownJars(pkg: readonly FileSet[]): string[] {
  return pkg
    .filter((files): files is PackageFileSet => files instanceof PackageFileSet)
    .flatMap(files => [...files].map(([name]) => name).filter(name => name.endsWith(".jar")).map(name => path.posix.join(CLASSPATH_DIR, files.packageName ?? "", name)));
}

/** @return the Java packages the sources declare, sorted, "" for the unnamed package. */
function measuredPackages(srcs: readonly FileSet[]): Computable<string[]> {
  const files = srcs.flatMap(set => [...set].filter(([name]) => name.endsWith(".java")).map(([, file]) => file));
  return Computable.forAll(
    files.map(file => file.readString()),
    (...texts) => [...new Set(texts.map(packageOf))].sort()
  );
}

/**
 * Make the table the runner names results and coverage by: a line per Java
 * source, its path within its package tree (`com/x/Foo.java`, from its package
 * declaration and file name) and its source path, sorted.
 */
function sourcesTable(sets: readonly FileSet[]): Computable<string> {
  const sources = sets.flatMap(set => [...set].filter(([name]) => name.endsWith(".java")).map(([name, file]) => ({ set, name, file })));
  return Computable.forAll(
    sources.map(({ file }) => file.readString()),
    (...texts) =>
      [
        ...new Set(
          sources.map(({ set, name }, index) => {
            const declared = packageOf(texts[index]).replace(/\./g, "/");
            const fileName = path.posix.basename(name);
            const sourcePath = (set.sourcePathOf(name) ?? name).replace(/^\.\//, "");
            return `${declared === "" ? fileName : `${declared}/${fileName}`}\t${sourcePath}\n`;
          })
        ),
      ]
        .sort()
        .join("")
  );
}
