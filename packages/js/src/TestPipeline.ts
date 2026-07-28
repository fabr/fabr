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
 * reporting through the test report contract defined by @fabr-build/core.
 *
 * The runner resolves as the JS_TEST_RUNNER runnable — fabr's own by default
 * (`@fabr-build/js-tools/test-runner`, declared in JS.fabr over the compiled
 * runtime shipped in this installation) — and is executed standalone inside
 * the test working directory. A replacement must honor the runner contract:
 * invoked in the staged install as `<runner> --report=<file> <test files...>`,
 * red exit status on failure, report written as CTRF.
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
  formatTestFailures,
  getResultFileSet,
  IActionContext,
  IBuildActionDefinition,
  ITestReport,
  RunnableFileSet,
  TargetContext,
  RuleResult,
  SourceRef,
  stringListInput,
  TEST_REPORT_FILENAME,
  TestsFailedError,
  writeFileSet,
} from "@fabr-build/core";
import { assembleNodeModules, compileJsSources, JSTarget, moduleTypeFile, parseJSTarget, stripPackageJson } from "./JSPackage";

/** The runner's ambient types for its preloaded globals, anywhere in its install */
const GLOBALS_TYPES_FILE = "test-globals.d.ts";
/** Where the runner install is staged in the test install, and where its
 * ambient-types file mounts so tsc auto-includes it for the test compile */
const RUNNER_STAGE_DIR = ".fabr-testrunner";
const GLOBALS_TYPES_MOUNT = "@types/fabr-test-globals/index.d.ts";
/* The runner's own globals .d.ts as it appears in @fabr-build/js's srcs, dropped
 * when @fabr-build/js tests itself so it doesn't collide with the synthetic mount. */
const RUNNER_GLOBALS_TYPES = "testRunner/test-globals.d.ts";

/**
 * The runner's ambient globals types, extracted from its resolved install (a
 * test-globals.d.ts anywhere among its files) and mounted as the synthetic
 * @types package the test compile auto-includes; empty when the runner ships
 * none. Part of the runner contract, so a swapped JS_TEST_RUNNER carries its
 * own globals typings with it rather than inheriting fabr's.
 */
function runnerGlobalsTypes(runner: FileSet): FileSet {
  const found = [...runner].find(([name]) => name === GLOBALS_TYPES_FILE || name.endsWith("/" + GLOBALS_TYPES_FILE));
  return found ? FileSet.layout({ [GLOBALS_TYPES_MOUNT]: found[1] }) : EMPTY_FILESET;
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
  target: string;
  /** The as-written (unmaterialized) dependency sources. A js_package[test]
   * folds its `provided_deps` in here — a test install is self-contained, so a
   * peer is just another dep with no host to supply it and no manifest to
   * distinguish it. */
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
 * across the lot. The runner is not among them: it is a *tool*, independent
 * of what it tests, so it resolves apart as the JS_TEST_RUNNER runnable (the
 * TSC precedent — its pins don't co-resolve with the tests' deps).
 */
export function compileAndRunTests(context: TargetContext, inputs: ITestInputs): Computable<RuleResult> {
  if (inputs.tests.isEmpty()) {
    /* No tests declared: trivially green (and no runner is needed). A declared
     * test that yields no runnable output is NOT this case — it errors below. */
    return Computable.resolve(EMPTY_FILESET);
  }
  const jsTarget = parseJSTarget(inputs.target);
  /* Compile srcs and tests together (tests are normally within srcs); the
   * globals declarations come in via the synthetic @types mount, so a copy
   * among the sources (the runner testing itself) is dropped */
  const sources = FileSet.unionAll(inputs.sources, inputs.tests).remap(name =>
    name === RUNNER_GLOBALS_TYPES ? undefined : name
  );
  /* The declared test sources' stems (path minus extension). Their compiled `.js`
   * are picked out of the *actual* compiled tree by stem in planTestRun, so the
   * source→output naming is never re-derived here — js_compile owns it. */
  const testStems = new Set([...inputs.tests].map(([name]) => stripExtension(name)));
  return Computable.forAll(
    [
      context.getGlobalRunnable("JS_TEST_RUNNER"),
      context.collect({
        deps: inputs.depSources,
        testDeps: inputs.testDepSources,
      }),
    ],
    (runner, { deps, testDeps }): Computable<RuleResult> => {
      /* The test compile may import the package's deps, the test_deps, and the
       * runner globals directly; the runtime install is the flat closure. */
      const runtimeModules = assembleNodeModules([...deps, ...testDeps]);
      /* Source-mode flags (strictness relaxations) among the deps/test_deps ride
       * as empty marker FileSets; js_compile reads them into the compile's tsconfig. */
      const { compiled, copied } = compileJsSources(context, sources, [
        ...deps,
        ...testDeps,
        runnerGlobalsTypes(runner),
      ]);
      if (!compiled) {
        /* Tests are declared but none is a compilable source (.ts/.tsx/.js/.jsx),
         * so there is nothing to run — a loud failure, not a silent green. */
        throw new Error("Test target declares test files but none is a compilable source");
      }
      return planTestRun(compiled, copied, runtimeModules, runner, testStems, jsTarget);
    }
  );
}

/** Strip a file's final extension: `a/foo.test.ts` → `a/foo.test`. Used to match
 * a declared test source against its compiled `.js` output by stem. */
function stripExtension(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

/** The runnable test files: the `.js` entries of the *actual* compiled tree whose
 * stem is one of the declared tests' stems, sorted for determinism. No
 * source→output name is predicted — js_compile named these; we only select. */
export function selectCompiledTestFiles(compiled: FileSet, testStems: Set<string>): string[] {
  return [...compiled]
    .map(([name]) => name)
    .filter(name => name.endsWith(".js") && testStems.has(stripExtension(name)))
    .sort();
}

/**
 * Plan the test run: the runtime installation (deps/test-deps as node_modules,
 * the runner's install staged under {@link RUNNER_STAGE_DIR}, a minimal
 * package.json and any copied sources) is assembled in resolution, and the
 * compiled tree — the output of the shared js_compile sub-target — is passed
 * in as a concrete input. The js_test_run step's key covers both the staged
 * installation and the invocation (which tests run is part of what a cached
 * green result attests to). A generic exec can't serve here: a red run must
 * fail the target while keeping the report.
 */
function planTestRun(
  compiled: Computable<FileSet>,
  copied: FileSet,
  nodeModules: FileSet,
  runner: RunnableFileSet,
  testStems: Set<string>,
  jsTarget: JSTarget
): Computable<RuleResult> {
  return compiled.then(compiledTree => {
    /* Pick the runnable test files out of the real compiled tree (js_compile named
     * them) rather than re-deriving names from the sources. Empty here means the
     * declared tests produced no runnable output — a loud failure, not a green. */
    const testFiles = selectCompiledTestFiles(compiledTree, testStems);
    if (testFiles.length === 0) {
      throw new Error("Test target declares test files but none produced a runnable .js output");
    }
    const packageJson = moduleTypeFile(jsTarget.module, { name: "fabr-test", private: true });
    const staged = FileSet.unionAll(
      FileSet.layout({ node_modules: [nodeModules], [RUNNER_STAGE_DIR]: [runner], "package.json": packageJson }),
      stripPackageJson(copied),
      compiledTree
    );
    /* Bare interpreter (e.g. "node"): resolved against PATH inside the step, so
     * no host-specific absolute path enters the action manifest. */
    const argv = runner.toCommandLine([`--report=${TEST_REPORT_FILENAME}`, ...testFiles], { base: RUNNER_STAGE_DIR });
    return new BuildAction(JS_TEST_STEP, { staged, argv }, "test");
  });
}

/**
 * The js_test_run build step: stage the complete installation (built in
 * resolution — deps as node_modules, the runner, the compiled tree, a minimal
 * package.json), execute the runner, and deliver the report artifact. Only
 * green runs enter the cache — a red run throws (as TestsFailedError when the
 * report says so), which also removes the partial entry, so tests re-run
 * until they pass.
 */
const JS_TEST_STEP: IBuildActionDefinition = { id: "js:test-run", version: 3, run: runTests };

function runTests(inputs: BuildActionInputs, { workDir }: IActionContext): Computable<FileSet> {
  const staged = fileSetInput(inputs, "staged");
  const argv = stringListInput(inputs, "argv");
  /* Tests run with a clean environment (no ambient vars that could alter their
   * output); a test that must spawn a tool references it by an absolute path
   * (e.g. process.execPath), which needs no PATH. The argv's leading command
   * (the runner's interpreter) is PATH-resolved here, at run time. */
  return writeFileSet(workDir, staged)
    .then(() => execute(findExecutable(argv[0]), argv.slice(1), workDir, {}))
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
