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
 * The runner is fabr's own, sourced directly from this @fabr/js installation
 * (see {@link getHostRunner}) and executed standalone inside the test working
 * directory — it is not resolved as a build target.
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
  IFile,
  ITestReport,
  MemoryFile,
  TargetContext,
  RuleResult,
  SourceRef,
  stringListInput,
  TEST_REPORT_FILENAME,
  TestsFailedError,
  writeFileSet,
} from "@fabr/core";
import { assembleNodeModules, compileJsSources, JSTarget, parseJSTarget, stripPackageJson } from "./JSPackage";

/** Test files are conventionally named *.test.ts (or .tsx) */
export const TEST_FILE_PATTERN = /\.test\.tsx?$/;
/** Compilable sources (the runner executes their compiled .js) */
const TS_FILE_PATTERN = /\.tsx?$/;

/* Fabr's own test runner lives in this @fabr/js installation, next to the
 * compiled rule code (packages/js/build/testRunner in the devchain build, or
 * testRunner/ within the fabr-built package — the same relative layout). */
const HOST_TESTRUNNER_DIR = path.join(__dirname, "testRunner");
/** The runner entry executed in the test process (see testRunner/runner.ts) */
const RUNNER_ENTRY = "runner.js";
/** The runner's hand-authored ambient types for the preloaded globals */
const GLOBALS_TYPES_FILE = "test-globals.d.ts";
/** Where the runner runtime is staged in the test install, and where its
 * ambient-types file mounts so tsc auto-includes it for the test compile */
const RUNNER_STAGE_DIR = ".fabr-testrunner";
const GLOBALS_TYPES_MOUNT = "@types/fabr-test-globals/index.d.ts";
/* The runner's own globals .d.ts as it appears in @fabr/js's srcs, dropped
 * when @fabr/js tests itself so it doesn't collide with the synthetic mount. */
const RUNNER_GLOBALS_TYPES = "testRunner/test-globals.d.ts";

interface IHostRunner {
  /** The runtime .js files, named at the runner's stage-dir root */
  runtime: FileSet;
  /** The globals ambient types, as a synthetic @types package for the compile */
  globalsTypes: FileSet;
}

let hostRunnerCache: IHostRunner | undefined;

/**
 * Load fabr's own test runner from this @fabr/js installation's testRunner
 * directory: the runtime .js (runner.js + its helpers + the globals shim,
 * executed in the test process) and the hand-authored globals .d.ts (mounted
 * into the test compile). Read once and memoized — the runner is fixed per
 * fabr version. Files enter the build as in-memory content, so the test-run
 * cache key stays content-addressed (no host path leaks into the manifest).
 */
function getHostRunner(): IHostRunner {
  if (!hostRunnerCache) {
    const read = (file: string): MemoryFile => MemoryFile.from(fs.readFileSync(path.join(HOST_TESTRUNNER_DIR, file), "utf8"));
    const runtime: Record<string, IFile> = {};
    for (const name of fs.readdirSync(HOST_TESTRUNNER_DIR)) {
      /* The runtime is the compiled .js; exclude the runner's own tests */
      if (name.endsWith(".js") && !name.endsWith(".test.js")) {
        runtime[name] = read(name);
      }
    }
    if (!runtime[RUNNER_ENTRY]) {
      throw new Error(`fabr test runner is missing its ${RUNNER_ENTRY} entry in ${HOST_TESTRUNNER_DIR}`);
    }
    hostRunnerCache = {
      runtime: FileSet.layout(runtime),
      globalsTypes: FileSet.layout({ [GLOBALS_TYPES_MOUNT]: read(GLOBALS_TYPES_FILE) }),
    };
  }
  return hostRunnerCache;
}

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
}

/**
 * The shared test pipeline: compile the whole source tree (tests included, so
 * their relative imports resolve against the code under test), lay it out as
 * a runnable installation together with the deps, the test-only deps and the
 * runner, and execute the runner over the compiled test files. The output
 * artifact is the test report; a red run fails the target with the report's
 * failure summary.
 *
 * Everything the evaluation consumes from the build graph — deps, test-only
 * deps, and the compile toolchain — goes through ONE collection point, so
 * every requirement resolves jointly and the consumer's pins participate
 * across the lot. The runner is not among them: it is fabr's own, sourced
 * from this installation (see {@link getHostRunner}).
 */
export function compileAndRunTests(context: TargetContext, inputs: ITestInputs): Computable<RuleResult> {
  const testFiles = compiledTestFiles(inputs.tests);
  if (testFiles.length === 0) {
    /* Nothing to run is trivially green (and no runner is needed) */
    return Computable.resolve(EMPTY_FILESET);
  }
  const jsTarget = parseJSTarget(inputs.target);
  const { runtime: runnerRuntime, globalsTypes } = getHostRunner();
  /* Compile srcs and tests together (tests are normally within srcs); the
   * globals declarations come in via the synthetic @types mount, so a copy
   * among the sources (the runner testing itself) is dropped */
  const sources = FileSet.unionAll(inputs.sources, inputs.tests).remap(name =>
    name === RUNNER_GLOBALS_TYPES ? undefined : name
  );
  return context
    .collect({
      deps: inputs.depSources,
      testDeps: inputs.testDepSources,
    })
    .then(({ deps, testDeps }): Computable<RuleResult> => {
      /* The test compile may import the package's deps, the test_deps, and the
       * runner globals directly; the runtime install is the flat closure. */
      const runtimeModules = assembleNodeModules([...deps, ...testDeps]);
      const { compiled, copied } = compileJsSources(
        context,
        sources,
        [...deps, ...testDeps, globalsTypes],
        jsTarget,
        inputs.flags
      );
      if (!compiled) {
        /* Test files are TypeScript, so a compile is always present; guard
         * defensively rather than emit an empty run */
        return Computable.resolve(EMPTY_FILESET);
      }
      return planTestRun(compiled, copied, runtimeModules, runnerRuntime, testFiles, jsTarget);
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
 * Plan the test run: the runtime installation (deps/test-deps as node_modules,
 * fabr's runner staged under {@link RUNNER_STAGE_DIR}, a minimal package.json
 * and any copied sources) is assembled in resolution, and the compiled tree —
 * the output of the shared js_compile sub-target — is passed in as a concrete
 * input. The js_test_run step's key covers both the staged installation and
 * the invocation (which tests run is part of what a cached green result
 * attests to). A generic exec can't serve here: a red run must fail the target
 * while keeping the report.
 */
function planTestRun(
  compiled: Computable<FileSet>,
  copied: FileSet,
  nodeModules: FileSet,
  runnerRuntime: FileSet,
  testFiles: string[],
  jsTarget: JSTarget
): Computable<RuleResult> {
  return compiled.then(compiledTree => {
    const packageJson = MemoryFile.from(
      JSON.stringify({ name: "fabr-test", private: true, type: jsTarget.module === "esm" ? "module" : "commonjs" })
    );
    const staged = FileSet.unionAll(
      FileSet.layout({ node_modules: [nodeModules], [RUNNER_STAGE_DIR]: [runnerRuntime], "package.json": packageJson }),
      stripPackageJson(copied),
      compiledTree
    );
    const runnerEntry = path.join(RUNNER_STAGE_DIR, RUNNER_ENTRY);
    const argv = [findExecutable("node"), runnerEntry, `--report=${TEST_REPORT_FILENAME}`, ...testFiles];
    return new BuildAction(JS_TEST_STEP, { staged, argv }, "test");
  });
}

/**
 * The js_test_run build step: stage the complete installation (built in
 * resolution — deps as node_modules, fabr's runner, the compiled tree, a
 * minimal package.json), execute the runner under node, and deliver the report
 * artifact. Only green runs enter the cache — a red run throws (as
 * TestsFailedError when the report says so), which also removes the partial
 * entry, so tests re-run until they pass.
 */
const JS_TEST_STEP: IBuildActionDefinition = { id: "js:test-run", version: 2, run: runTests };

function runTests(inputs: BuildActionInputs, workDir: string): Computable<FileSet> {
  const staged = fileSetInput(inputs, "staged");
  const argv = stringListInput(inputs, "argv");
  /* Tests run with a clean environment (no ambient vars that could alter their
   * output); a test that must spawn a tool references it by an absolute path
   * (e.g. process.execPath), which needs no PATH. */
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
