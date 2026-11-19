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
 * The test pipeline the Java test rules share (jar_package[test] and
 * java_test): compile the tests, and run the test classes they compile to on
 * the JUnit Platform with `JAVA_TEST_RUNNER`, which finds them itself, with
 * everything the tests require on the classpath, the platform's launcher among
 * them. The JVM runs with the target's system properties and JVM arguments,
 * and with only the environment it gives. Under `COVERAGE=on` the JVM runs
 * with `JACOCO_AGENT`, and the runner writes the coverage of the measured jars
 * as lcov, beside the report.
 */

import * as path from "path";
import {
  BUILD_OVERRIDE,
  Computable,
  COVERAGE,
  COVERAGE_ON,
  COVERAGE_REPORT_FILENAME,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  IFile,
  MemoryFile,
  PackageFileSet,
  PERMISSIVE_RESOLUTION,
  RuleResult,
  TargetContext,
  TEST_FLAKE_RETRIES,
  TEST_NAME_PATTERN,
  toEnvironment,
  toFlakeRetries,
  toTestStability,
  TREE_MOUNT,
} from "@fabr-build/core";
import { classpathOf, compileOutputOf, COMPILED_CLASSES_DIR, packageOf, processorsOf, toDefineOptions } from "./JarPackage";
import { createTestRunAction } from "./TestRunAction";

/** How a test target type names its settings: `test_jvm_args` on a jar_package, `jvm_args` on a java_test, and so on. */
export interface IJavaTestSettings {
  jvmArgsProperty: string;
  definesProperty: string;
  envProperty: string;
  stabilityProperty: string;
}

/** What a Java test run is made from. */
export interface IJavaTestInputs {
  tests: FileSet;
  /** The packages the tests are compiled against. */
  compile: FileSet[];
  /** The packages the tests run with. */
  runtime: FileSet[];
  /** Files on the classpath the tests run with. */
  resources: FileSet[];
  /** The source sets the results and coverage are named by: the tests', and those of what they test. */
  sources: FileSet[];
  /** What a measured run measures: the staged paths of the jars, and the Java
   *  packages whose classes are instrumented (every class where undefined).
   *  Nothing is measured where it is undefined. */
  measured?: { jars: string[]; packages?: Computable<string[]> };
}

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

/**
 * Make the test run's action: the tests compiled against `compile`, then run
 * by the runner over the compiled test classes, with `runtime` as the
 * classpath; nothing where no tests are declared.
 */
export function runJavaTests(context: TargetContext, settings: IJavaTestSettings, inputs: IJavaTestInputs): Computable<RuleResult> {
  const { tests, compile, runtime } = inputs;
  if (tests.isEmpty()) {
    /* No tests declared: trivially green, with nothing to run. */
    return Computable.resolve(EMPTY_FILESET);
  }
  const classes = processorsOf(context).then(processors =>
    context.subTarget(
      "java_compile",
      { srcs: tests, deps: compile, ...(processors.length === 0 ? {} : { processors }) },
      { label: "Compiling tests for", constraints: BUILD_OVERRIDE }
    )
  );
  const runner = singleJar(context, "JAVA_TEST_RUNNER");
  const namePattern = context.getGlobalString(TEST_NAME_PATTERN);
  const measuring = context.getGlobalString(COVERAGE).then(coverage =>
    coverage === COVERAGE_ON && inputs.measured !== undefined
      ? Computable.forAll([coverageTools(context), inputs.measured.packages ?? Computable.resolve(undefined)], (tools, packages) => ({
          tools,
          packages,
        }))
      : undefined
  );
  const jvmOptions = Computable.forAll(
    [context.getMap(settings.definesProperty).then(toDefineOptions), context.getProperty(settings.jvmArgsProperty)],
    (defines, jvmArgs) => [...defines, ...(jvmArgs?.getValues() ?? [])]
  );
  const stability = Computable.forAll(
    [context.getRequiredProperty(settings.stabilityProperty), context.getGlobalString(TEST_FLAKE_RETRIES)],
    (value, retries) => {
      const level = toTestStability(value.toString());
      return { retries: level === "flaky" ? toFlakeRetries(retries) : 0, uncached: level === "unstable" };
    }
  );
  return Computable.forAll(
    [
      classes,
      runner,
      sourcesTable(inputs.sources),
      context.getGlobalRunnable("JAVA"),
      namePattern,
      measuring,
      jvmOptions,
      context.getMap(settings.envProperty).then(toEnvironment),
      stability,
    ],
    (output, runnerJar, sources, java, pattern, coverage, jvm, env, trusted) => {
      const compiled = compileOutputOf(output, COMPILED_CLASSES_DIR);
      const pool = context.execution.buildCache;
      return pool.ensureTree(java).then(() => {
        const jars = classpathOf(runtime);
        const classpath = [
          TEST_CLASSES_DIR,
          TEST_RESOURCES_DIR,
          RUNNER_JAR,
          ...jars.map(([name]) => path.posix.join(CLASSPATH_DIR, name)),
        ].join(path.delimiter);
        const staged = FileSet.unionAll(
          compiled.mountedAt(TEST_CLASSES_DIR),
          FileSet.unionAll(...inputs.resources).mountedAt(TEST_RESOURCES_DIR),
          new FileSet(new Map(jars.map(([name, file]): [string, IFile] => [path.posix.join(CLASSPATH_DIR, name), file]))),
          new FileSet(
            new Map<string, IFile>([
              [RUNNER_JAR, runnerJar],
              [SOURCES_FILE, MemoryFile.from(sources)],
            ])
          )
        );
        const selection = pattern === "" ? [] : [`--name-pattern=${pattern}`];
        const measured = coverage && measuredRun(coverage.tools, inputs.measured!.jars, coverage.packages);
        const argv = java.toCommandLine(
          [
            ...(measured?.jvm ?? []),
            ...jvm,
            "-cp",
            classpath,
            RUNNER_CLASS,
            `--sources=${SOURCES_FILE}`,
            ...selection,
            ...(measured?.runner ?? []),
            `--scan=${TEST_CLASSES_DIR}`,
          ],
          { base: path.posix.join(TREE_MOUNT, java.toManifestHash()) }
        );
        return createTestRunAction(
          FileSet.unionAll(staged, measured?.staged ?? EMPTY_FILESET),
          argv,
          measured !== undefined,
          env,
          trusted
        );
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

/** Materialize `JACOCO_AGENT` and `JACOCO`, a tool's packages, resolved permissively for `run`. */
function coverageTools(context: TargetContext): Computable<ICoverageTools> {
  const analysis = context
    .getGlobalFileProperty("JACOCO", BUILD_OVERRIDE)
    .then(found => context.materializeSources(found, PERMISSIVE_RESOLUTION, "run"))
    .then(found => classpathOf(found.filter((source): source is FileSet => source instanceof FileSet)));
  return Computable.forAll([singleJar(context, "JACOCO_AGENT"), analysis], (agent, jars) => ({ agent, analysis: jars }));
}

/**
 * Stage what a measured run adds, and make its JVM and runner options: the
 * agent instruments the classes of `packages` (every class where undefined),
 * keeping what it records for the runner, which converts the coverage of
 * `measured` (staged jar paths) to {@link COVERAGE_REPORT_FILENAME}.
 */
function measuredRun(
  tools: ICoverageTools,
  measured: string[],
  packages: string[] | undefined
): { staged: FileSet; jvm: string[]; runner: string[] } {
  const agent = path.posix.join(COVERAGE_DIR, "jacocoagent.jar");
  const analysis = tools.analysis.map(([name, file]): [string, IFile] => [path.posix.join(COVERAGE_DIR, name), file]);
  const includes = packages === undefined || packages.includes("") ? "*" : packages.map(name => `${name}.*`).join(":");
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

/** @return the staged paths of the jars of the packages among `pkg`, as {@link classpathOf} names them. */
export function ownJars(pkg: readonly FileSet[]): string[] {
  return pkg
    .filter((files): files is PackageFileSet => files instanceof PackageFileSet)
    .flatMap(files =>
      [...files]
        .map(([name]) => name)
        .filter(name => name.endsWith(".jar"))
        .map(name => path.posix.join(CLASSPATH_DIR, files.packageName ?? "", name))
    );
}

/** @return the Java packages the sources declare, sorted, "" for the unnamed package. */
export function measuredPackages(srcs: readonly FileSet[]): Computable<string[]> {
  const files = srcs.flatMap(set => [...set].filter(([name]) => name.endsWith(".java")).map(([, file]) => file));
  return Computable.forAll(
    files.map(file => file.readString()),
    (...texts) => [...new Set(texts.map(packageOf))].sort()
  );
}

/**
 * Make the table the runner names results and coverage by: a line per Java
 * source, its path within its package tree (`com/x/Foo.java`, from its package
 * declaration and file name), a tab, and its source path (its name where it
 * has none), sorted and without duplicates.
 */
function sourcesTable(sets: readonly FileSet[]): Computable<string> {
  const sources = sets.flatMap(set =>
    [...set].filter(([name]) => name.endsWith(".java")).map(([name, file]) => ({ set, name, file }))
  );
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
