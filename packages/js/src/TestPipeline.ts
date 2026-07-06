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
 * The shared test pipeline behind both js test rules (js_test and
 * js_package[test]): compile the source tree (tests included), assemble the
 * runnable installation, and run the runner over the compiled test files,
 * reporting through the test report contract defined by @fabr/core.
 *
 * The runner (JS_TEST_RUNNER, normally the built @fabr/js package itself)
 * executes standalone inside the test working directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  BUILD_OPERATION,
  BuildAction,
  Computable,
  Constraints,
  EMPTY_FILESET,
  BuildActionInputs,
  execute,
  FileSet,
  fileSetInput,
  findExecutable,
  Flag,
  formatTestFailures,
  getResultFileSet,
  IBuildActionDefinition,
  ITestReport,
  MemoryFile,
  PackageFileSet,
  TargetContext,
  RuleResult,
  SourceRef,
  stringListInput,
  TEST_REPORT_FILENAME,
  TestsFailedError,
  writeFileSet,
} from "@fabr/core";
import { assembleNodeModules, compileJsSources, hasTypescriptSources, JSTarget, parseJSTarget, stripPackageJson } from "./JSPackage";

/** Test files are conventionally named *.test.ts (or .tsx) */
export const TEST_FILE_PATTERN = /\.test\.tsx?$/;
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
export const BUILD_OP: Constraints = { [BUILD_OPERATION]: "build" };

export interface ITestInputs {
  sources: FileSet;
  tests: FileSet;
  flags: Flag[];
  target: string;
  /** The as-written (unmaterialized) dependency sources */
  depSources: SourceRef[];
  /** Test-only packages (assertion libraries and their @types), available to
   * both the test compile and the test run but never to the package build */
  testDepSources: SourceRef[];
  /** The runner property's sources; empty means fall back to JS_TEST_RUNNER */
  runnerSources: SourceRef[];
}

/**
 * The shared test pipeline: compile the whole source tree (tests included, so
 * their relative imports resolve against the code under test), lay it out as
 * a runnable installation together with the deps, the test-only deps and the
 * runner, and execute the runner over the compiled test files. The output
 * artifact is the test report; a red run fails the target with the report's
 * failure summary.
 *
 * Everything the evaluation consumes — deps, test-only deps, the runner
 * (property or JS_TEST_RUNNER global), and the compile toolchain — goes
 * through ONE collection point, so every requirement resolves jointly and
 * the consumer's pins participate across the lot.
 */
export function compileAndRunTests(context: TargetContext, inputs: ITestInputs): Computable<RuleResult> {
  const testFiles = compiledTestFiles(inputs.tests);
  if (testFiles.length === 0) {
    /* Nothing to run is trivially green (and no runner is needed) */
    return Computable.resolve(EMPTY_FILESET);
  }
  const jsTarget = parseJSTarget(inputs.target);
  /* Compile srcs and tests together (tests are normally within srcs); the
   * globals declarations come in via the synthetic @types mount, so a copy
   * among the sources (the runner package testing itself) is dropped */
  const sources = FileSet.unionAll(inputs.sources, inputs.tests).remap(name =>
    name === RUNNER_GLOBALS_TYPES ? undefined : name
  );
  const needsTsc = hasTypescriptSources(sources);
  return context
    .collect({
      deps: inputs.depSources,
      testDeps: inputs.testDepSources,
      runner: inputs.runnerSources.length > 0 ? inputs.runnerSources : context.getGlobalSources("JS_TEST_RUNNER", BUILD_OP),
      ...(needsTsc && inputs.flags.find(f => f.name === "nodejs")
        ? { nodeTypes: context.getGlobalSources("NODE_TYPES", BUILD_OP) }
        : {}),
    })
    .then(({ deps, testDeps, runner: runnerSets, nodeTypes }): Computable<RuleResult> => {
      const runner = requireRunnerPackage(runnerSets, inputs.runnerSources.length > 0);
      const compileModules = assembleNodeModules([...deps, ...testDeps, runnerGlobalsTypes(runner)]);
      const runtimeModules = assembleNodeModules([...deps, ...testDeps, runner]);
      const { compiled, copied } = compileJsSources(context, sources, compileModules, jsTarget, inputs.flags, nodeTypes);
      if (!compiled) {
        /* Test files are TypeScript, so a compile is always present; guard
         * defensively rather than emit an empty run */
        return Computable.resolve(EMPTY_FILESET);
      }
      return planTestRun(compiled, copied, runtimeModules, runner, testFiles, jsTarget);
    });
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

/** @return the compiled (.js) names of the given test sources, sorted for determinism */
function compiledTestFiles(tests: FileSet): string[] {
  return [...tests]
    .map(([name]) => name)
    .filter(name => TS_FILE_PATTERN.test(name) && !name.endsWith(".d.ts"))
    .map(name => name.replace(TS_FILE_PATTERN, ".js"))
    .sort();
}

/**
 * @return the runner package from its materialized delivery (the target's
 * runner property if given, else the JS_TEST_RUNNER global — collected
 * jointly with everything else the evaluation consumes).
 */
function requireRunnerPackage(sets: FileSet[], fromProperty: boolean): PackageFileSet {
  const pkg = sets.find((set): set is PackageFileSet => set instanceof PackageFileSet);
  if (!pkg) {
    throw new Error(
      fromProperty
        ? "The runner property must name a built package"
        : "JS_TEST_RUNNER does not resolve to a built package (it should name the test runner, e.g. @fabr/js)"
    );
  }
  return pkg;
}

/**
 * Plan the test run: the runtime installation (deps/test-deps/runner as
 * node_modules, plus a minimal package.json and any copied sources) is
 * assembled in resolution, and the compiled tree — the output of the shared
 * js_compile sub-target — is passed in as a concrete input. The js_test_run
 * step's key covers both the staged installation and the invocation (which
 * tests run is part of what a cached green result attests to). A generic exec
 * can't serve here: a red run must fail the target while keeping the report.
 */
function planTestRun(
  compiled: Computable<FileSet>,
  copied: FileSet,
  nodeModules: FileSet,
  runner: PackageFileSet,
  testFiles: string[],
  jsTarget: JSTarget
): Computable<RuleResult> {
  return Computable.forAll([runner.get(RUNNER_ENTRY), compiled], (entry, compiledTree) => {
    if (!entry) {
      throw new Error(`Test runner package '${runner.packageName}' does not provide a ${RUNNER_ENTRY} entry point`);
    }
    const packageJson = MemoryFile.from(
      JSON.stringify({ name: "fabr-test", private: true, type: jsTarget.module === "esm" ? "module" : "commonjs" })
    );
    const staged = FileSet.unionAll(
      FileSet.layout({ node_modules: [nodeModules], "package.json": packageJson }),
      stripPackageJson(copied),
      compiledTree
    );
    const runnerEntry = path.join("node_modules", runner.packageName, RUNNER_ENTRY);
    const argv = [findExecutable("node"), runnerEntry, `--report=${TEST_REPORT_FILENAME}`, ...testFiles];
    return new BuildAction(JS_TEST_STEP, { staged, argv }, "test");
  });
}

/**
 * The js_test_run build step: stage the complete installation (built in
 * resolution — deps/runner as node_modules, the compiled tree, a minimal
 * package.json), execute the runner under node, and deliver the report
 * artifact. Only green runs enter the cache — a red run throws (as
 * TestsFailedError when the report says so), which also removes the partial
 * entry, so tests re-run until they pass.
 */
const JS_TEST_STEP: IBuildActionDefinition = { id: "js:test-run", version: 1, run: runTests };

function runTests(inputs: BuildActionInputs, workDir: string): Computable<FileSet> {
  const staged = fileSetInput(inputs, "staged");
  const argv = stringListInput(inputs, "argv");
  return writeFileSet(workDir, staged)
    .then(() => execute(argv[0], argv.slice(1), workDir, {}))
    .then(
      () => getResultFileSet(workDir, TEST_REPORT_FILENAME),
      err => {
        throw toTestFailure(workDir, err);
      }
    );
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
