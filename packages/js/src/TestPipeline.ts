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
 * A test framework ({@link ITestFramework}) says which runner runs the tests,
 * the module format it loads them as, and how it names their records. Each
 * test target type's rule looks up the framework its target's framework
 * property names ({@link testFramework}) and passes it here. The runner runs in
 * the installation's compiled tree, its working directory, invoked as
 *
 *     <runner> --report=<file> --env=<node|jsdom> [--update-snapshots]
 *              [--name-pattern=<regex>] [--setup=<module|./staged path>]…
 *              [--pnp=<file>] [--reads=<file>] [--artifacts=<dir>]
 *              [--retries=<n>] [--only=<ignore|forbid>] <test files…>
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
 * - `--pnp`: the PnP table the run's node processes resolve packages through,
 *   where the installation has one in place of `node_modules` (the `layout/pnp`
 *   flag). Beside it is the PnP runtime's preload ({@link pnpPreloadOf}); the
 *   runner loads it before anything else, which installs the runtime in the
 *   runner and every node process it starts, and lists the table among its
 *   reads.
 * - `--reads`: where to write what the test processes loaded or read (js-tools'
 *   `testRunner/Reads.ts`), from which the test step decides what a change
 *   reaches.
 * - `--artifacts`: where to keep the files of its tests the runner's report
 *   attaches to them, for a framework whose runner keeps any
 *   ({@link ITestFramework.artifacts}).
 * - `--only`: what to do with focused tests (`.only`, jest's `fit`): run them as
 *   any other test (`ignore`), or fail a test file that has one (`forbid`);
 *   without it they run alone in their file (TEST_ONLY_HANDLING). A runner
 *   whose framework cannot do one of them refuses it.
 * - `--retries`: how many times to retry a failed test within the run, for a
 *   framework whose runner schedules the test files itself
 *   ({@link ITestFramework.scheduler}); fabr reruns the files it schedules.
 * - `--interactive`: under `fabr run`, start the framework's own interactive
 *   run in place of a test run, writing no report. The runner is started in
 *   the installation as `<runner> <options> --interactive <compiled tree>
 *   <test files…> -- <arguments…>`, works in the compiled tree as in a test
 *   run, and gives the arguments after `--` to the framework's command. A
 *   runner that has no interactive run refuses it.
 */

import {
  BUILD_OVERRIDE,
  builtInProject,
  Computable,
  Constraints,
  COVERAGE,
  COVERAGE_ON,
  COVERAGE_REPORT_FILENAME,
  describeTarget,
  descriptionFile,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  Flag,
  formatOf,
  IFile,
  IWriteBackCandidate,
  mapComputable,
  MemoryFile,
  Name,
  PackageFileSet,
  PackageSources,
  parseJson,
  parseName,
  PropertyMap,
  ResolutionSpec,
  RuleResult,
  RunnableArgument,
  RunnableFileSet,
  secure,
  SecureString,
  selectTestFiles,
  SourceRef,
  TargetContext,
  TEST_EXPECTATIONS,
  TEST_FILE_PATTERN,
  TEST_FLAKE_RETRIES,
  TEST_NAME_PATTERN,
  testFilePatternsOf,
  patternsText,
  TEST_ONLY_HANDLING,
  TEST_REPORT_FILENAME,
  toEnvironment,
  toFlakeRetries,
  toJsonObject,
  toTestStability,
  TREE_MOUNT,
  type TestStability,
  type Unmaterialized,
  UPDATE_EXPECTATIONS,
  walkPackages,
  WriteBackFileSet,
} from "@fabr-build/core";
import { type ITypeScriptPayload, layOutUnits, TSSERVER_PLUGIN, TYPESCRIPT_DATA_KIND } from "./Description";
import { PNP_DATA_FILE, PNP_PRELOAD, SOURCE_LOCATIONS_FILE } from "@fabr-build/js-tools";
import { layoutProgram, NodeLayout, pnpPreloadOf } from "./Layout";
import { createTestRunAction, type IMeasuredFiles } from "./TestRunAction";
import { posix } from "path";
import { COMPILE_OUT_DIR, COMPILE_SRC_DIR } from "./rules/BuildJSCompile";
import {
  compileContents,
  DECLARATION_FILE,
  esLevelOrder,
  type ICompiledContents,
  formatJSTarget,
  PinnedJSTarget,
  moduleTypeFile,
  parseJSTarget,
  layoutOf,
  resourceFiles,
  stripExtension,
  stripPackageJson,
  compileSourcesOf,
  classifySourceByExt,
  classifySources,
  usesDom,
} from "./JSPackage";
import { cssImportRewrites, isCssModule, loweredCssName } from "./CSSCompile";

/** The runner's types for the globals it installs, anywhere in its install. */
const GLOBALS_TYPES_FILE = "test-globals.d.ts";
/** Where the runner's install is staged in the test installation. */
const RUNNER_STAGE_DIR = ".fabr-testrunner";
/** Where the PnP runtime the preload loads is linked into a `layout/pnp`
 *  installation; the preload reaches it through the pool. */
const PNP_RUNTIME_STAGE_DIR = ".fabr-pnp-runtime";
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
  /** How the runner names a test file's recorded expectations. */
  records: ITestRecords;
  /** The lowest ES level the tests, and the package a js_package's tests
   * test, are emitted at, where the framework has one. */
  minimumEsLevel?: string;
  /** Whether the runner is given a directory for the files it keeps of its
   * tests (`--artifacts`), which the target's result then holds. Only a
   * runner that schedules the test files (`scheduler: "runner"`) is given one. */
  artifacts?: boolean;
  /**
   * Which schedules the test files across processes: `fabr`, one runner
   * invocation per file within fabr's process limit; or the `runner` itself,
   * given every file in one invocation, across its own workers. A run the
   * runner schedules is not measured for coverage.
   */
  scheduler: "fabr" | "runner";
  /** Whether its tests drive a browser, which a `browser_test` supplies: only
   * a `browser_test` may name it. */
  browser?: boolean;
  /** Whether its runner can run a focused test (`.only`) as any other, for
   * TEST_ONLY_HANDLING=ignore; true where unset. */
  ignoresFocus?: boolean;
}

/**
 * How a framework's runner names the recorded expectations of a test file. The
 * declared records are staged in the compiled tree as the runner reads them,
 * an update run collects what the runner wrote, and the records it changed are
 * offered back to the source tree under their sources' names.
 *
 * `compiledOf` maps each test source's name to its compiled file's (`a/Foo.spec.ts`
 * → `a/Foo.spec.js`); both are named in the compiled tree's namespace.
 */
export interface ITestRecords {
  /** Name the declared records as the runner reads them. */
  stage(expectations: FileSet, compiledOf: ReadonlyMap<string, string>): FileSet;
  /** Get the patterns, within the compiled tree, of the files an update run
   * collects: `staged` is what {@link stage} made. */
  collected(staged: FileSet, compiledOf: ReadonlyMap<string, string>): string[];
  /**
   * Make the write-back candidates from what an update run collected, named in
   * the compiled tree. `staged` is what {@link stage} made of the declared
   * records, `tests` the declared test sources.
   */
  writeBacks(collected: FileSet, staged: FileSet, tests: FileSet, compiledOf: ReadonlyMap<string, string>): IWriteBackCandidate[];
}

/** No records: a runner that compares against none (Cypress) collects nothing and offers nothing back. */
const NO_RECORDS: ITestRecords = {
  stage: expectations => expectations,
  collected: () => [],
  writeBacks: () => [],
};

/**
 * Records named jest's way: one `__snapshots__/<test source name>.snap` beside
 * each test file, staged as declared. A record a runner names for the compiled
 * file is matched to its test by stem ({@link snapshotWriteBacks}).
 */
const SNAPSHOT_RECORDS: ITestRecords = {
  stage: expectations => expectations,
  collected: () => [`${SNAPSHOT_DIR}/*.snap`, `**/${SNAPSHOT_DIR}/*.snap`],
  writeBacks: (collected, staged, tests) => snapshotWriteBacks(collected, tests, staged),
};

/**
 * Records in a directory named for the compiled test file: Playwright's
 * `<test file>-snapshots/` beside it by default, or any directory its
 * `snapshotPathTemplate` names with `{testFileName}` or `{testFilePath}`. A
 * directory of a record's path that is a test source's file name, or begins
 * with it followed by `-`, is staged under the compiled file's name, and
 * offered back under the source's ({@link recordOf}).
 *
 * An update run collects every file under such a directory, and each declared
 * record by its name, so a record the template places in no directory named
 * for its test is updated but never created.
 */
const TEST_FILE_RECORDS: ITestRecords = {
  stage: (expectations, compiledOf) => expectations.remap(name => recordOf(name, compiledOf)?.name ?? name),
  collected: (staged, compiledOf) => [
    ...[...new Set([...compiledOf.values()].map(name => escapeGlob(posix.basename(name))))].flatMap(base => [
      `**/${base}-*/**`,
      `**/${base}/**`,
    ]),
    ...[...staged].map(([name]) => escapeGlob(name)),
  ],
  writeBacks: (collected, staged, tests, compiledOf) => {
    const sourceOf = new Map([...compiledOf].map(([source, compiled]) => [compiled, source]));
    const byTest = new Map<string, Map<string, IFile>>();
    for (const [name, file] of collected) {
      const record = staged.getFile(name)?.hash === file.hash ? undefined : recordOf(name, sourceOf);
      const test = record === undefined ? undefined : sourceOf.get(record.test);
      if (record !== undefined && test !== undefined) {
        byTest.set(test, (byTest.get(test) ?? new Map<string, IFile>()).set(record.name, file));
      }
    }
    return [...byTest].map(([test, files]) => ({
      files: new FileSet(files),
      belongsTo: parseName("**").withRenameTo(Name.fromLiteral(test)),
      origin: tests.origin,
    }));
  },
};

/**
 * Find the test file a record named `name` belongs to, among the keys of
 * `renames`: the test whose file name is one of the record's directories, or
 * begins one followed by `-`. A test whose own directories lead to that
 * directory is preferred, the more of them the better
 * (`a/Foo.spec.ts-snapshots/x.png` is `a/Foo.spec.ts`'s), then the first test
 * by name.
 *
 * @return that test, and the record's name with that directory renamed for
 *   the test's value in `renames` (`a/Foo.spec.js-snapshots/x.png`); undefined
 *   where no test's name is among the record's directories.
 */
export function recordOf(name: string, renames: ReadonlyMap<string, string>): { test: string; name: string } | undefined {
  const parts = name.split("/");
  let best: { test: string; index: number; depth: number } | undefined;
  for (const test of [...renames.keys()].sort()) {
    const base = posix.basename(test);
    const testDirs = posix.dirname(test) === "." ? [] : posix.dirname(test).split("/");
    parts.slice(0, -1).forEach((part, index) => {
      if (part !== base && !part.startsWith(`${base}-`)) {
        return;
      }
      const before = parts.slice(0, index);
      const leads =
        testDirs.length <= before.length && testDirs.every((dir, i) => before[before.length - testDirs.length + i] === dir);
      const depth = leads ? testDirs.length + 1 : 0;
      if (best === undefined || depth > best.depth) {
        best = { test, index, depth };
      }
    });
  }
  if (best === undefined) {
    return undefined;
  }
  const { test, index } = best;
  const renamed = [...parts];
  renamed[index] = posix.basename(renames.get(test)!) + parts[index].slice(posix.basename(test).length);
  return { test, name: renamed.join("/") };
}

/** @return `name` with every glob metacharacter escaped, so it matches only itself. */
function escapeGlob(name: string): string {
  return name.replace(/[*?[\]{}()!+@\\]/g, char => `\\${char}`);
}

/**
 * The test frameworks, by the name a target selects one with. `node` and `jest`
 * load tests as CommonJS (the jest layer's mocking intercepts call-time
 * `require`); `vitest` loads them as ES modules; `playwright` as CommonJS, with
 * its records named for the compiled test file; `cypress` bundles the compiled
 * CommonJS itself, and compares against no records.
 */
export const TEST_FRAMEWORKS: ReadonlyMap<string, ITestFramework> = new Map([
  ["node", { runner: "JS_NODE_TEST_RUNNER", module: "commonjs", globalsTypes: true, records: SNAPSHOT_RECORDS, scheduler: "fabr" }],
  ["jest", { runner: "JS_JEST_RUNNER", module: "commonjs", globalsTypes: false, records: SNAPSHOT_RECORDS, scheduler: "fabr" }],
  [
    "vitest",
    {
      runner: "JS_VITEST_RUNNER",
      module: "esm",
      globalsTypes: false,
      records: SNAPSHOT_RECORDS,
      scheduler: "fabr",
      ignoresFocus: false,
    },
  ],
  [
    "playwright",
    {
      runner: "JS_PLAYWRIGHT_RUNNER",
      module: "commonjs",
      globalsTypes: false,
      records: TEST_FILE_RECORDS,
      minimumEsLevel: "es2017",
      artifacts: true,
      scheduler: "runner",
      browser: true,
      ignoresFocus: false,
    },
  ],
  [
    "cypress",
    {
      runner: "JS_CYPRESS_RUNNER",
      module: "commonjs",
      globalsTypes: false,
      records: NO_RECORDS,
      artifacts: true,
      scheduler: "runner",
      browser: true,
    },
  ],
]);

/**
 * Get the test framework the target's STRING property `property` names: one
 * that drives a browser where `browserTest`, else one that does not. Fails
 * naming the frameworks the target may name where it names none of them, with
 * help where a target that is not a browser_test names one that drives a
 * browser.
 */
export function testFramework(context: TargetContext, property: string, browserTest = false): Computable<ITestFramework> {
  return context.getRequiredProperty(property).then(name => {
    const written = name.toDisplayString();
    const framework = TEST_FRAMEWORKS.get(name.toString().toUnmaskedString());
    const offered = [...TEST_FRAMEWORKS].filter(([, each]) => (each.browser ?? false) === browserTest).map(([key]) => key);
    if (framework?.browser === true && !browserTest) {
      throw new FabrError(`'${written}' tests drive a browser, which a browser_test supplies`).withHelp(
        "declare them as a browser_test, with `include @fabr-build/js:lib/BROWSER_TEST.fabr;`"
      );
    }
    if (framework === undefined || (framework.browser ?? false) !== browserTest) {
      throw new FabrError(`'${written}' is not a ${browserTest ? "browser " : ""}test framework (${offered.join(", ")})`);
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
  /** The STRING property saying how far the tests' results are trusted
   * ({@link TestStability}): `test_stability` on a js_package, `stability` on a
   * js_test. */
  stabilityProperty: string;
  /** The package name a js_package[test]'s sources may import themselves by; a
   * standalone js_test has no package identity and leaves it unset. */
  packageName?: string;
  /** Environment variables the target sets over those `envProperty` declares. */
  env?: ReadonlyMap<string, SecureString>;
  /** Options the target gives the runner before its own (a browser test's
   * browser), a path among them relative to the directory the runner starts
   * in: the compiled tests under `fabr test`, the install under `fabr run`. */
  runnerArgs?: ReadonlyArray<RunnableArgument>;
  /** Installs the target links into a test run beside the runner's install, by
   * name, which `runnerArgs` name as `../<name>/<path>`. */
  links?: ReadonlyMap<string, FileSet>;
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
 * with `JS_TARGET` set to the test target of the framework the target's STRING
 * property `property` names ({@link testTargetOf}: its module format, at no
 * lower an ES level than its minimum), where the package is not already built
 * for it. A package already built for it is the build `fabr build` makes.
 */
export function packageBuildOverrides(context: TargetContext, property: string): Computable<Constraints> {
  return Computable.forAll(
    [testFramework(context, property), context.getGlobalString("JS_TARGET", BUILD_OVERRIDE)],
    (framework, target) => {
      const jsTarget = parseJSTarget(target.toUnmaskedString());
      const tested = testTargetOf(jsTarget, framework);
      return jsTarget.module === tested.module && jsTarget.version === tested.version
        ? BUILD_OVERRIDE
        : BUILD_OVERRIDE.with(Constraints.of({ JS_TARGET: formatJSTarget(tested) }));
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
 * With `interactive`, yield the installation as a program instead, the
 * framework's own run over the tests ({@link planInteractiveRun}).
 *
 * Yields empty content where no test file is declared, or TEST_FILE_PATTERN
 * selects none of them, and with `interactive` rejects there instead; only
 * the selected test files run. Throws where tests are declared but the
 * compile has no compilable source.
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
  }: TestContents,
  interactive = false
): Computable<RuleResult> {
  const deps = [...runtimeDeps, ...compileDeps];
  const tests = FileSet.unionAll(...testSets);
  if (tests.isEmpty()) {
    /* No test files: nothing to run, and no runner is fetched. Declared tests
     * with no runnable output are an error, below. */
    if (interactive) {
      return Computable.reject(new FabrError("The target has no tests to run: its tests name no file"));
    }
    return Computable.resolve(EMPTY_FILESET);
  }
  /* Compile the sources and tests together (the tests are usually among the
   * sources). A js_package's sources come with the declarations its build
   * emitted, and the compile checks and emits only the rest. A copy of the
   * runner's globals types among the sources (the runner testing itself) is
   * dropped: they come in through the `@types` mount. */
  const tested = testedSets.find((set): set is PackageFileSet => set instanceof PackageFileSet);
  const compiledSources = compileSourcesOf(FileSet.unionAll(...srcs, tests)).remap(name =>
    name === RUNNER_GLOBALS_TYPES ? undefined : name
  );
  /* A js_package's build lowered its stylesheets: the compile leaves them out,
   * and the tests' imports of them name what the build wrote, a css-module's
   * class-name module typed by the declaration the build emitted for it. */
  const sources =
    tested === undefined
      ? compiledSources
      : FileSet.unionAll(
          compiledSources.remap(name => (classifySourceByExt(name) === "css" ? undefined : name)),
          classNameDeclarations(compiledSources, tested)
        );
  const stylesheets =
    tested === undefined || classifySources(compiledSources).css.isEmpty()
      ? undefined
      : stripPackageJson(tested).remap(name => (classifySourceByExt(name) === "css" ? name : undefined));
  const declarations =
    tested === undefined ? undefined : stripPackageJson(tested).remap(name => (DECLARATION_FILE.test(name) ? name : undefined));
  return context.getGlobalString(TEST_FILE_PATTERN).then((filePattern): Computable<RuleResult> => {
    /* The tests a run runs (TEST_FILE_PATTERN): where none is selected, nothing
     * runs and no runner is fetched. */
    const selected = selectTestFiles(tests, filePattern);
    if (selected.isEmpty()) {
      if (interactive) {
        return Computable.reject(
          new FabrError(`No test file matches ${patternsText(testFilePatternsOf(filePattern.toDisplayString()))}`)
        );
      }
      return Computable.resolve(EMPTY_FILESET);
    }
    /* The selected test sources' stems (path minus extension): planTestRun picks
     * their compiled files out of the compiled tree by stem. */
    const testStems = new Set([...selected].map(([name]) => stripExtension(name)));
    /* The runner is a tool: it resolves apart from the tests' packages. */
    return Computable.forAll(
      [
        context.getGlobalRunnable(framework.runner),
        context.getGlobalString(TEST_EXPECTATIONS),
        context.getGlobalString("JS_TARGET", BUILD_OVERRIDE),
        context
          .getMap(settings.envProperty)
          .then(
            declared =>
              new Map([...declared, ...[...(settings.env ?? [])].map(([name, value]): [string, SecureString[]] => [name, [value]])])
          ),
        context.getGlobalString(COVERAGE),
        context.getGlobalString(TEST_NAME_PATTERN),
        context.getRequiredProperty(settings.stabilityProperty),
        context.getGlobalString(TEST_FLAKE_RETRIES),
        context.getGlobalString(TEST_ONLY_HANDLING),
      ],
      (runner, expectations, target, env, coverage, namePattern, stability, flakeRetries, onlyHandling): Computable<RuleResult> =>
        (coverage.equals(COVERAGE_ON) && framework.scheduler === "fabr"
          ? context.getGlobalRunnable("JS_COVERAGE_DRIVER")
          : Computable.resolve(undefined)
        ).then((coverageDriver): Computable<RuleResult> => {
          const jsTarget = parseJSTarget(target.toUnmaskedString());
          /* In the installation the packages are laid out for the run, and the
           * loose resource files among the deps (`.json`, a template) are staged
           * beside the compiled tests, so a `./x.json` import resolves. Loose
           * compilable files (`.ts`, `.js`) are left out: their output is in the
           * compiled tree, and a raw `.js` would collide with it. */
          const allDeps = [...deps, ...testDeps];
          const packages = allDeps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
          const resources = resourceFiles(allDeps.filter(dep => !(dep instanceof PackageFileSet)));

          const testTarget = testTargetOf(jsTarget, framework);
          const compile = { sources, declarations, stylesheets, deps, testDeps, runner, testTarget };
          return testCompile(context, framework, settings, compile).then(built => {
            if (built.sources.ts.isEmpty() && built.sources.js.isEmpty() && built.sources.jsx.isEmpty()) {
              /* No compilable source (.ts/.tsx/.js/.jsx) in the compile: nothing
               * to run. */
              throw new FabrError("Test target declares test files but none is a compilable source");
            }
            return (interactive ? planInteractiveRun : planTestRun)(context, {
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
              records: framework.records,
              artifacts: framework.artifacts ?? false,
              scheduler: framework.scheduler,
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
              runnerArgs: settings.runnerArgs ?? [],
              links: settings.links,
              update: expectations.equals(UPDATE_EXPECTATIONS),
              namePattern: namePattern.length === 0 ? undefined : namePattern,
              onlyHandling: focusHandlingOf(framework, onlyHandling.toUnmaskedString()),
              stability: toTestStability(stability.getValues()),
              flakeRetries: toFlakeRetries(flakeRetries),
              coverage: coverageDriver === undefined ? undefined : { driver: coverageDriver, packages },
            });
          });
        })
    );
  });
}

/** @return the declarations `tested` holds for the class-name modules of the
 *  css-modules among `sources`. */
function classNameDeclarations(sources: FileSet, tested: PackageFileSet): FileSet {
  const names = new Set([...sources].filter(([name]) => isCssModule(name)).map(([name]) => `${loweredCssName(name)}.d.ts`));
  return tested.remap(name => (names.has(name) ? name : undefined));
}

/** The compile a test run makes: what it compiles, against what, and for which target. */
interface ITestCompile {
  sources: FileSet;
  /** The declarations the package's build emitted for its sources, which the
   * compile then neither checks nor emits. */
  declarations?: FileSet;
  /** The stylesheets the package's build wrote for the sources' own, which the
   * compile leaves to it: the tests' imports of a stylesheet are rewritten as
   * the package's are, and resolve to these. */
  stylesheets?: FileSet;
  deps: FileSet[];
  testDeps: FileSet[];
  runner: FileSet;
  testTarget: PinnedJSTarget;
}

/**
 * @return the target a test target's tests compile for: the format their
 * framework's runner loads, whatever the package itself is built as, at no
 * lower an ES level than the framework's minimum. Component-wise — the
 * environment, and an ES level above the minimum, are the target's own.
 */
export function testTargetOf(jsTarget: ReturnType<typeof parseJSTarget>, framework: ITestFramework): PinnedJSTarget {
  const { minimumEsLevel } = framework;
  const version =
    minimumEsLevel !== undefined && esLevelOrder(jsTarget.version) < esLevelOrder(minimumEsLevel) ? minimumEsLevel : jsTarget.version;
  return { ...jsTarget, version, module: framework.module };
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
  { sources, declarations, stylesheets, deps, testDeps, runner, testTarget }: ITestCompile,
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
      ...(stylesheets === undefined ? {} : { rewriteImports: cssImportRewrites(), resources: stylesheets }),
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
      const sources = compileSourcesOf(FileSet.unionAll(...srcs, tests)).remap(name =>
        name === RUNNER_GLOBALS_TYPES ? undefined : name
      );
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
            { sources, deps, testDeps, runner, testTarget: testTargetOf(parseJSTarget(target.toUnmaskedString()), framework) },
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
  /** The options the target gives the runner ({@link ITestSettings.runnerArgs}). */
  runnerArgs: ReadonlyArray<RunnableArgument>;
  /** The installs linked beside the runner ({@link ITestSettings.links}). */
  links?: ReadonlyMap<string, FileSet>;
  /** The declared test sources, for mapping refreshed snapshots back to them. */
  tests: FileSet;
  /** How the runner names the tests' records. */
  records: ITestRecords;
  /** Whether the runner keeps files of the tests ({@link ITestFramework.artifacts}). */
  artifacts: boolean;
  /** Which schedules the test files across processes ({@link ITestFramework.scheduler}). */
  scheduler: ITestFramework["scheduler"];
  testStems: Set<string>;
  testTarget: PinnedJSTarget;
  /** Whether the suite needs a DOM (the `dom` source flag), named to the runner
   * as its `--env`. */
  needsDom: boolean;
  /** How the test processes reach `packages` (the `layout/*` flags): a
   * `node_modules` tree, or a PnP table over the pool's trees — laid out by
   * the test-run step. */
  layout: NodeLayout;
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
  /** What the run does with focused tests (`.only`): TEST_ONLY_HANDLING. */
  onlyHandling: FocusHandling;
  /** The regular expression selecting the tests run by name, if any. */
  namePattern?: SecureString;
  /** How far the tests' results are trusted. */
  stability: TestStability;
  /** How many further runs a failed test gets where `stability` is flaky. */
  flakeRetries: number;
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
 * {@link RUNNER_STAGE_DIR} beside the installs the target links, and the
 * runner's command line. A flaky suite's failed tests are run again, and an
 * unstable suite runs on every demand, uncached ({@link TestStability}).
 *
 * The action's reshape ({@link reshapeTestResult}) makes its output the
 * target's content: the report, the coverage report and the files the runner
 * kept of its tests, and, under `update`, the refreshed records as write-back
 * candidates. The reshape is applied on a cache hit as on
 * a miss, so a replayed update run whose writes were never applied still
 * offers them.
 *
 * Throws where the tests compiled to no runnable file, or the compiled tree's
 * root has two setup scripts.
 */
function planTestRun(context: TargetContext, run: ITestRun): Computable<RuleResult> {
  const preload = run.layout === "pnp" ? pnpPreloadOf(context) : Computable.resolve(undefined);
  /* A runner that schedules its own files reads the maps itself (Playwright's
   * locations and code frames), so they name the staged sources; nothing
   * measures such a run for coverage, which reads the `fabr:` entries. */
  const compiled = run.scheduler === "runner" ? run.compiled.then(tree => withStagedSources(tree, run.compileSrcs)) : run.compiled;
  return Computable.forAll([compiled, preload] as const, (compiledTree, pnpPreload) => {
    /* The step lays out the packages (the action's `deps`) as `layout` says,
     * under `pnp` a table at the root, beside which the PnP runtime's preload
     * goes for the runner to load. */
    const { files, testFiles, setupFile, compiledOf, expectations } = testInstallation(
      run,
      compiledTree,
      pnpPreload === undefined ? EMPTY_FILESET : FileSet.layout({ [PNP_PRELOAD]: pnpPreload.file })
    );
    const coverage =
      run.coverage && measuredRun(run.coverage, compiledTree, new Set([...testFiles, ...(setupFile ? [setupFile] : [])]));
    /* The runner's interpreter is reached through the tree pool by its content
     * hash (`RunnableFileSet.launchedBy`), so no host path enters the action's
     * key. The command line carries no report or test files: the step runs it
     * once per file, appending those. */
    const argv = run.runner.toCommandLine(
      [
        ...run.runnerArgs,
        ...runnerOptions(run, setupFile),
        ...(run.update ? ["--update-snapshots"] : []),
        ...(run.namePattern === undefined ? [] : [secure`--name-pattern=${run.namePattern}`]),
      ],
      /* The runner stays at the install root while the working directory is the
       * compiled tree, so its entry, and the pool its node is in, are reached one
       * level up. */
      { base: `../${RUNNER_STAGE_DIR}`, pool: `../${TREE_MOUNT}` }
    );
    /* The report (and, measured, the coverage report); under `update`, the
     * refreshed records too, named under the `build/` mount, which the reshape
     * strips, so they stay apart from the report and the kept files. The
     * patterns are in the action's config, so the two modes never share a
     * cache entry. */
    const outputs = [
      TEST_REPORT_FILENAME,
      ...(coverage ? [COVERAGE_REPORT_FILENAME] : []),
      ...(run.update ? run.records.collected(expectations, compiledOf).map(pattern => `${COMPILE_OUT_DIR}/${pattern}`) : []),
    ];
    /* Under `update` the runner rewrites the declared `expectations`, so stage
     * them as writable copies: every other file is staged as a read-only
     * hardlink into the content store, and writing through one would corrupt
     * the entry other builds share. */
    const records = run.update ? expectations : EMPTY_FILESET;
    /* The writable set is named by install name, under the mount; `records`
     * keeps the compiled tree's names, which reshapeTestResult compares in. */
    const writable = FileSet.layout({ [COMPILE_OUT_DIR]: [records] });
    return createTestRunAction({
      /* The runner's install, the installs the target links beside it, a
       * measured run's driver's and the PnP runtime the preload loads from the
       * pool are trees of the pool linked into the installation, each one line
       * of the key. */
      links: {
        ...Object.fromEntries(run.links ?? []),
        [RUNNER_STAGE_DIR]: run.runner,
        ...(coverage?.links ?? {}),
        ...(pnpPreload === undefined ? {} : { [PNP_RUNTIME_STAGE_DIR]: pnpPreload.runtime }),
      },
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
      retries: run.stability.flaky && run.scheduler === "fabr" ? run.flakeRetries : 0,
      uncached: run.stability.unstable,
      artifacts: run.artifacts,
      scheduler: run.scheduler,
    }).withReshape(result => reshapeTestResult(result, run, records, compiledOf));
  });
}

/** A test run's own files, and what the runner is told of them ({@link testInstallation}). */
interface ITestInstallation {
  /** The run's own files, named as the installation stages them. */
  files: FileSet;
  /** The compiled test files, by their names in the compiled tree, sorted. */
  testFiles: string[];
  /** The compiled setup script, if the suite has one. */
  setupFile?: string;
  /** The compiled test file of each test source. */
  compiledOf: Map<string, string>;
  /** The declared records, named as the runner reads them. */
  expectations: FileSet;
}

/**
 * Lay out a test run's own files: a minimal `package.json`, the files `root`
 * adds at the installation's root (the PnP preload, or the packages a program
 * lays out itself), the compiled tree with the resources and the recorded
 * expectations under {@link COMPILE_OUT_DIR}, the compile's sources under
 * {@link COMPILE_SRC_DIR}, and the source-locations table.
 *
 * Throws where the tests compiled to no runnable file, or the compiled tree's
 * root has two setup scripts.
 */
function testInstallation(run: ITestRun, compiledTree: FileSet, root: FileSet): ITestInstallation {
  /* Empty where the declared tests compiled to no runnable file: an error. */
  const testFiles = selectCompiledTestFiles(compiledTree, run.testStems);
  const setupFile = selectCompiledSetupFile(compiledTree);
  if (testFiles.length === 0) {
    throw new FabrError("Test target declares test files but none produced a runnable .js output");
  }
  const packageJson = moduleTypeFile(run.testTarget.module, { name: "fabr-test", private: true });
  const compiledOf = compiledTestsOf(run.tests, testFiles);
  const expectations = run.records.stage(run.expectations, compiledOf);
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
  const files = FileSet.unionAll(
    root,
    FileSet.layout({
      "package.json": packageJson,
      /* Resources and records join the compiled tree, the working directory, so
       * a test's `./x` finds them as in the source tree. */
      [COMPILE_OUT_DIR]: [runtime, run.testResources, expectations],
      [COMPILE_SRC_DIR]: [run.compileSrcs],
      /* Where each staged source is, by its source path: the compile's maps
       * name a source by its reference, and a runner reading one (the jest
       * flavour's docblock) opens it from here. */
      [SOURCE_LOCATIONS_FILE]: sourceLocations(run.compileSrcs),
    })
  );
  return { files, testFiles, setupFile, compiledOf, expectations };
}

/** What a test run does with focused tests (`.only`): the values of TEST_ONLY_HANDLING. */
export type FocusHandling = "allow" | "ignore" | "forbid";

const FOCUS_HANDLINGS: readonly FocusHandling[] = ["allow", "ignore", "forbid"];

/** Convert TEST_ONLY_HANDLING's value, for `framework`; throws naming the values there are where it is none of them, and where `framework` cannot do it. */
function focusHandlingOf(framework: ITestFramework, value: string): FocusHandling {
  if (!(FOCUS_HANDLINGS as readonly string[]).includes(value)) {
    throw new FabrError(`'${value}' is not a value of TEST_ONLY_HANDLING (${FOCUS_HANDLINGS.join(", ")})`);
  }
  if (value === "ignore" && framework.ignoresFocus === false) {
    const name = [...TEST_FRAMEWORKS].find(([, each]) => each === framework)?.[0] ?? "this framework";
    throw new FabrError(
      `TEST_ONLY_HANDLING=ignore is not available under ${name}, which cannot run a focused test as any other`
    ).withHelp("use allow or forbid");
  }
  return value as FocusHandling;
}

/** Make the runner options a run gives every invocation: its environment, its setup script, its PnP table and, for a runner scheduling its files itself, its retries. */
function runnerOptions(run: ITestRun, setupFile: string | undefined): string[] {
  return [
    `--env=${run.needsDom ? "jsdom" : "node"}`,
    /* `./`-prefixed: the runner contract distinguishes a path within the
     * installation from a bare module name by exactly that prefix. */
    ...(setupFile === undefined ? [] : [`--setup=./${setupFile}`]),
    ...(run.layout === "pnp" ? [`--pnp=../${PNP_DATA_FILE}`] : []),
    ...(run.onlyHandling === "allow" ? [] : [`--only=${run.onlyHandling}`]),
    /* A runner scheduling its files itself retries a failed test within its
     * run, as many times as the target's stability allows, whatever its
     * framework's own config says; fabr reruns only files it schedules. */
    ...(run.scheduler === "runner" ? [`--retries=${run.stability.flaky ? run.flakeRetries : 0}`] : []),
  ];
}

/**
 * Make the program `fabr run` runs a compiled test target as: the test run's
 * installation ({@link testInstallation}) with its packages laid out as
 * `layout` says ({@link layoutProgram}; under `pnp` the runner loads the
 * preload itself, from `--pnp`), launched in the installation by the
 * runner, from the tree pool, as `<runner> <options> --interactive
 * build <test files> -- <the caller's arguments>`, which runs the framework's
 * own interactive run over the tests. The compiled tree and its sources are
 * the program's served content, which `fabr run -w` updates in place.
 */
function planInteractiveRun(context: TargetContext, run: ITestRun): Computable<RuleResult> {
  return Computable.forAll(
    [
      run.compiled.then(compiled => withStagedSources(compiled, run.compileSrcs)),
      layoutProgram(context, run.packages, run.layout),
    ] as const,
    (compiledTree, program) => {
      const { files, testFiles, setupFile } = testInstallation(run, compiledTree, program.files);
      /* What the compile made of the suite, which an edit changes, where the packages and the runner stay. */
      const served = files.remap(name =>
        name.startsWith(`${COMPILE_OUT_DIR}/`) || name.startsWith(`${COMPILE_SRC_DIR}/`) || name === SOURCE_LOCATIONS_FILE
          ? name
          : undefined
      );
      return RunnableFileSet.forEntry(files, COMPILE_OUT_DIR)
        .launchedBy(run.runner, context.execution.buildCache, [...run.runnerArgs, ...runnerOptions(run, setupFile), "--interactive"])
        .then(launched => launched.withServedContent(files, served, [...testFiles, "--"], toEnvironment(run.env)));
    }
  );
}

/**
 * Make the compiled tree's source maps name each source the compile staged
 * (`compileSrcs`, under {@link COMPILE_SRC_DIR} beside the tree) by its path
 * from the map, in place of its `fabr:` reference, which names nothing a
 * program reading the map from the installation can open (Playwright's code
 * frames, its UI's source view).
 */
function withStagedSources(compiled: FileSet, compileSrcs: FileSet): Computable<FileSet> {
  const staged = new Map(
    [...compileSrcs.sourcePaths].map(([name, sourcePath]) => [`fabr:${sourcePath}`, `${COMPILE_SRC_DIR}/${name}`])
  );
  const maps = [...compiled].filter(([name]) => name.endsWith(".map"));
  return mapComputable(maps, ([name, file]) =>
    file.readString().then((text): [string, IFile] => {
      const map = parseJson(text, name, toJsonObject);
      const from = posix.join(COMPILE_OUT_DIR, posix.dirname(name));
      const sources = Array.isArray(map.sources)
        ? map.sources.map(source => {
            const location = typeof source === "string" ? staged.get(source) : undefined;
            return location === undefined ? source : posix.relative(from, location);
          })
        : map.sources;
      return [name, MemoryFile.from(JSON.stringify({ ...map, sources }))];
    })
  ).then(rewritten => FileSet.unionAll(compiled.minus(new FileSet(new Map(rewritten))), new FileSet(new Map(rewritten))));
}

/**
 * Stage what a measured run adds to the install, and make the coverage driver's
 * command line, run from the install root, and the files it measures: every
 * compiled script of the compile but the tests, the setup script and what the
 * build derived from another file (a css module's shim), by its name in the
 * install, and of every package built in the project but those
 * made from a registry's package (a `patched` one, whose provenance holds the
 * registry's resolution), as the package's route and the script's path within
 * it, which the step places under the layout it stages.
 */
function measuredRun(
  { driver, packages }: { driver: RunnableFileSet; packages: PackageFileSet[] },
  compiled: FileSet,
  testInfrastructure: ReadonlySet<string>
): { links: Record<string, FileSet>; argv: RunnableArgument[]; measured: IMeasuredFiles } {
  const files = [...compiled]
    .map(([name]) => name)
    .filter(name => COMPILED_SCRIPT.test(name) && !testInfrastructure.has(name) && compiled.derivedFromOf(name) === undefined)
    .map(name => `${COMPILE_OUT_DIR}/${name}`)
    .sort();
  const routes = new Map<PackageFileSet, string[]>();
  walkPackages(packages, (pkg, route) => {
    if (!routes.has(pkg) && builtInProject(pkg.origin) && formatOf(pkg.origin) === undefined) {
      routes.set(pkg, route);
    }
  });
  const installed = [...routes].flatMap(([pkg, route]) =>
    [...pkg]
      .map(([name]) => name)
      .filter(name => COMPILED_SCRIPT.test(name) && pkg.derivedFromOf(name) === undefined)
      .map(name => [...route, name])
  );
  return {
    links: { [COVERAGE_STAGE_DIR]: driver },
    argv: driver.toCommandLine([], { base: COVERAGE_STAGE_DIR }),
    measured: { files, packages: installed },
  };
}

/**
 * Split the run's output into the target's content (the report, the coverage
 * report and the files the run kept of its tests) and its write-back
 * candidates: the refreshed records paired with the tests they belong beside
 * (`run.records`' {@link ITestRecords.writeBacks}, given `recorded`, the
 * records the run was staged with). With no candidate (every `check` run),
 * the plain content.
 */
function reshapeTestResult(
  result: FileSet,
  run: Pick<ITestRun, "tests" | "records">,
  recorded: FileSet,
  compiledOf: ReadonlyMap<string, string>
): FileSet {
  /* Records are collected under the compiled tree's mount, apart from the
   * report and the kept files at the result's root. */
  const { report = EMPTY_FILESET, snapshots } = result.partition(name =>
    name.startsWith(`${COMPILE_OUT_DIR}/`) ? "snapshots" : "report"
  );
  const records = snapshots?.remap(name => name.slice(COMPILE_OUT_DIR.length + 1));
  const candidates = records ? run.records.writeBacks(records, recorded, run.tests, compiledOf) : [];
  return candidates.length === 0 ? report : new WriteBackFileSet(report, candidates);
}

/** Pair each test source in `tests` with its compiled file among `testFiles`,
 * by stem. A source with no compiled file is left out. */
function compiledTestsOf(tests: FileSet, testFiles: ReadonlyArray<string>): Map<string, string> {
  const byStem = new Map(testFiles.map(name => [stripExtension(name), name]));
  return new Map(
    [...tests].flatMap(([name]): Array<[string, string]> => {
      const compiled = byStem.get(stripExtension(name));
      return compiled === undefined ? [] : [[name, compiled]];
    })
  );
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
