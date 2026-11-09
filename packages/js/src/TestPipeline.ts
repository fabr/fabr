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
 * js_package[test]): compile the tests with the sources (a js_package's
 * sources checked and emitted by the package's build, which the install then
 * holds), assemble the runnable installation, and run the runner over the
 * compiled test files,
 * reporting through the test report contract defined by @fabr-build/core.
 *
 * What differs between test frameworks is an {@link ITestFramework}: which
 * runner runs the tests, and the module format it loads them as. Each framework
 * has its own rule per test target type, selected on the target's framework
 * property, and each rule passes its framework here. The runner executes
 * standalone inside the test working directory. The runner contract:
 *
 *     <runner> --report=<file> --env=<node|jsdom> [--update-snapshots]
 *              [--name-pattern=<regex>] [--setup=<module|./staged path>]…
 *              [--pnp=<file>] [--reads=<file>] <test files…>
 *
 * red exit status on failure, report written as CTRF. `--env` names the
 * environment the suite RUNS in, which follows the `dom` source flag rather than
 * the target it is emitted for (see where it is read, below);
 * `--update-snapshots` asks the runner
 * to rewrite recorded expectations instead of failing on them (see
 * TEST_EXPECTATIONS), which the pipeline then offers back to the source tree;
 * `--name-pattern` runs only the tests whose full names (suite names and the
 * test's own, joined by spaces) the JavaScript regular expression matches (see
 * TEST_NAME_PATTERN);
 * `--pnp` names the PnP table the test processes resolve packages through,
 * where the install has one in place of `node_modules` (the `layout/pnp`
 * flag; js-tools' `pnp/Runtime.ts`);
 * `--reads` asks for what the test processes loaded or read (js-tools'
 * `testRunner/Reads.ts`), from which the test step decides what a change
 * reaches;
 * each `--setup` names something every test process loads before any test file,
 * in the order given — fabr passes the target's conventional setup script (see
 * {@link SETUP_STEM}), and the contract stays plural because it is the runner's,
 * not this pipeline's.
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

/** The runner's ambient types for its preloaded globals, anywhere in its install */
const GLOBALS_TYPES_FILE = "test-globals.d.ts";
/** Where the runner install is staged in the test install, and where its
 * ambient-types file mounts so tsc auto-includes it for the test compile */
const RUNNER_STAGE_DIR = ".fabr-testrunner";
const GLOBALS_TYPES_MOUNT = "@types/fabr-test-globals/index.d.ts";
/* The runner's own globals .d.ts as it appears in @fabr-build/js-tools's srcs,
 * dropped when it tests itself so it doesn't collide with the synthetic mount. */
const RUNNER_GLOBALS_TYPES = "testRunner/test-globals.d.ts";

/** Where a measured run stages the coverage driver's install. */
const COVERAGE_STAGE_DIR = ".fabr-coverage";

/** A compiled JavaScript file, which a measured run measures. */
const COMPILED_SCRIPT = /\.[cm]?js$/;

/** The directory a test file's recorded snapshots live in, beside it — jest's
 * convention, and fabr's: the staged inputs land there (they are ordinary
 * `srcs`) and the runner writes updates back there. */
const SNAPSHOT_DIR = "__snapshots__";

/**
 * How a recorded snapshot's name names the test it belongs to — jest's layout
 * convention, stated once as a rename projection instead of resolved per file.
 * `a/__snapshots__/Foo.test.ts.snap` → `a/Foo.test.ts`; at the tree root the
 * `**` captures nothing and the renamer normalizes the stray separator.
 *
 * This is what the driver applies to find the input each offered record belongs
 * beside — so the convention lives here, in the rule that owns it, and the
 * driver stays free of any notion of what a snapshot is.
 */
const SNAPSHOT_BELONGS_TO = parseName(`**/${SNAPSHOT_DIR}/*.snap`).withRenameTo(parseName("**/*"));

/**
 * The conventional per-target setup script: a source named `setupTests`
 * (`.ts`, `.js`, …) at the root of the target's source tree is loaded into
 * every test process before any test file — the jest ecosystem's
 * `setupTests.js` convention, and the usual home for environment polyfills and
 * suite-wide mocks.
 *
 * A convention, not a property: the file is an ordinary source, so it
 * compiles with the tests, may be TypeScript, and may use the test globals.
 */
const SETUP_STEM = "setupTests";

/**
 * Extract the runner's ambient globals types from its resolved install (a
 * test-globals.d.ts anywhere among its files) and mounted as the synthetic
 * @types package the test compile auto-includes; empty when the runner ships
 * none. Part of the runner contract for a framework whose runner supplies them
 * ({@link ITestFramework.globalsTypes}), so a replaced runner carries its own
 * globals typings with it rather than inheriting fabr's.
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
 * The test frameworks, by the name a target selects one with.
 *
 * `node` and `jest` compile to CommonJS: call-time `require` is what makes
 * module substitution (the jest layer's mocking) observable at all, and it is
 * the seam such a layer intercepts. Vitest is itself an ES-module graph that a
 * CommonJS test cannot `require`, and does its own hoisting over ES modules.
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

/** What a test target requires, as written (unmaterialized): everything the
 * evaluation consumes from the build graph, so it all resolves jointly. */
export type TestRequirements = {
  /** The package a js_package's tests test, as its build makes it in the
   * module format their framework loads; nothing for a js_test. */
  package: PackageSources;
  srcs: SourceRef[];
  tests: SourceRef[];
  /** A js_package[test] folds its `provided_deps` in here — a test install is
   * self-contained, so a peer is just another dep with no host to supply it
   * and no manifest to distinguish it. */
  deps: PackageSources;
  /** Packages compiled against and installed like `deps`, whose flags say
   * nothing of the test run (`dom` here is the DOM's types, with no DOM to run
   * in). */
  compile_deps: PackageSources;
  /** Test-only packages (assertion libraries and their @types), available to
   * both the test compile and the test run but never to the package build */
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
  return Computable.forAll([testFramework(context, property), context.getGlobalString("JS_TARGET", BUILD_OVERRIDE)], (framework, target) => {
    const jsTarget = parseJSTarget(target);
    return jsTarget.module === framework.module
      ? BUILD_OVERRIDE
      : BUILD_OVERRIDE.with(Constraints.of({ JS_TARGET: formatJSTarget(testTargetOf(jsTarget, framework)) }));
  });
}

/**
 * Run the shared test pipeline: compile the tests in one program with the
 * sources, so their relative imports resolve against the code under test — a
 * js_package's sources checked and emitted not here but by the package's build,
 * the `package` requirement, whose declarations the compile is given — lay the
 * result out as a runnable installation, beside the package, together with the
 * deps, the test-only deps and the runner, and execute the runner over the
 * compiled test files. The output artifact is the test report; a red run fails the target with the report's
 * failure summary.
 *
 * The last argument is the target's {@link TestRequirements}, materialized:
 * resolved as one collection, so the consumer's pins govern the lot. The
 * runner and the compile toolchain are not among them: they are tools,
 * independent of what they test or compile, and resolve apart. The target
 * the tests are compiled for is `JS_TARGET` under the build operation.
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
    /* No tests declared: trivially green (and no runner is needed). A declared
     * test that yields no runnable output is NOT this case — it errors below. */
    return Computable.resolve(EMPTY_FILESET);
  }
  /* Compile srcs and tests together (tests are normally within srcs), so the
   * tests are checked in the program the sources make. A js_package's own
   * sources were checked and emitted by its build: its declarations go with
   * them, and the compile checks and emits only the rest. The globals
   * declarations come in via the synthetic @types mount, so a copy among the
   * sources (the runner testing itself) is dropped. */
  const tested = testedSets.find((set): set is PackageFileSet => set instanceof PackageFileSet);
  const sources = FileSet.unionAll(...srcs, tests).remap(name => (name === RUNNER_GLOBALS_TYPES ? undefined : name));
  const declarations = tested === undefined ? undefined : stripPackageJson(tested).remap(name => (DECLARATION_FILE.test(name) ? name : undefined));
  /* The declared test sources' stems (path minus extension). Their compiled `.js`
   * are picked out of the *actual* compiled tree by stem in planTestRun, so the
   * source→output naming is never re-derived here — js_compile owns it. */
  const testStems = new Set([...tests].map(([name]) => stripExtension(name)));
  /* The runner is a *tool*, independent of what it tests, so it resolves
   * apart (the TSC precedent — its pins don't co-resolve with the tests'
   * deps). */
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
      /* The test compile may import the package's deps, the test_deps, and the
       * runner globals directly (all passed to compileJsSources). The runtime
       * install splits them like RunJSScript: packages mount as node_modules,
       * while a loose *resource* dep (.json, a template) stages at the install
       * root next to the compiled tests, so a `./x.json` import resolves. Compilable loose deps (.ts/.js) are excluded here — their
       * output already rides the compiled tree (and a raw .js would collide). */
      const allDeps = [...deps, ...testDeps];
      const packages = allDeps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
      const resources = resourceFiles(allDeps.filter(dep => !(dep instanceof PackageFileSet)));

      const testTarget = testTargetOf(jsTarget, framework);
      return testCompile(context, framework, settings, { sources, declarations, deps, testDeps, runner, testTarget }).then(built => {
        if (built.sources.ts.isEmpty() && built.sources.js.isEmpty() && built.sources.jsx.isEmpty()) {
          /* Tests are declared but none is a compilable source (.ts/.tsx/.js/.jsx),
           * so there is nothing to run — a loud failure, not a silent green. */
          throw new FabrError("Test target declares test files but none is a compilable source");
        }
        return planTestRun(context, {
          /* The tests' output beside the package's own, as one tree, where what
           * the package ships is the package's: a JSON source both import is
           * emitted by the package's compile and passed through, as written,
           * by the tests'. */
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
          /* The suite's environment follows the `dom` SOURCE flag, not the
           * target it is emitted for: a tree that uses the DOM needs jsdom
           * however it is built, and one that does not should run under plain
           * node even when its bundle is emitted for a browser. Read off
           * `deps` AND `test_deps` — the same flags the test compile sees, so
           * a suite whose TESTS need a DOM its sources do not (a component
           * library rendering in its tests) declares `dom` in test_deps and
           * gets both the lib and the environment. */
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
      });
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
  /* The target is set unconditionally, including when the package already
   * emits that format: the override is then a different SPELLING of the same
   * target (`es2020` formats back as `es2020-commonjs-node`), which parses
   * identically and yields an identical tsconfig. Stylesheets among the
   * sources are built as a package would build them. */
  return compileContents(context, sources, [...deps, ...testDeps, framework.globalsTypes ? runnerGlobalsTypes(runner) : EMPTY_FILESET], {
    packageName: settings.packageName,
    declarations,
    constraints: Constraints.of({ JS_TARGET: formatJSTarget(testTarget) }),
    /* A distinct label: the test compile is its own work item (its tree
     * includes the tests), with its own incremental base. */
    label: describe ? "Describing tests for" : "Compiling tests for",
    describe,
  });
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
  return requirements.describeAll().then(({ srcs, tests: testSets, deps: runtimeDeps, compile_deps: compileDeps, test_deps: testDeps }) => {
    const deps = [...runtimeDeps, ...compileDeps];
    const tests = FileSet.unionAll(...testSets);
    if (tests.isEmpty()) {
      return Computable.resolve(EMPTY_FILESET);
    }
    const sources = FileSet.unionAll(...srcs, tests).remap(name => (name === RUNNER_GLOBALS_TYPES ? undefined : name));
    /* The runner is wanted only for the globals typings it supplies. */
    return Computable.forAll(
      [framework.globalsTypes ? context.getGlobalRunnable(framework.runner) : Computable.resolve(EMPTY_FILESET), context.getGlobalString("JS_TARGET", BUILD_OVERRIDE)],
      (runner, target) =>
        testCompile(context, framework, settings, { sources, deps, testDeps, runner, testTarget: testTargetOf(parseJSTarget(target), framework) }, true)
          .then(built => {
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

/** Select the runnable test files: the JS entries of the *actual* compiled tree
 * whose stem is one of the declared tests' stems, sorted for determinism. No
 * source→output name is predicted — js_compile named these; we only select.
 * `.mjs`/`.cjs` are the outputs of a `.mts`/`.cts` test. The root setup script
 * ({@link selectCompiledSetupFile}) is never one, though it may be declared
 * among the tests to compile with them. */
export function selectCompiledTestFiles(compiled: FileSet, testStems: Set<string>): string[] {
  return [...compiled]
    .map(([name]) => name)
    .filter(name => /\.[cm]?js$/.test(name) && testStems.has(stripExtension(name)) && stripExtension(name) !== SETUP_STEM)
    .sort();
}

/**
 * Select the compiled setup script, or undefined for a target that has none.
 *
 * Selected out of the ACTUAL compiled tree by stem, exactly as the test files
 * are — the source→output naming is js_compile's, never re-derived here. It is
 * the file at the tree's ROOT (jest's `<rootDir>/setupTests.js`, in fabr's
 * terms the root of the target's own source tree, wherever that ends up
 * mounted); one nested inside is an ordinary source, so a `helpers/setupTests.ts`
 * cannot quietly become suite-wide setup. Two at the root (a `.ts` and a `.cts`,
 * say) are ambiguous and a loud failure.
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
  /** The package the sources may import themselves by, if any — see selfMount. */
  packageName?: string;
  update: boolean;
  /** The regular expression selecting the tests run by name, if any. */
  namePattern?: string;
  /** Where the run is measured for coverage: the program converting what the
   * test processes record, and the packages installed for the run, of which
   * those built in the project are measured. */
  coverage?: { driver: RunnableFileSet; packages: PackageFileSet[] };
}

/**
 * Plan the test run: the run's own files (the compiled tree — the output of the
 * shared js_compile sub-target — a minimal package.json and any copied
 * sources) are assembled in resolution and passed as concrete inputs to the
 * test-run action, which lays out the packages as its `deps` and links the
 * runner's install at {@link RUNNER_STAGE_DIR}.
 *
 * The run is yielded as the test-run action with a reshape
 * ({@link reshapeTestResult}): the report, failures and all, is the target's
 * content, and any refreshed snapshot files become write-back candidates
 * paired with their source locations. The reshape is applied every evaluation, so the candidates
 * reconstruct on the CACHE-HIT path too (a warm replay of an update run whose
 * writes were never applied still offers them).
 */
function planTestRun(context: TargetContext, run: ITestRun): Computable<RuleResult> {
  return run.compiled.then(compiledTree => {
    /* Pick the runnable test files out of the real compiled tree (js_compile named
     * them) rather than re-deriving names from the sources. Empty here means the
     * declared tests produced no runnable output — a loud failure, not a green. */
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
    /* Laid out AS THE COMPILE LAID IT OUT — output under `build/`, sources under
     * `src/` — so a map entry naming its source relatively still resolves, and
     * {@link SOURCE_LOCATIONS_FILE} records where each source with a source path
     * is staged, for a runner opening the source a map's `fabr:` entry names.
     * `node_modules` and `package.json` stay at the root, where node's walk-up
     * finds them from `build/` just as well.
     *
     * `build/` is ALSO the working directory (see the test-run action): a test's paths —
     * `./x` from cwd or `__dirname`-relative alike — then mean what they mean in
     * the source tree, since the compiled tree mirrors it. */
    const coverage = run.coverage && measuredRun(run.coverage, compiledTree, new Set([...testFiles, ...(setupFile ? [setupFile] : [])]));
    const pnp = run.layout === "pnp";
    if (pnp && coverage !== undefined) {
      throw new FabrError("Measuring coverage needs the tests' packages in a node_modules tree; drop layout/pnp for --coverage");
    }
    /* The run's own files. The packages are the action's `deps`, which the step
     * lays out as `layout` says, so they key as a compile's do and no tree is
     * built to look an entry up. */
    const files = FileSet.layout({
      "package.json": packageJson,
      /* Resources and records join the compiled tree, which is also the working
       * directory: a test's `./x` means the same thing here as in the source
       * tree, with no rename to re-encode fabr's layout in the declaration. */
      [COMPILE_OUT_DIR]: [runtime, run.testResources, run.expectations],
      [COMPILE_SRC_DIR]: [run.compileSrcs],
      /* Where each staged source is, by its source path: the compile's maps
       * name a source by its reference, and a runner reading one (the jest
       * flavour's docblock) opens it from here. */
      [SOURCE_LOCATIONS_FILE]: sourceLocations(run.compileSrcs),
    });
    /* The runner's node is reached through the tree pool by its content hash
     * (`RunnableFileSet.launchedBy`), so no host path enters the action
     * manifest.
     *
     * The invocation carries neither the report name nor the test files: the
     * step invokes the runner once PER FILE (the contract permits any partition
     * of the files), appending a per-invocation report name and the file — so
     * each execution is admitted separately by the machine-wide process funnel. */
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
    /* Under `check` the run's only output is the report; under `update` the
     * refreshed snapshot files are collected too. The selectors ride the action
     * manifest, so the two modes can never share a cache entry. */
    /* Collected THROUGH the `build/` mount (`dir:glob` names results relative to
     * `dir`), so the refreshed records come back named as the compiled tree
     * names them — the namespace the tests and the staged records are already
     * matched in. */
    const outputs = [
      TEST_REPORT_FILENAME,
      ...(coverage ? [COVERAGE_REPORT_FILENAME] : []),
      ...(run.update ? [`${COMPILE_OUT_DIR}:${SNAPSHOT_DIR}/*.snap`, `${COMPILE_OUT_DIR}:**/${SNAPSHOT_DIR}/*.snap`] : []),
    ];
    /* Under `update` the runner REWRITES the recorded files it was given, so
     * those inputs must be staged as writable copies. The DECLARED
     * `expectations` are that set, not whatever happens to sit in a
     * `__snapshots__` directory. Everything else is staged as a hardlink into
     * the content store, where the blob is read-only: writing through such a
     * link would corrupt the entry every other build shares. */
    const records = run.update ? run.expectations : EMPTY_FILESET;
    /* The action stages by INSTALL name, so the writable set is the same records
     * seen through the mount; the comparison below wants them in the compiled
     * tree's own namespace, which is what `records` is. */
    const writable = FileSet.layout({ [COMPILE_OUT_DIR]: [records] });
    /* The run's output is given its delivered shape — the report, and what it
     * offers back to the tree — every evaluation, so refreshed records reach
     * the driver on a cache hit as well as on a miss. */
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
): { links: Record<string, FileSet>; argv: string[]; measured: string[] } {
  const own = [...compiled]
    .map(([name]) => name)
    .filter(name => COMPILED_SCRIPT.test(name) && !testInfrastructure.has(name))
    .map(name => `${COMPILE_OUT_DIR}/${name}`);
  const installed = [...packageDirectories(packages)]
    .filter(([pkg]) => builtInProject(pkg.origin))
    .flatMap(([pkg, directory]) =>
      [...pkg].map(([name]) => name).filter(name => COMPILED_SCRIPT.test(name)).map(name => `node_modules/${directory}/${name}`)
    );
  return {
    links: { [COVERAGE_STAGE_DIR]: driver },
    argv: driver.toCommandLine([], { base: COVERAGE_STAGE_DIR }),
    measured: [...new Set([...own, ...installed])].sort(),
  };
}

/**
 * Split the run's output into what the target delivers and what it offers: the
 * report is the content, and each refreshed snapshot file is paired with the
 * source-tree location of the test it belongs to (see {@link snapshotWriteBacks}).
 * With nothing to offer — every `check`-mode run — the plain report stands.
 *
 * `recorded` is the staged input the run was given, so that a record it
 * reproduced unchanged can be dropped — see {@link snapshotWriteBacks}.
 */
function reshapeTestResult(result: FileSet, tests: FileSet, recorded: FileSet): FileSet {
  const { report = EMPTY_FILESET, snapshots } = result.partition(name =>
    name === TEST_REPORT_FILENAME || name === COVERAGE_REPORT_FILENAME ? "report" : "snapshots"
  );
  const candidates = snapshots ? snapshotWriteBacks(snapshots, tests, recorded) : [];
  return candidates.length === 0 ? report : new WriteBackFileSet(report, candidates);
}

/**
 * Pair each refreshed snapshot file with where it belongs in the user's tree.
 *
 * The run works in compiled names (`Foo.test.js`) and the source tree in source
 * names (`Foo.test.tsx`), so the two sides are matched by exact source name,
 * else on the **stem** — for a runner that names a record after the compiled
 * file. That also handles a brand-new snapshot, which the runner necessarily
 * emits under the compiled name: the destination name is derived here, from the
 * test source, so what lands in the tree is jest's standard `<test file>.snap`
 * either way.
 *
 * Each candidate names the TEST it belongs beside; resolving that to a place on
 * disk is the driver's job, so nothing here is a host path and a test with no
 * source location (a generated one) needs no special case — the driver finds it
 * unplaceable and says so.
 *
 * A record the run reproduced unchanged is **not offered at all**: `recorded`
 * is the staged input it was given, and both sides are already hashed, so
 * changed-ness is decided here. What comes out is exactly the set of real
 * changes, so the driver's write is unconditional and a no-op update run never
 * touches the tree.
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
    /* An exact name match first — fabr's own runner names a record for the
     * source (see SnapshotResolver), so this is the ordinary path. The stem
     * fallback keeps the contract honest for a runner that names records after
     * the compiled file it ran, which is jest's own default. Either way the record is REKEYED to the source
     * name here, which is what makes the correspondence a pure naming rule the
     * driver can apply without knowing anything about snapshots. */
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
 * if the name isn't a snapshot file. Both extensions come off: the `.snap`,
 * then the test file's own — which is what makes a compiled name and a source
 * name meet. */
function snapshotStem(name: string): string | undefined {
  const dir = posix.dirname(name);
  if (posix.basename(dir) !== SNAPSHOT_DIR || !name.endsWith(".snap")) {
    return undefined;
  }
  return posix.join(posix.dirname(dir), stripExtension(posix.basename(name, ".snap")));
}

