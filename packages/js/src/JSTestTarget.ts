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
 * The JS test rules:
 *
 *  - js_test [BUILD_OPERATION=test]: compile srcs against deps and run the
 *    *.test.* files under the runner.
 *  - js_package [BUILD_OPERATION=test]: in-package test sugar — the tests
 *    property is compiled together with the package's own source tree (so
 *    relative imports resolve) and run against the package's deps.
 *
 * The runner (JS_TEST_RUNNER, normally the built @fabr/js package itself)
 * executes standalone inside the test working directory and reports through
 * the test report contract defined by @fabr/core.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  BUILD_OPERATION,
  Computable,
  Constraints,
  EMPTY_FILESET,
  execute,
  FileSet,
  findExecutable,
  Flag,
  formatTestFailures,
  getResultFileSet,
  ITestReport,
  MemoryFile,
  PackageFileSet,
  registerTargetRule,
  TargetContext,
  TEST_REPORT_FILENAME,
  TestsFailedError,
  writeFileSet,
} from "@fabr/core";
import {
  assembleNodeModules,
  compileJsSources,
  ICompiledSources,
  JSTarget,
  parseJSTarget,
  stripPackageJson,
} from "./JSPackageTarget";

/** Test files are conventionally named *.test.ts (or .tsx) */
const TEST_FILE_PATTERN = /\.test\.tsx?$/;
/** Compilable sources (the runner executes their compiled .js) */
const TS_FILE_PATTERN = /\.tsx?$/;

/* The runner-package convention (see packages/js/src/testRunner/): the entry
 * point the rule executes, and the ambient type declarations matching the
 * globals the runner preloads into test processes. */
const RUNNER_ENTRY = "testRunner/runner.js";
const RUNNER_GLOBALS_TYPES = "testRunner/test-globals.d.ts";
/** Where the globals declarations are mounted so tsc auto-includes them */
const GLOBALS_TYPES_MOUNT = "@types/fabr-test-globals/index.d.ts";

/**
 * Everything a test rule consumes is explicitly resolved under
 * BUILD_OPERATION=build: the test constraint exists to select the rule for the
 * target itself, and must not propagate into its dependencies.
 */
const BUILD_OP: Constraints = { [BUILD_OPERATION]: "build" };

function testJsPackage(context: TargetContext): Computable<FileSet> {
  return Computable.forAll(
    [
      context.getFileSet("srcs", BUILD_OP),
      context.getFileSets("deps", BUILD_OP),
      context.getFlags("deps", BUILD_OP),
      context.getFileSet("tests", BUILD_OP),
      context.getGlobalString("JS_TARGET", BUILD_OP),
      context.getFileSets("test_deps", BUILD_OP),
    ],
    (sources, deps, flags, tests, target, testDeps) =>
      compileAndRunTests(context, { sources, tests, deps, flags, target, testDeps })
  );
}

function runJsTest(context: TargetContext): Computable<FileSet> {
  return Computable.forAll(
    [
      context.getFileSet("srcs", BUILD_OP),
      context.getFileSets("deps", BUILD_OP),
      context.getFlags("deps", BUILD_OP),
      context.getGlobalString("JS_TARGET", BUILD_OP),
    ],
    (sources, deps, flags, target) => {
      const tests = sources.remap(name => (TEST_FILE_PATTERN.test(name) ? name : undefined));
      return compileAndRunTests(context, { sources, tests, deps, flags, target, testDeps: [] });
    }
  );
}

/**
 * The runner provides describe/it/... as globals at run time (see
 * testRunner/globals.ts); its test-globals.d.ts carries the matching ambient
 * types. Mount it as a synthetic @types package so the compiler auto-includes
 * it for the test compile. (A runner without the file contributes nothing.)
 */
function runnerGlobalsTypes(runner: PackageFileSet): FileSet {
  return runner.remap(name => (name === RUNNER_GLOBALS_TYPES ? GLOBALS_TYPES_MOUNT : undefined));
}

interface ITestInputs {
  sources: FileSet;
  tests: FileSet;
  deps: FileSet[];
  flags: Flag[];
  target: string;
  /** Test-only packages (assertion libraries and their @types), available to
   * both the test compile and the test run but never to the package build */
  testDeps: FileSet[];
}

/**
 * The shared test pipeline: compile the whole source tree (tests included, so
 * their relative imports resolve against the code under test), lay it out as
 * a runnable installation together with the deps, the test-only deps and the
 * runner, and execute the runner over the compiled test files. The output
 * artifact is the test report; a red run fails the target with the report's
 * failure summary.
 */
function compileAndRunTests(context: TargetContext, inputs: ITestInputs): Computable<FileSet> {
  const testFiles = compiledTestFiles(inputs.tests);
  if (testFiles.length === 0) {
    /* Nothing to run is trivially green (and no runner is needed) */
    return Computable.resolve(EMPTY_FILESET);
  }
  return getRunner(context).then(runner => {
    const jsTarget = parseJSTarget(inputs.target);
    const compileModules = assembleNodeModules([...inputs.deps, ...inputs.testDeps, runnerGlobalsTypes(runner)]);
    const runtimeModules = assembleNodeModules([...inputs.deps, ...inputs.testDeps, runner]);
    /* Compile srcs and tests together (tests are normally within srcs); the
     * globals declarations come in via the synthetic @types mount, so a copy
     * among the sources (the runner package testing itself) is dropped */
    const sources = FileSet.unionAll(inputs.sources, inputs.tests).remap(name =>
      name === RUNNER_GLOBALS_TYPES ? undefined : name
    );
    return compileJsSources(context, sources, compileModules, jsTarget, inputs.flags, BUILD_OP).then(compiled =>
      executeTests(context, compiled, runtimeModules, runner, testFiles, jsTarget)
    );
  });
}

/** @return the compiled (.js) names of the given test sources, sorted for determinism */
function compiledTestFiles(tests: FileSet): string[] {
  return [...tests]
    .map(([name]) => name)
    .filter(name => TS_FILE_PATTERN.test(name) && !name.endsWith(".d.ts"))
    .map(name => name.replace(TS_FILE_PATTERN, ".js"))
    .sort();
}

/**
 * @return the runner package: the target's runner property if given, falling
 * back to the JS_TEST_RUNNER global (js_package has no runner property, so
 * the in-package sugar always uses the global).
 */
function getRunner(context: TargetContext): Computable<PackageFileSet> {
  return context
    .getFileSets("runner", BUILD_OP)
    .then(sets => runnerFromProperty(sets) ?? runnerFromGlobal(context));
}

function runnerFromProperty(sets: FileSet[]): PackageFileSet | undefined {
  const pkg = sets.find((set): set is PackageFileSet => set instanceof PackageFileSet);
  if (!pkg && sets.length > 0) {
    throw new Error("The runner property must name a built package");
  }
  return pkg;
}

function runnerFromGlobal(context: TargetContext): Computable<PackageFileSet> {
  return context.getGlobalTarget("JS_TEST_RUNNER", BUILD_OP).then(sources => {
    const pkg = sources.find((source): source is PackageFileSet => source instanceof PackageFileSet);
    if (!pkg) {
      throw new Error("JS_TEST_RUNNER does not resolve to a built package (it should name the test runner, e.g. @fabr/js)");
    }
    return pkg;
  });
}

function executeTests(
  context: TargetContext,
  compiled: ICompiledSources,
  nodeModules: FileSet,
  runner: PackageFileSet,
  testFiles: string[],
  jsTarget: JSTarget
): Computable<FileSet> {
  return runner.get(RUNNER_ENTRY).then(entry => {
    if (!entry) {
      throw new Error(`Test runner package '${runner.packageName}' does not provide a ${RUNNER_ENTRY} entry point`);
    }
    /* The working directory is a complete installation: the compiled tree at
     * the root, the deps (including test-only deps and the runner) laid out
     * as node_modules, and a minimal package.json establishing the module
     * format */
    const packageJson = MemoryFile.from(
      JSON.stringify({ name: "fabr-test", private: true, type: jsTarget.module === "esm" ? "module" : "commonjs" })
    );
    const workingDir = FileSet.unionAll(
      FileSet.layout({
        node_modules: [nodeModules],
        "package.json": packageJson,
      }),
      compiled.compiled,
      stripPackageJson(compiled.copied)
    );
    const runnerEntry = path.join("node_modules", runner.packageName, RUNNER_ENTRY);
    const args = [runnerEntry, `--report=${TEST_REPORT_FILENAME}`, ...testFiles];
    /* The cache key covers the invocation as well as the staged files: which
     * tests run is part of what the cached green result attests to */
    const manifest = `${workingDir.toManifest()}\nrun node ${args.join(" ")}`;
    return context.getCachedOrBuild(manifest, targetDir =>
      writeFileSet(targetDir, workingDir)
        .then(() => execute(findExecutable("node"), args, targetDir, {}))
        .then(
          () => getResultFileSet(targetDir, TEST_REPORT_FILENAME),
          err => {
            throw toTestFailure(targetDir, err);
          }
        )
    );
  });
}

/**
 * A failed runner invocation is a test failure if it produced a report saying
 * so (rendered as the failure summary); otherwise the run itself broke and
 * the original execution error stands.
 */
function toTestFailure(targetDir: string, err: Error): Error {
  try {
    const content = fs.readFileSync(path.resolve(targetDir, TEST_REPORT_FILENAME), "utf8");
    const report = JSON.parse(content) as ITestReport;
    const summary = report.results?.summary;
    if (summary && summary.failed > 0) {
      return new TestsFailedError(formatTestFailures(report), summary.failed, summary.tests);
    }
  } catch {
    /* No readable report: fall through to the original error */
  }
  return err;
}

registerTargetRule("js_test", { [BUILD_OPERATION]: "test" }, runJsTest);
registerTargetRule("js_package", { [BUILD_OPERATION]: "test" }, testJsPackage);
