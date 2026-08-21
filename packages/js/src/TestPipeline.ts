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
 * The runner is the target's `test_runner` (defaulting to the `JS_TEST_RUNNER`
 * global — fabr's own runner, or the jest-compatibility flavour), executed
 * standalone inside the test working directory. The runner contract:
 *
 *     <runner> --report=<file> --env=<node|jsdom> [--update-snapshots]
 *              [--setup=<module|./staged path>]… <test files…>
 *
 * red exit status on failure, report written as CTRF. `--env` names the
 * environment the suite RUNS in, which follows the `dom` source flag rather than
 * the target it is emitted for (see where it is read, below);
 * `--update-snapshots` asks the runner
 * to rewrite recorded expectations instead of failing on them (see
 * TEST_EXPECTATIONS), which the pipeline then offers back to the source tree;
 * each `--setup` names something every test process loads before any test file,
 * in the order given — fabr passes the target's conventional setup script (see
 * {@link SETUP_STEM}), and the contract stays plural because it is the runner's,
 * not this pipeline's.
 */

import {
  Computable,
  Constraints,
  EMPTY_FILESET,
  SymlinkFile,
  FileSet,
  IFile,
  IWriteBackCandidate,
  PackageFileSet,
  RunnableFileSet,
  parseName,
  TargetContext,
  RuleResult,
  SourceRef,
  TEST_EXPECTATIONS,
  TEST_REPORT_FILENAME,
  UPDATE_EXPECTATIONS,
  WriteBackFileSet,
  Flag,
} from "@fabr-build/core";
import { posix } from "path";
import { COMPILE_OUT_DIR, COMPILE_SRC_DIR } from "./rules/BuildJSCompile";
import {
  assembleNodeModules,
  compileContents,
  formatJSTarget,
  JSTarget,
  moduleTypeFile,
  parseJSTarget,
  resourceFiles,
  stripPackageJson,
  usesDom,
} from "./JSPackage";

/** The runner's ambient types for its preloaded globals, anywhere in its install */
const GLOBALS_TYPES_FILE = "test-globals.d.ts";
/** Where the runner install is staged in the test install, and where its
 * ambient-types file mounts so tsc auto-includes it for the test compile */
const RUNNER_STAGE_DIR = ".fabr-testrunner";
const GLOBALS_TYPES_MOUNT = "@types/fabr-test-globals/index.d.ts";
/* The runner's own globals .d.ts as it appears in @fabr-build/js's srcs, dropped
 * when @fabr-build/js tests itself so it doesn't collide with the synthetic mount. */
const RUNNER_GLOBALS_TYPES = "testRunner/test-globals.d.ts";

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
 * A convention rather than a property, deliberately for now: it is one file
 * per target and it is already an ordinary source (so it compiles with the
 * tests, may be TypeScript, and may use the test globals), which leaves a
 * declaration with nothing to say that the name doesn't.
 */
const SETUP_STEM = "setupTests";

/**
 * The runner's ambient globals types, extracted from its resolved install (a
 * test-globals.d.ts anywhere among its files) and mounted as the synthetic
 * @types package the test compile auto-includes; empty when the runner ships
 * none. Part of the runner contract, so a swapped JS_TEST_RUNNER carries its
 * own globals typings with it rather than inheriting fabr's — and, equally,
 * a runner typed by an ordinary `@types` package the target declares (the jest
 * flavour, typed by `@types/jest`) ships none, since two sets of ambient
 * describe/it declarations would collide.
 */
function runnerGlobalsTypes(runner: FileSet): FileSet {
  const found = [...runner].find(([name]) => name === GLOBALS_TYPES_FILE || name.endsWith("/" + GLOBALS_TYPES_FILE));
  return found ? FileSet.layout({ [GLOBALS_TYPES_MOUNT]: found[1] }) : EMPTY_FILESET;
}

export interface ITestInputs {
  /** The as-written source and test sources: they join the same collection point
   * as the deps, so everything this evaluation consumes resolves jointly. */
  sourceRefs: SourceRef[];
  testRefs: SourceRef[];
  target: string;
  /** The as-written (unmaterialized) dependency sources. A js_package[test]
   * folds its `provided_deps` in here — a test install is self-contained, so a
   * peer is just another dep with no host to supply it and no manifest to
   * distinguish it. */
  depSources: SourceRef[];
  /** Test-only packages (assertion libraries and their @types), available to
   * both the test compile and the test run but never to the package build */
  testDepSources: SourceRef[];
  /** Files the tests need at runtime, staged verbatim (see `test_resources`). */
  testResourceSources: SourceRef[];
  /** Recorded expectations the tests compare against (see `expectations`). */
  expectationSources: SourceRef[];
  /** The package name a js_package[test]'s sources may import themselves by; a
   * standalone js_test has no package identity and leaves it unset. */
  packageName?: string;
}

/**
 * The shared test pipeline: compile the whole source tree (tests included, so
 * their relative imports resolve against the code under test), lay it out as
 * a runnable installation together with the deps, the test-only deps and the
 * runner, and execute the runner over the compiled test files. The output
 * artifact is the test report; a red run fails the target with the report's
 * failure summary.
 *
 * Everything the evaluation consumes from the build graph — sources, tests,
 * deps and test-only deps — goes through ONE collection point, so every
 * requirement resolves jointly and the consumer's pins participate across the
 * lot. The runner and the compile toolchain are not among them: they are
 * *tools*, independent of what they test/compile, and resolve apart.
 */
export function compileAndRunTests(context: TargetContext, inputs: ITestInputs): Computable<RuleResult> {
  const jsTarget = parseJSTarget(inputs.target);
  if (inputs.testRefs.length === 0) {
    /* No `tests` at all: trivially green, and nothing is resolved for it — a
     * target that declares no tests must not fetch its deps under `fabr test`.
     * (A declared `tests` that *matches* no files still resolves, and greens
     * below; one matching files but producing no runnable output errors.) */
    return Computable.resolve(EMPTY_FILESET);
  }
  /* THE collection point, singular per evaluation: the sources, the tests, the
   * deps and the test-only deps all materialize through one joint resolution. */
  return context
    .collect({
      srcs: inputs.sourceRefs,
      tests: inputs.testRefs,
      deps: inputs.depSources,
      testDeps: inputs.testDepSources,
      testResources: inputs.testResourceSources,
      expectations: inputs.expectationSources,
    })
    .then(({ srcs, tests: testSets, deps, testDeps, testResources, expectations: expectationSets }): Computable<RuleResult> => {
      const tests = FileSet.unionAll(...testSets);
      if (tests.isEmpty()) {
        /* No tests declared: trivially green (and no runner is needed). A declared
         * test that yields no runnable output is NOT this case — it errors below. */
        return Computable.resolve(EMPTY_FILESET);
      }
      /* Compile srcs and tests together (tests are normally within srcs); the
       * globals declarations come in via the synthetic @types mount, so a copy
       * among the sources (the runner testing itself) is dropped */
      const sources = FileSet.unionAll(...srcs, tests).remap(name => (name === RUNNER_GLOBALS_TYPES ? undefined : name));
      /* The declared test sources' stems (path minus extension). Their compiled `.js`
       * are picked out of the *actual* compiled tree by stem in planTestRun, so the
       * source→output naming is never re-derived here — js_compile owns it. */
      const testStems = new Set([...tests].map(([name]) => stripExtension(name)));
      /* The runner is a *tool*, independent of what it tests, so it resolves
       * apart (the TSC precedent — its pins don't co-resolve with the tests'
       * deps); `test_runner` defaults to the JS_TEST_RUNNER global. */
      return Computable.forAll(
        [context.getRunnableProperty("test_runner", "JS_TEST_RUNNER"), context.getGlobalString(TEST_EXPECTATIONS)],
        (runner, expectations): Computable<RuleResult> => {
          /* The test compile may import the package's deps, the test_deps, and the
           * runner globals directly (all passed to compileJsSources). The runtime
           * install splits them like RunJSScript: packages mount as node_modules,
           * while a loose *resource* dep (.json, a template — tsc never emits it)
           * stages at the install root next to the compiled tests, so a `./x.json`
           * import resolves. Compilable loose deps (.ts/.js) are excluded here — their
           * output already rides the compiled tree (and a raw .js would collide). */
          const allDeps = [...deps, ...testDeps];
          const packages = allDeps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
          const runtimeModules = assembleNodeModules(packages);
          const resources = resourceFiles(allDeps.filter(dep => !(dep instanceof PackageFileSet)));

          /* Tests always compile and run as CommonJS, whatever the package
           * itself is built as: call-time `require` is what makes module
           * substitution (a runner's mocking layer) observable at all, and it
           * is the seam such a layer intercepts. Component-wise — the ES
           * version and the environment are the target's own and are kept. */
          const testTarget: JSTarget = { ...jsTarget, module: "commonjs" };
          /* Set unconditionally, including when the target already emits
           * commonjs: the override is then a different SPELLING of the same
           * target (`es2020` formats back as `es2020-commonjs-node`), which
           * parses identically, yields an identical tsconfig, and so shares the
           * one compile by cache key. Guarding it would trade that no-op for a
           * special case.
           *
           * Built as the package would build it, stylesheets included — a test
           * importing one gets the CSS the package ships, not raw Sass. */
          return compileContents(context, sources, [...deps, ...testDeps, runnerGlobalsTypes(runner)], {
            packageName: inputs.packageName,
            constraints: Constraints.of({ JS_TARGET: formatJSTarget(testTarget) }),
          }).then(built => {
            if (built.sources.ts.isEmpty() && built.sources.js.isEmpty() && built.sources.jsx.isEmpty()) {
              /* Tests are declared but none is a compilable source (.ts/.tsx/.js/.jsx),
               * so there is nothing to run — a loud failure, not a silent green. */
              throw new Error("Test target declares test files but none is a compilable source");
            }
            return planTestRun(context, {
              compiled: Computable.resolve(built.compiled),
              /* The lowered CSS is a sibling of the compiled code that imports it. */
              copied: FileSet.unionAll(built.passthrough, built.css),
              compileSrcs: built.compileSrcs,
              nodeModules: runtimeModules,
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
              needsDom: usesDom([...deps, ...testDeps].filter((dep): dep is Flag => dep instanceof Flag)),
              testResources: FileSet.unionAll(...testResources),
              expectations: FileSet.unionAll(...expectationSets),
              packageName: inputs.packageName,
              update: expectations === UPDATE_EXPECTATIONS,
            });
          });
        }
      );
    });
}

/**
 * The install's self-mount: `node_modules/<packageName>` as a SYMLINK back to
 * the install root, so the compiled tree's self-referential requires
 * (`@scope/pkg/sub`, which `paths` resolved at compile time but which survive
 * verbatim into the emitted JS) resolve when the tests run.
 *
 * A symlink rather than a second copy of the tree: node resolves a module to
 * its realpath, so `require("@scope/pkg/sub")` and a relative `require("./sub")`
 * reach the SAME file and therefore the same module instance. Copying would
 * give each edge its own instance — separate module state, failing `instanceof`,
 * duplicated singletons. This is the same device pnpm and yarn workspaces use.
 */
function selfMount(packageName: string | undefined): FileSet {
  if (packageName === undefined) {
    return EMPTY_FILESET;
  }
  /* Relative to the link's own DIRECTORY, which sits N levels below the install
   * root for an N-segment name: node_modules for the last segment, plus one per
   * scope segment above it (node_modules/@scope/pkg -> ../..). It points at the
   * COMPILED tree, not the install root: the emitted code lives under `build/`
   * (mounted beside its sources so source maps resolve), so a self-referential
   * `@scope/pkg/sub` has to land there or it resolves to nothing. */
  const up = "../".repeat(packageName.split("/").length);
  return FileSet.layout({ [packageName]: new SymlinkFile(up + COMPILE_OUT_DIR) });
}

/** Strip a file's final extension: `a/foo.test.ts` → `a/foo.test`. Used to match
 * a declared test source against its compiled `.js` output by stem. */
function stripExtension(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

/** The runnable test files: the JS entries of the *actual* compiled tree whose
 * stem is one of the declared tests' stems, sorted for determinism. No
 * source→output name is predicted — js_compile named these; we only select.
 * `.mjs`/`.cjs` are the outputs of a `.mts`/`.cts` test. */
export function selectCompiledTestFiles(compiled: FileSet, testStems: Set<string>): string[] {
  return [...compiled]
    .map(([name]) => name)
    .filter(name => /\.[cm]?js$/.test(name) && testStems.has(stripExtension(name)))
    .sort();
}

/**
 * The compiled setup script, or undefined for a target that has none.
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
    throw new Error(`Test target has more than one ${SETUP_STEM} script (${matches.join(", ")}); it may only have one`);
  }
  return matches[0];
}

interface ITestRun {
  compiled: Computable<FileSet>;
  copied: FileSet;
  /** The compile's own `src/` tree, mounted beside the output so each `.js.map`
   * resolves — see the layout in planTestRun. */
  compileSrcs: FileSet;
  nodeModules: FileSet;
  resources: FileSet;
  runner: RunnableFileSet;
  /** The declared test sources, for mapping refreshed snapshots back to them. */
  tests: FileSet;
  testStems: Set<string>;
  testTarget: JSTarget;
  /** Whether the suite needs a DOM (the `dom` source flag), named to the runner
   * as its `--env`. */
  needsDom: boolean;
  /** Verbatim runtime files for the tests, mounted with the compiled output. */
  testResources: FileSet;
  /** The declared recorded expectations — staged beside the compiled tests, and
   * the only inputs an update run may rewrite. */
  expectations: FileSet;
  /** The package the sources may import themselves by, if any — see selfMount. */
  packageName?: string;
  update: boolean;
}

/**
 * Plan the test run: the runtime installation (deps/test-deps as node_modules,
 * the runner's install staged under {@link RUNNER_STAGE_DIR}, a minimal
 * package.json and any copied sources) is assembled in resolution, and the
 * compiled tree — the output of the shared js_compile sub-target — is passed
 * in as a concrete input to the `js_test_run` sub-target.
 *
 * The run is a **sub-target** rather than an action yielded directly, so its
 * output is observed here, in resolution: the report is the target's content,
 * and any refreshed snapshot files become write-back candidates paired with
 * their source locations. Because that reshaping is plain resolution code, it
 * re-runs every evaluation — so the candidates reconstruct on the CACHE-HIT
 * path too (a warm replay of an update run whose writes were never applied
 * still offers them).
 */
function planTestRun(context: TargetContext, run: ITestRun): Computable<RuleResult> {
  return run.compiled.then(compiledTree => {
    /* Pick the runnable test files out of the real compiled tree (js_compile named
     * them) rather than re-deriving names from the sources. Empty here means the
     * declared tests produced no runnable output — a loud failure, not a green. */
    const testFiles = selectCompiledTestFiles(compiledTree, run.testStems);
    const setupFile = selectCompiledSetupFile(compiledTree);
    if (testFiles.length === 0) {
      throw new Error("Test target declares test files but none produced a runnable .js output");
    }
    const packageJson = moduleTypeFile(run.testTarget.module, { name: "fabr-test", private: true });
    /* Everything the compiled code sees as a sibling: its own output, the
     * sources tsc passed through (a `./x.json` import), and loose resource deps. */
    const runtime = FileSet.unionAll(compiledTree, stripPackageJson(run.copied), run.resources);
    /* Laid out AS THE COMPILE LAID IT OUT — output under `build/`, sources under
     * `src/` — because each `.js.map` names its source relative to that pairing
     * (`../../src/foo.ts`). Re-rooting the output at the install root, as this
     * did, left every one of those paths resolving outside the install: node
     * still mapped stack frames to `foo.ts` (the positions are in the map) but
     * nothing could READ that file, so jest's code frame — which loads the file
     * the top frame names — silently rendered nothing. `node_modules` and
     * `package.json` stay at the root, where node's walk-up finds them from
     * `build/` just as well.
     *
     * `build/` is ALSO the working directory (see js_test_run): a test's paths —
     * `./x` from cwd or `__dirname`-relative alike — then mean what they mean in
     * the source tree, since the compiled tree mirrors it. Staging resources
     * anywhere else forced the declaration to re-encode fabr's layout. */
    const staged = FileSet.layout({
      node_modules: [run.nodeModules, selfMount(run.packageName)],
      [RUNNER_STAGE_DIR]: [run.runner],
      "package.json": packageJson,
      /* Resources and records join the compiled tree, which is also the working
       * directory: a test's `./x` means the same thing here as in the source
       * tree, with no rename to re-encode fabr's layout in the declaration. */
      [COMPILE_OUT_DIR]: [runtime, run.testResources, run.expectations],
      [COMPILE_SRC_DIR]: [run.compileSrcs],
    });
    /* Bare interpreter (e.g. "node"): resolved against PATH inside the step, so
     * no host-specific absolute path enters the action manifest.
     *
     * The invocation carries neither the report name nor the test files: the
     * step invokes the runner once PER FILE (the contract permits any partition
     * of the files), appending a per-invocation report name and the file — so
     * each execution is admitted separately by the machine-wide process funnel
     * and a wide suite no longer multiplies fabr's parallelism by the runner's. */
    const argv = run.runner.toCommandLine(
      [
        `--env=${run.needsDom ? "jsdom" : "node"}`,
        ...(run.update ? ["--update-snapshots"] : []),
        /* `./`-prefixed: the runner contract distinguishes a path within the
         * installation from a bare module name by exactly that prefix. */
        ...(setupFile === undefined ? [] : [`--setup=./${setupFile}`]),
      ],
      /* The runner stays at the install root while the working directory is the
       * compiled tree, so its entry is reached one level up. */
      { base: `../${RUNNER_STAGE_DIR}` }
    );
    /* Under `check` the run's only output is the report; under `update` the
     * refreshed snapshot files are collected too. The selectors ride the action
     * manifest, so the two modes can never share a cache entry. */
    /* Collected THROUGH the `build/` mount (`dir:glob` names results relative to
     * `dir`), so the refreshed records come back named as the compiled tree
     * names them — the namespace the tests and the staged records are already
     * matched in. */
    const outputs = run.update
      ? [TEST_REPORT_FILENAME, `${COMPILE_OUT_DIR}:${SNAPSHOT_DIR}/*.snap`, `${COMPILE_OUT_DIR}:**/${SNAPSHOT_DIR}/*.snap`]
      : [TEST_REPORT_FILENAME];
    /* Under `update` the runner REWRITES the recorded files it was given, so
     * those inputs must be staged as writable copies. The DECLARED
     * `expectations` are that set — not whatever happens to sit in a
     * `__snapshots__` directory, which made updatability a property of a path
     * rather than a statement (and silently gave a runner recording elsewhere
     * nothing to update). Everything else is staged
     * as a hardlink into the content store, where the blob is read-only — which
     * is the protection working, not a limitation to route around: writing
     * through such a link would corrupt the entry every other build shares. */
    const records = run.update ? run.expectations : EMPTY_FILESET;
    /* The action stages by INSTALL name, so the writable set is the same records
     * seen through the mount; the comparison below wants them in the compiled
     * tree's own namespace, which is what `records` is. */
    const writable = FileSet.layout({ [COMPILE_OUT_DIR]: [records] });
    return context
      .subTarget("js_test_run", {
        staged,
        writable,
        argv,
        test_files: testFiles,
        outputs,
      })
      .then(result => reshapeTestResult(result, run.tests, records));
  });
}

/** The files a runner may rewrite: the recorded expectations, by the same
 * `__snapshots__/*.snap` convention the run's outputs are collected under.
 * Named in the compiled tree's namespace, like everything it is matched against. */
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
  const { report = EMPTY_FILESET, snapshots } = result.partition(name => (name === TEST_REPORT_FILENAME ? "report" : "snapshots"));
  const candidates = snapshots ? snapshotWriteBacks(snapshots, tests, recorded) : [];
  return candidates.length === 0 ? report : new WriteBackFileSet(report, candidates);
}

/**
 * Pair each refreshed snapshot file with where it belongs in the user's tree.
 *
 * The run works in compiled names (`Foo.test.js`) and the source tree in source
 * names (`Foo.test.tsx`), so the two sides are matched on the **stem** — which
 * is exactly how the runner found the checked-in file in the first place. That
 * also handles a brand-new snapshot, which the runner necessarily emits under
 * the compiled name: the destination name is derived here, from the test
 * source, so what lands in the tree is jest's standard `<test file>.snap`
 * either way.
 *
 * Each candidate names the TEST it belongs beside; resolving that to a place on
 * disk is the driver's job, so nothing here is a host path and a test with no
 * source location (a generated one) needs no special case — the driver finds it
 * unplaceable and says so.
 *
 * A record the run reproduced unchanged is **not offered at all**: `recorded`
 * is the staged input it was given, and both sides are already hashed, so
 * changed-ness is decided here in the build's own terms rather than
 * rediscovered by reading the user's file at write time. What comes out is
 * therefore exactly the set of real changes — which is what lets the write
 * itself be unconditional, and what keeps a no-op update run from touching the
 * tree (so, under watch, producing no event to have to recognize).
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
     * the compiled file it ran, which is jest's own default and so a perfectly
     * conforming thing to do. Either way the record is REKEYED to the source
     * name here, which is what makes the correspondence a pure naming rule the
     * driver can apply without knowing anything about snapshots. */
    const file = byName.get(snapshotNameFor(name)) ?? byStem.get(stripExtension(name));
    if (file !== undefined) {
      refreshed.set(snapshotNameFor(name), file);
    }
  }
  return refreshed.size === 0 ? [] : [{ files: new FileSet(refreshed), belongsTo: SNAPSHOT_BELONGS_TO, origin: tests.origin }];
}

/** Where a test source's record sits relative to it — jest's convention, and
 * the name a write-back lands under. */
function snapshotNameFor(testName: string): string {
  return posix.join(posix.dirname(testName), SNAPSHOT_DIR, `${posix.basename(testName)}.snap`);
}

/** The test stem a collected `<dir>/__snapshots__/<test file>.snap` belongs to
 * (`a/__snapshots__/Foo.test.js.snap` → `a/Foo.test`), or undefined if the name
 * isn't a snapshot file. Both extensions come off: the `.snap`, then the test
 * file's own — which is what makes a compiled name and a source name meet. */
function snapshotStem(name: string): string | undefined {
  const dir = posix.dirname(name);
  if (posix.basename(dir) !== SNAPSHOT_DIR || !name.endsWith(".snap")) {
    return undefined;
  }
  return posix.join(posix.dirname(dir), stripExtension(posix.basename(name, ".snap")));
}

