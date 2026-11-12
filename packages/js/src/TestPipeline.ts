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
 * The test pipeline shared by the js test rules (js_test and js_package[test]):
 * compile the tests with the sources, assemble the runnable installation, and
 * run the runner over the compiled test files, reporting through core's test
 * report contract (CTRF).
 *
 * A test framework ({@link ITestFramework}) says which runner runs the tests
 * and the module format it loads them as. Each test target type has one rule
 * per framework, selected on the target's framework property, which passes its
 * framework here. The runner runs in the installation's compiled tree, its
 * working directory, invoked as
 *
 *     <runner> --report=<file> --env=<node|jsdom> [--update-snapshots]
 *              [--name-pattern=<regex>] [--setup=<module|./staged path>]…
 *              [--pnp=<file>] [--reads=<file>] <test files…>
 *
 * and writes its CTRF report to `--report`; its exit status counts only where
 * it wrote none.
 *
 * - `--env`: the environment the suite runs in, which follows the `dom` source
 *   flag rather than the target the code is emitted for.
 * - `--update-snapshots`: rewrite recorded expectations rather than fail on
 *   them (TEST_EXPECTATIONS=update); the pipeline offers the rewritten records
 *   back to the source tree.
 * - `--name-pattern`: run only the tests whose full names (suite names and the
 *   test's own, joined by spaces) the JavaScript regular expression matches
 *   (TEST_NAME_PATTERN).
 * - `--setup`: something every test process loads before any test file, in
 *   the order given: a `./` path within the installation, else a module name.
 *   Fabr passes the target's setup script ({@link SETUP_STEM}).
 * - `--pnp`: the PnP table the test processes resolve packages through, where
 *   the installation has one in place of `node_modules` (the `layout/pnp` flag;
 *   js-tools' `pnp/Runtime.ts`).
 * - `--reads`: where to write what the test processes loaded or read (js-tools'
 *   `testRunner/Reads.ts`), from which the test step decides what a change
 *   reaches.
 */

import {
  BUILD_OVERRIDE,
  builtInProject,
  Computable,
  Constraints,
  COVERAGE,
  COVERAGE_ON,
  COVERAGE_REPORT_FILENAME,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  Flag,
  IFile,
  IWriteBackCandidate,
  MemoryFile,
  PackageFileSet,
  PackageSources,
  parseName,
  PropertyMap,
  ResolutionSpec,
  RuleResult,
  RunnableArgument,
  RunnableFileSet,
  SourceRef,
  TargetContext,
  TEST_EXPECTATIONS,
  TEST_NAME_PATTERN,
  TEST_REPORT_FILENAME,
  toEnvironment,
  TREE_MOUNT,
  UPDATE_EXPECTATIONS,
  WriteBackFileSet,
  describeTarget,
  descriptionFile,
  type Unmaterialized,
} from "@fabr-build/core";
import { type ITypeScriptPayload, layOutUnits, TSSERVER_PLUGIN, TYPESCRIPT_DATA_KIND } from "./Description";
import { PNP_DATA_FILE, SOURCE_LOCATIONS_FILE } from "@fabr-build/js-tools";
import { createTestRunAction } from "./TestRunAction";
import { posix } from "path";
import { COMPILE_OUT_DIR, COMPILE_SRC_DIR } from "./rules/BuildJSCompile";
import { packageDirectories } from "./NodeModules";
import {
  compileContents,
  DECLARATION_FILE,
  type ICompiledContents,
  formatJSTarget,
  PinnedJSTarget,
  moduleTypeFile,
  parseJSTarget,
  layoutOf,
  resourceFiles,
  stripExtension,
  stripPackageJson,
  usesDom,
} from "./JSPackage";

/** The runner's types for the globals it installs, anywhere in its install. */
const GLOBALS_TYPES_FILE = "test-globals.d.ts";
/** Where the runner's install is staged in the test installation. */
const RUNNER_STAGE_DIR = ".fabr-testrunner";
/** Where the runner's globals types mount in the test compile: an `@types`
 * package, which the compile includes automatically. */
const GLOBALS_TYPES_MOUNT = "@types/fabr-test-globals/index.d.ts";
/* The runner's own globals types as named among @fabr-build/js-tools's srcs:
 * dropped from the sources when it tests itself, so as not to collide with the
 * mount. */
const RUNNER_GLOBALS_TYPES = "testRunner/test-globals.d.ts";

/** Where a measured run stages the coverage driver's install. */
const COVERAGE_STAGE_DIR = ".fabr-coverage";

/** A compiled JavaScript file, which a measured run measures. */
const COMPILED_SCRIPT = /\.[cm]?js$/;

/** The directory beside a test file that holds its recorded snapshots (jest's
 * convention): the declared records are staged there, and the runner writes
 * updates there. */
const SNAPSHOT_DIR = "__snapshots__";

/**
 * The rename projection from a recorded snapshot's name to the test it belongs
 * to: `a/__snapshots__/Foo.test.ts.snap` → `a/Foo.test.ts`; at the tree root
 * the `**` captures nothing and the renamer removes the stray separator. The
 * driver applies it to find the input each offered record belongs beside.
 */
const SNAPSHOT_BELONGS_TO = parseName(`**/${SNAPSHOT_DIR}/*.snap`).withRenameTo(parseName("**/*"));

/**
 * The stem of a target's setup script: a source named `setupTests` (`.ts`,
 * `.js`, …) at the root of the target's source tree is loaded into every test
 * process before any test file (jest's `setupTests.js` convention). No property
 * names it. It is an ordinary source: it compiles with the tests, may be
 * TypeScript, and may use the test globals.
 */
const SETUP_STEM = "setupTests";

/**
 * Extract the runner's globals types (a `test-globals.d.ts` anywhere among its
 * install's files) and mount them at {@link GLOBALS_TYPES_MOUNT}; empty where
 * the runner ships none. Used for a framework whose runner supplies them
 * ({@link ITestFramework.globalsTypes}), so a runner replacing the default
 * supplies its own.
 */
function runnerGlobalsTypes(runner: FileSet): FileSet {
  const found = [...runner].find(([name]) => name === GLOBALS_TYPES_FILE || name.endsWith("/" + GLOBALS_TYPES_FILE));
  return found ? FileSet.layout({ [GLOBALS_TYPES_MOUNT]: found[1] }) : EMPTY_FILESET;
}

/** Record the location of each of `sources` in the test installation (under
 *  {@link COMPILE_SRC_DIR}), by its source path. */
function sourceLocations(sources: FileSet): MemoryFile {
  const rows = [...sources.sourcePaths]
    .map(([name, sourcePath]): [string, string] => [sourcePath, `${COMPILE_SRC_DIR}/${name}`])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return MemoryFile.from(JSON.stringify(Object.fromEntries(rows)));
}

/** How one test framework's suites are built and run. */
export interface ITestFramework {
  /** The global naming the runner (a runnable honouring the runner contract). */
  runner: string;
  /** The module format the runner loads test files as, which the tests, and
   * the package a js_package's tests test, are built in. */
  module: PinnedJSTarget["module"];
  /** Whether the runner supplies the types of the test globals it installs
   * (its install's `test-globals.d.ts`); otherwise an ordinary `@types`
   * package the target declares does, as `@types/jest` does for jest. */
  globalsTypes: boolean;
}

/**
 * The test frameworks, by the name a target selects one with. `node` and `jest`
 * load tests as CommonJS (the jest layer's mocking intercepts call-time
 * `require`); `vitest` loads them as ES modules.
 */
export const TEST_FRAMEWORKS: ReadonlyMap<string, ITestFramework> = new Map([
  ["node", { runner: "JS_NODE_TEST_RUNNER", module: "commonjs", globalsTypes: true }],
  ["jest", { runner: "JS_JEST_RUNNER", module: "commonjs", globalsTypes: false }],
  ["vitest", { runner: "JS_VITEST_RUNNER", module: "esm", globalsTypes: false }],
]);

/**
 * Get the test framework the target's STRING property `property` names, or
 * fail naming the frameworks there are.
 */
export function testFramework(context: TargetContext, property: string): Computable<ITestFramework> {
  return context.getRequiredProperty(property).then(name => {
    const framework = TEST_FRAMEWORKS.get(name.toString());
    if (framework === undefined) {
      throw new FabrError(`'${name.toString()}' is not a test framework (${[...TEST_FRAMEWORKS.keys()].join(", ")})`);
    }
    return framework;
  });
}

/** A test target's requirements, as read (unmaterialized), resolved as one
 * collection. */
export type TestRequirements = {
  /** The package a js_package's tests test, as its build makes it in the
   * module format their framework loads; nothing for a js_test. */
  package: PackageSources;
  srcs: SourceRef[];
  tests: SourceRef[];
  /** A js_package[test] includes its `provided_deps` here, as the test
   * installation must supply them itself. */
  deps: PackageSources;
  /** Packages compiled against and installed like `deps`, whose flags say
   * nothing of the test run (`dom` here is the DOM's types, with no DOM to run
   * in). */
  compile_deps: PackageSources;
  /** Test-only packages (assertion libraries and their @types), for the test
   * compile and the test run but never the package build. */
  test_deps: PackageSources;
  /** Files the tests need at runtime, staged verbatim. */
  test_resources: SourceRef[];
  /** The files the package ships as they are (`resources`), staged where it ships them, beside its compiled code. */
  resources: SourceRef[];
  /** Recorded expectations the tests compare against. */
  expectations: SourceRef[];
};

/** {@link TestRequirements}, materialized. */
export type TestContents = { [K in keyof TestRequirements]: FileSet[] };

/** How a test target type names what differs between the two. */
export interface ITestSettings {
  /** The MAP property declaring the environment variables the test processes
   * run with — their whole environment: `test_env` on a js_package, `env` on a
   * js_test. */
  envProperty: string;
  /** The package name a js_package[test]'s sources may import themselves by; a
   * standalone js_test has no package identity and leaves it unset. */
  packageName?: string;
}

/**
 * Make a test target's resolution spec: its requirements as written, or none
 * where it declares no `tests` at all, so that such a target fetches nothing
 * under `fabr test`. A declared `tests` that matches no files keeps its
 * requirements.
 */
export function testRequirements(written: TestRequirements): ResolutionSpec<TestRequirements> {
  return {
    build:
      written.tests.length === 0
        ? {
            package: new PackageSources([]),
            srcs: [],
            tests: [],
            deps: new PackageSources([]),
            compile_deps: new PackageSources([]),
            test_deps: new PackageSources([]),
            test_resources: [],
            resources: [],
            expectations: [],
          }
        : written,
  };
}

/**
 * Make the overrides a js_package's tests require the package under: built,
 * with `JS_TARGET`'s module format set to the one the framework the target's
 * STRING property `property` names loads, where the package is not already
 * built in it. A package already in that format is the build `fabr build`
 * makes.
 */
export function packageBuildOverrides(context: TargetContext, property: string): Computable<Constraints> {
  return Computable.forAll(
    [testFramework(context, property), context.getGlobalString("JS_TARGET", BUILD_OVERRIDE)],
    (framework, target) => {
      const jsTarget = parseJSTarget(target);
      return jsTarget.module === framework.module
        ? BUILD_OVERRIDE
        : BUILD_OVERRIDE.with(Constraints.of({ JS_TARGET: formatJSTarget(testTargetOf(jsTarget, framework)) }));
    }
  );
}

/**
 * Compile and run a test target's tests: compile them in one program with the
 * sources, against `deps`, `compile_deps`, `test_deps` and, where the
 * framework's runner supplies them, its globals types, for `JS_TARGET` (under
 * the build operation) in the framework's module format. For a js_package's
 * tests, the package's own build (the `package` requirement) has checked and
 * emitted its sources, and the compile is given its declarations. Then lay the
 * result out with the package, the packages, the resources and the runner as a
 * runnable installation, and yield the test-run action ({@link planTestRun}).
 *
 * The last argument is the target's {@link TestRequirements}, materialized. The
 * runner and the compile's tools are not among them: they resolve apart.
 *
 * Yields empty content where there are no test files. Throws where tests are
 * declared but the compile has no compilable source.
 */
export function compileAndRunTests(
  context: TargetContext,
  framework: ITestFramework,
  settings: ITestSettings,
  {
    package: testedSets,
    srcs,
    tests: testSets,
    deps: runtimeDeps,
    compile_deps: compileDeps,
    test_deps: testDeps,
    test_resources: testResources,
    resources: shipped,
    expectations: expectationSets,
  }: TestContents
): Computable<RuleResult> {
  const deps = [...runtimeDeps, ...compileDeps];
  const tests = FileSet.unionAll(...testSets);
  if (tests.isEmpty()) {
    /* No test files: nothing to run, and no runner is fetched. Declared tests
     * with no runnable output are an error, below. */
    return Computable.resolve(EMPTY_FILESET);
  }
  /* Compile the sources and tests together (the tests are usually among the
   * sources). A js_package's sources come with the declarations its build
   * emitted, and the compile checks and emits only the rest. A copy of the
   * runner's globals types among the sources (the runner testing itself) is
   * dropped: they come in through the `@types` mount. */
  const tested = testedSets.find((set): set is PackageFileSet => set instanceof PackageFileSet);
  const sources = FileSet.unionAll(...srcs, tests).remap(name => (name === RUNNER_GLOBALS_TYPES ? undefined : name));
  const declarations =
    tested === undefined ? undefined : stripPackageJson(tested).remap(name => (DECLARATION_FILE.test(name) ? name : undefined));
  /* The declared test sources' stems (path minus extension): planTestRun picks
   * their compiled files out of the compiled tree by stem. */
  const testStems = new Set([...tests].map(([name]) => stripExtension(name)));
  /* The runner is a tool: it resolves apart from the tests' packages. */
  return Computable.forAll(
    [
      context.getGlobalRunnable(framework.runner),
      context.getGlobalString(TEST_EXPECTATIONS),
      context.getGlobalString("JS_TARGET", BUILD_OVERRIDE),
      context.getMap(settings.envProperty),
      context.getGlobalString(COVERAGE),
      context.getGlobalString(TEST_NAME_PATTERN),
    ],
    (runner, expectations, target, env, coverage, namePattern): Computable<RuleResult> =>
      (coverage === COVERAGE_ON ? context.getGlobalRunnable("JS_COVERAGE_DRIVER") : Computable.resolve(undefined)).then(
        (coverageDriver): Computable<RuleResult> => {
          const jsTarget = parseJSTarget(target);
          /* In the installation the packages are laid out for the run, and the
           * loose resource files among the deps (`.json`, a template) are staged
           * beside the compiled tests, so a `./x.json` import resolves. Loose
           * compilable files (`.ts`, `.js`) are left out: their output is in the
           * compiled tree, and a raw `.js` would collide with it. */
          const allDeps = [...deps, ...testDeps];
          const packages = allDeps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
          const resources = resourceFiles(allDeps.filter(dep => !(dep instanceof PackageFileSet)));

          const testTarget = testTargetOf(jsTarget, framework);
          return testCompile(context, framework, settings, { sources, declarations, deps, testDeps, runner, testTarget }).then(
            built => {
              if (built.sources.ts.isEmpty() && built.sources.js.isEmpty() && built.sources.jsx.isEmpty()) {
                /* No compilable source (.ts/.tsx/.js/.jsx) in the compile: nothing
                 * to run. */
                throw new FabrError("Test target declares test files but none is a compilable source");
              }
              return planTestRun(context, {
                /* The tests' output and the package's files as one tree, the
                 * package's file taken where both have one (a JSON source both
                 * import, which the package's compile emits and the tests' passes
                 * through as written). */
                compiled: Computable.resolve(
                  tested === undefined ? built.compiled : FileSet.unionAll(stripPackageJson(tested), built.compiled.minus(tested))
                ),
                /* The lowered CSS is a sibling of the compiled code that imports it. */
                copied: FileSet.unionAll(built.passthrough, built.css).minus(tested ?? EMPTY_FILESET),
                compileSrcs: built.compileSrcs,
                resources,
                runner,
                tests,
                testStems,
                testTarget,
                /* The environment follows the `dom` source flag among `deps` and
                 * `test_deps`, not the target the code is emitted for. A suite
                 * whose tests need a DOM its sources do not declares `dom` in
                 * `test_deps`. */
                needsDom: usesDom([...runtimeDeps, ...testDeps].filter((dep): dep is Flag => dep instanceof Flag)),
                layout: layoutOf([...runtimeDeps, ...testDeps].filter((dep): dep is Flag => dep instanceof Flag)),
                packages,
                testResources: FileSet.unionAll(...testResources, ...shipped),
                expectations: FileSet.unionAll(...expectationSets),
                env,
                packageName: settings.packageName,
                update: expectations === UPDATE_EXPECTATIONS,
                namePattern: namePattern === "" ? undefined : namePattern,
                coverage: coverageDriver === undefined ? undefined : { driver: coverageDriver, packages },
              });
            }
          );
        }
      )
  );
}

/** The compile a test run makes: what it compiles, against what, and for which target. */
interface ITestCompile {
  sources: FileSet;
  /** The declarations the package's build emitted for its sources, which the
   * compile then neither checks nor emits. */
  declarations?: FileSet;
  deps: FileSet[];
  testDeps: FileSet[];
  runner: FileSet;
  testTarget: PinnedJSTarget;
}

/**
 * @return the target a test target's tests compile for: the format their
 * framework's runner loads, whatever the package itself is built as.
 * Component-wise — the ES version and the environment are the target's own.
 */
function testTargetOf(jsTarget: ReturnType<typeof parseJSTarget>, framework: ITestFramework): PinnedJSTarget {
  return { ...jsTarget, module: framework.module };
}

/**
 * Compile a test target's sources and tests as its run does — or, with
 * `describe`, describe that compile (see Description) — against its deps, its
 * test-only deps and, where its framework's runner supplies them, the runner's
 * globals.
 */
function testCompile(
  context: TargetContext,
  framework: ITestFramework,
  settings: ITestSettings,
  { sources, declarations, deps, testDeps, runner, testTarget }: ITestCompile,
  describe = false
): Computable<ICompiledContents> {
  /* Set `JS_TARGET` even where the package already emits that format: the
   * spelling may then differ (`es2020` formats back as `es2020-commonjs-node`),
   * but it parses identically and yields the same tsconfig. Stylesheets among
   * the sources are built as a package's are. */
  return compileContents(
    context,
    sources,
    [...deps, ...testDeps, framework.globalsTypes ? runnerGlobalsTypes(runner) : EMPTY_FILESET],
    {
      packageName: settings.packageName,
      declarations,
      constraints: Constraints.of({ JS_TARGET: formatJSTarget(testTarget) }),
      /* The label is part of the target key, so the test compile keeps an
       * incremental base apart from the package compile's. */
      label: describe ? "Describing tests for" : "Compiling tests for",
      describe,
    }
  );
}

/**
 * Describe a test target as its run would compile it: its BSP target, tagged
 * a test, and its test unit — the run's compile of its sources and tests,
 * resolved as the run resolves them. The unit is the run's whole program,
 * sources included: describing builds nothing, so there are no package
 * declarations to compile the sources against.
 */
export function describeTests(
  context: TargetContext,
  framework: ITestFramework,
  settings: ITestSettings,
  requirements: Unmaterialized<TestRequirements>
): Computable<RuleResult> {
  /* A target that names no tests has no test run to describe. */
  if ((requirements.resolved.sources.get("tests") ?? []).length === 0) {
    return Computable.resolve(EMPTY_FILESET);
  }
  return requirements
    .describeAll()
    .then(({ srcs, tests: testSets, deps: runtimeDeps, compile_deps: compileDeps, test_deps: testDeps }) => {
      const deps = [...runtimeDeps, ...compileDeps];
      const tests = FileSet.unionAll(...testSets);
      if (tests.isEmpty()) {
        return Computable.resolve(EMPTY_FILESET);
      }
      const sources = FileSet.unionAll(...srcs, tests).remap(name => (name === RUNNER_GLOBALS_TYPES ? undefined : name));
      /* The runner is wanted only for the globals typings it supplies. */
      return Computable.forAll(
        [
          framework.globalsTypes ? context.getGlobalRunnable(framework.runner) : Computable.resolve(EMPTY_FILESET),
          context.getGlobalString("JS_TARGET", BUILD_OVERRIDE),
        ],
        (runner, target) =>
          testCompile(
            context,
            framework,
            settings,
            { sources, deps, testDeps, runner, testTarget: testTargetOf(parseJSTarget(target), framework) },
            true
          ).then(built => {
            const laidOut = layOutUnits(new Map([["test", built.compiled]]));
            const payload: ITypeScriptPayload = { units: laidOut.units, plugin: TSSERVER_PLUGIN };
            return describeTarget(context, requirements.resolved, {
              sources: [sources],
              tags: ["test"],
              languageIds: ["typescript", "javascript"],
              dataKind: TYPESCRIPT_DATA_KIND,
              data: payload,
            }).then(description => FileSet.unionAll(descriptionFile(description), laidOut.files));
          })
      );
    });
}

/** Select the runnable test files: the JavaScript files (`.js`, `.mjs`, `.cjs`)
 * of the compiled tree whose stem is one of `testStems`, sorted. The root setup
 * script ({@link selectCompiledSetupFile}) is never one, though it may be
 * declared among the tests to compile with them. */
export function selectCompiledTestFiles(compiled: FileSet, testStems: Set<string>): string[] {
  return [...compiled]
    .map(([name]) => name)
    .filter(name => /\.[cm]?js$/.test(name) && testStems.has(stripExtension(name)) && stripExtension(name) !== SETUP_STEM)
    .sort();
}

/**
 * Select the compiled setup script: the JavaScript file at the root of the
 * compiled tree whose stem is {@link SETUP_STEM}. One nested deeper
 * (`helpers/setupTests.ts`) is an ordinary source.
 *
 * @return the script's name, or undefined where there is none. Throws where
 *   there are two (a `.ts` and a `.cts`, say).
 */
export function selectCompiledSetupFile(compiled: FileSet): string | undefined {
  const matches = [...compiled]
    .map(([name]) => name)
    .filter(name => /\.[cm]?js$/.test(name) && stripExtension(name) === SETUP_STEM)
    .sort();
  if (matches.length > 1) {
    throw new FabrError(`Test target has more than one ${SETUP_STEM} script (${matches.join(", ")}); it may only have one`);
  }
  return matches[0];
}

/** What {@link planTestRun} makes a test run from. */
interface ITestRun {
  compiled: Computable<FileSet>;
  copied: FileSet;
  /** The compile's own `src/` tree, staged beside the output as the compile
   * laid it out — see the layout in planTestRun. */
  compileSrcs: FileSet;
  resources: FileSet;
  runner: RunnableFileSet;
  /** The declared test sources, for mapping refreshed snapshots back to them. */
  tests: FileSet;
  testStems: Set<string>;
  testTarget: PinnedJSTarget;
  /** Whether the suite needs a DOM (the `dom` source flag), named to the runner
   * as its `--env`. */
  needsDom: boolean;
  /** How the test processes reach `packages` (the `layout/*` flags): a
   * `node_modules` tree, or a PnP table over the pool's trees — laid out by
   * the test-run step. */
  layout: "pnp" | "node_modules";
  /** The packages the tests load. */
  packages: PackageFileSet[];
  /** Verbatim runtime files for the tests, mounted with the compiled output. */
  testResources: FileSet;
  /** The declared recorded expectations — staged beside the compiled tests, and
   * the only inputs an update run may rewrite. */
  expectations: FileSet;
  /** The environment variables the test processes run with. */
  env: PropertyMap;
  /** The package the sources may import themselves by, if any. */
  packageName?: string;
  /** Whether the runner rewrites recorded expectations (TEST_EXPECTATIONS=update). */
  update: boolean;
  /** The regular expression selecting the tests run by name, if any. */
  namePattern?: string;
  /** Where the run is measured for coverage: the program converting what the
   * test processes record, and the packages installed for the run, of which
   * those built in the project are measured. */
  coverage?: { driver: RunnableFileSet; packages: PackageFileSet[] };
}

/**
 * Make the test-run action for a compiled test target: the run's own files
 * (the compiled tree with the resources and the recorded expectations, under
 * {@link COMPILE_OUT_DIR}; the compile's sources under {@link COMPILE_SRC_DIR};
 * a minimal `package.json` and the source-locations table), the packages as
 * its discoverable deps, the runner's install linked at
 * {@link RUNNER_STAGE_DIR}, and the runner's command line.
 *
 * The action's reshape ({@link reshapeTestResult}) makes its output the
 * target's content: the report and, under `update`, the refreshed snapshot
 * files as write-back candidates. The reshape is applied on a cache hit as on
 * a miss, so a replayed update run whose writes were never applied still
 * offers them.
 *
 * Throws where the tests compiled to no runnable file, where the root has two
 * setup scripts, or where coverage is asked for under `layout/pnp`.
 */
function planTestRun(context: TargetContext, run: ITestRun): Computable<RuleResult> {
  return run.compiled.then(compiledTree => {
    /* Empty where the declared tests compiled to no runnable file: an error. */
    const testFiles = selectCompiledTestFiles(compiledTree, run.testStems);
    const setupFile = selectCompiledSetupFile(compiledTree);
    if (testFiles.length === 0) {
      throw new FabrError("Test target declares test files but none produced a runnable .js output");
    }
    const packageJson = moduleTypeFile(run.testTarget.module, { name: "fabr-test", private: true });
    /* Everything the compiled code sees as a sibling: its own output, the
     * sources tsc passed through (a `./x.json` import), and loose resource deps,
     * where the compile emitted none of that name (tsc writes an imported JSON
     * file out again, reformatted). */
    const runtime = FileSet.unionAll(compiledTree, stripPackageJson(run.copied), run.resources.minus(compiledTree));
    /* Laid out as the compile laid it out, output under `build/` and sources
     * under `src/`, so a map naming its source by a relative path still finds
     * it; {@link SOURCE_LOCATIONS_FILE} records where each source with a source
     * path is staged, for a runner opening the source a map's `fabr:` entry
     * names. `node_modules` and `package.json` stay at the root, where node
     * finds them from `build/`. `build/` is also the runner's working
     * directory, so a test's `./x` paths, from the working directory or from
     * `__dirname`, mean what they mean in the source tree. */
    const coverage =
      run.coverage && measuredRun(run.coverage, compiledTree, new Set([...testFiles, ...(setupFile ? [setupFile] : [])]));
    const pnp = run.layout === "pnp";
    if (pnp && coverage !== undefined) {
      throw new FabrError("Measuring coverage needs the tests' packages in a node_modules tree; drop layout/pnp for --coverage");
    }
    /* The run's own files; the step lays out the packages (the action's
     * `deps`) as `layout` says. */
    const files = FileSet.layout({
      "package.json": packageJson,
      /* Resources and records join the compiled tree, the working directory, so
       * a test's `./x` finds them as in the source tree. */
      [COMPILE_OUT_DIR]: [runtime, run.testResources, run.expectations],
      [COMPILE_SRC_DIR]: [run.compileSrcs],
      /* Where each staged source is, by its source path: the compile's maps
       * name a source by its reference, and a runner reading one (the jest
       * flavour's docblock) opens it from here. */
      [SOURCE_LOCATIONS_FILE]: sourceLocations(run.compileSrcs),
    });
    /* The runner's interpreter is reached through the tree pool by its content
     * hash (`RunnableFileSet.launchedBy`), so no host path enters the action's
     * key. The command line carries no report or test files: the step runs it
     * once per file, appending those. */
    const argv = run.runner.toCommandLine(
      [
        `--env=${run.needsDom ? "jsdom" : "node"}`,
        ...(run.update ? ["--update-snapshots"] : []),
        ...(run.namePattern === undefined ? [] : [`--name-pattern=${run.namePattern}`]),
        /* `./`-prefixed: the runner contract distinguishes a path within the
         * installation from a bare module name by exactly that prefix. */
        ...(setupFile === undefined ? [] : [`--setup=./${setupFile}`]),
        ...(pnp ? [`--pnp=../${PNP_DATA_FILE}`] : []),
      ],
      /* The runner stays at the install root while the working directory is the
       * compiled tree, so its entry, and the pool its node is in, are reached one
       * level up. */
      { base: `../${RUNNER_STAGE_DIR}`, pool: `../${TREE_MOUNT}` }
    );
    /* The report (and, measured, the coverage report); under `update`, the
     * refreshed snapshot files too, collected through the `build/` mount
     * (`dir:glob` names results relative to `dir`) so they keep their names in
     * the compiled tree. The patterns are in the action's config, so the two
     * modes never share a cache entry. */
    const outputs = [
      TEST_REPORT_FILENAME,
      ...(coverage ? [COVERAGE_REPORT_FILENAME] : []),
      ...(run.update ? [`${COMPILE_OUT_DIR}:${SNAPSHOT_DIR}/*.snap`, `${COMPILE_OUT_DIR}:**/${SNAPSHOT_DIR}/*.snap`] : []),
    ];
    /* Under `update` the runner rewrites the declared `expectations`, so stage
     * them as writable copies: every other file is staged as a read-only
     * hardlink into the content store, and writing through one would corrupt
     * the entry other builds share. */
    const records = run.update ? run.expectations : EMPTY_FILESET;
    /* The writable set is named by install name, under the mount; `records`
     * keeps the compiled tree's names, which reshapeTestResult compares in. */
    const writable = FileSet.layout({ [COMPILE_OUT_DIR]: [records] });
    return createTestRunAction({
      /* The runner's install, and a measured run's driver's, are trees of the
       * pool linked into the installation, each one line of the key. */
      links: { [RUNNER_STAGE_DIR]: run.runner, ...(coverage?.links ?? {}) },
      files,
      packages: run.packages,
      layout: run.layout,
      self: run.packageName === undefined ? undefined : { name: run.packageName, location: `./${COMPILE_OUT_DIR}/` },
      writable,
      argv,
      testFiles,
      outputs,
      env: toEnvironment(run.env),
      coverage: coverage && { argv: coverage.argv, measured: coverage.measured },
    }).withReshape(result => reshapeTestResult(result, run.tests, records));
  });
}

/**
 * Stage what a measured run adds to the install, and make the coverage driver's
 * command line, run from the install root, and the files it measures: every
 * compiled script of the compile but the tests and the setup script, and of
 * every package built in the project, by where the install lays it out.
 */
function measuredRun(
  { driver, packages }: { driver: RunnableFileSet; packages: PackageFileSet[] },
  compiled: FileSet,
  testInfrastructure: ReadonlySet<string>
): { links: Record<string, FileSet>; argv: RunnableArgument[]; measured: string[] } {
  const own = [...compiled]
    .map(([name]) => name)
    .filter(name => COMPILED_SCRIPT.test(name) && !testInfrastructure.has(name))
    .map(name => `${COMPILE_OUT_DIR}/${name}`);
  const installed = [...packageDirectories(packages)]
    .filter(([pkg]) => builtInProject(pkg.origin))
    .flatMap(([pkg, directory]) =>
      [...pkg]
        .map(([name]) => name)
        .filter(name => COMPILED_SCRIPT.test(name))
        .map(name => `node_modules/${directory}/${name}`)
    );
  return {
    links: { [COVERAGE_STAGE_DIR]: driver },
    argv: driver.toCommandLine([], { base: COVERAGE_STAGE_DIR }),
    measured: [...new Set([...own, ...installed])].sort(),
  };
}

/**
 * Split the run's output into the target's content, the report and coverage
 * report, and its write-back candidates, the refreshed snapshot files paired
 * with the tests they belong beside ({@link snapshotWriteBacks}, given
 * `recorded`, the records the run was staged with). With no candidate (every
 * `check` run), the plain report.
 */
function reshapeTestResult(result: FileSet, tests: FileSet, recorded: FileSet): FileSet {
  const { report = EMPTY_FILESET, snapshots } = result.partition(name =>
    name === TEST_REPORT_FILENAME || name === COVERAGE_REPORT_FILENAME ? "report" : "snapshots"
  );
  const candidates = snapshots ? snapshotWriteBacks(snapshots, tests, recorded) : [];
  return candidates.length === 0 ? report : new WriteBackFileSet(report, candidates);
}

/**
 * Make the write-back candidate for the refreshed snapshot files: each named
 * for the test source it belongs beside (`a/__snapshots__/Foo.test.tsx.snap`,
 * {@link snapshotNameFor}), for the driver to locate in the user's tree from
 * the provenance of `tests`.
 *
 * A runner may name a record for the compiled file (`Foo.test.js`, jest's
 * default) rather than the source (`Foo.test.tsx`), so a record is matched to
 * its test by exact source name, else by stem, and a brand-new record lands
 * under the source's name either way. A record with the same hash as the one
 * staged in `recorded` is left out, so a run that changed nothing offers
 * nothing.
 *
 * @return one candidate holding every changed record, or none.
 */
export function snapshotWriteBacks(snapshots: FileSet, tests: FileSet, recorded: FileSet): IWriteBackCandidate[] {
  const byStem = new Map<string, IFile>();
  const byName = new Map<string, IFile>();
  for (const [name, file] of snapshots) {
    const stem = snapshotStem(name);
    if (stem !== undefined && recorded.getFile(name)?.hash !== file.hash) {
      byStem.set(stem, file);
      byName.set(name, file);
    }
  }
  const refreshed = new Map<string, IFile>();
  for (const [name] of tests) {
    /* An exact match first (fabr's runners name a record for the source; see
     * SnapshotResolver), else the stem (a runner naming it for the compiled
     * file). The record is renamed for the source either way. */
    const file = byName.get(snapshotNameFor(name)) ?? byStem.get(stripExtension(name));
    if (file !== undefined) {
      refreshed.set(snapshotNameFor(name), file);
    }
  }
  return refreshed.size === 0 ? [] : [{ files: new FileSet(refreshed), belongsTo: SNAPSHOT_BELONGS_TO, origin: tests.origin }];
}

/** Name where a test source's record sits relative to it — jest's convention,
 * and the name a write-back lands under. */
function snapshotNameFor(testName: string): string {
  return posix.join(posix.dirname(testName), SNAPSHOT_DIR, `${posix.basename(testName)}.snap`);
}

/** Find the test stem a collected `<dir>/__snapshots__/<test file>.snap`
 * belongs to (`a/__snapshots__/Foo.test.js.snap` → `a/Foo.test`), or undefined
 * if the name isn't a snapshot file. Both extensions come off, the `.snap` and
 * the test file's own, so a record named for the compiled file and one named
 * for the source give the same stem. */
function snapshotStem(name: string): string | undefined {
  const dir = posix.dirname(name);
  if (posix.basename(dir) !== SNAPSHOT_DIR || !name.endsWith(".snap")) {
    return undefined;
  }
  return posix.join(posix.dirname(dir), stripExtension(posix.basename(name, ".snap")));
}
