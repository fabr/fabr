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
 * What the browser_test rules share: a browser test compiles `tests` with
 * `deps` and `compile_deps` and runs them under the browser test framework
 * `framework` names ({@link BROWSER_FRAMEWORKS}), in the one browser `browser`
 * names, at its `viewport`, `user_agent` and `device`, against `base_url`,
 * with `resources` beside them, `expectations` as the recorded screenshots
 * and `env` as the test processes' environment. The browser is named on the
 * runner's command line: a browser fabr fetches by the framework's name for
 * it and its executable, a Playwright build (a `playwright/<name>` flag) by
 * the directory Playwright finds it in, and the framework's own program
 * (Cypress's) by the directory it is installed in.
 */

import * as path from "path";
import {
  BUILD_OVERRIDE,
  Computable,
  FabrError,
  fetchArchive,
  FileSet,
  Flag,
  MemoryFile,
  PackageFileSet,
  PackageSources,
  ResolutionSpec,
  RuleResult,
  RunnableArgument,
  RunnableFileSet,
  secure,
  SecureString,
  SymlinkFile,
  TARGET,
  TargetContext,
  TREE_MOUNT,
  tripleToNpm,
} from "@fabr-build/core";
import { compileAndRunTests, ITestFramework, TestContents, TestRequirements, testFramework, testRequirements } from "./TestPipeline";
import { NPM_FORMAT } from "./NPMProtocol";

/** What a browser test framework's rule makes of a target, beside its entry in `TEST_FRAMEWORKS`. */
interface IBrowserFramework {
  /** The variable the framework reads the URL the tests run against from. */
  baseUrlVariable: string;
  /** The framework's name for each browser fabr fetches, by the browser's own (its runnable's entry). */
  browserNames: ReadonlyMap<string, string>;
  /** Fetch Playwright's own builds of the browsers `names` (each a `playwright/<name>`), where the framework runs them. */
  builds?: (context: TargetContext, names: string[], deps: FileSet[]) => Computable<FileSet>;
  /** The framework's own default browser, by its name, which an unset `browser` means. */
  defaultBrowser: string;
  /** The Playwright build the default browser is, where it is one. */
  defaultBuild?: string;
  /** The framework's own program, where its runner needs one installed: what to link beside the runner, and the option naming its directory. */
  program?: { link: string; option: string; install: (context: TargetContext, deps: FileSet[]) => Computable<FileSet> };
  /** Whether the target's packages are read permissively, as a tool's are. */
  permissive: boolean;
  /** Whether a target may name a device to emulate. */
  devices: boolean;
}

/** The browser test frameworks, by the name a target's `framework` selects one with. */
const BROWSER_FRAMEWORKS: ReadonlyMap<string, IBrowserFramework> = new Map<string, IBrowserFramework>([
  [
    "playwright",
    {
      baseUrlVariable: "PLAYWRIGHT_BASE_URL",
      browserNames: new Map([["chrome", "chromium"]]),
      builds: playwrightBuilds,
      defaultBrowser: "chromium",
      defaultBuild: "chromium",
      permissive: true,
      devices: true,
    },
  ],
  [
    "cypress",
    {
      baseUrlVariable: "CYPRESS_BASE_URL",
      browserNames: new Map([["chrome", "chrome"]]),
      defaultBrowser: "electron",
      program: { link: ".fabr-cypress", option: "--cypress-cache=", install: cypressBinary },
      permissive: true,
      devices: false,
    },
  ],
]);

/** The flag prefix naming one of Playwright's own builds (`playwright/firefox`). */
const PLAYWRIGHT_FLAG = "playwright/";

/** The package whose registry names Playwright's builds. */
const PLAYWRIGHT_CORE = "playwright-core";

/** The first Playwright whose registry fabr reads. */
const MINIMUM_PLAYWRIGHT = "1.50";

/** The file marking a Playwright build installed, in its directory. */
const INSTALLED_MARKER = "INSTALLATION_COMPLETE";

/** The name a browser fabr fetches is linked beside the runner as. */
const BROWSER_LINK = ".fabr-browser";
/** The name Playwright's builds are linked beside the runner as. */
const PLAYWRIGHT_BROWSERS_LINK = ".fabr-playwright-browsers";

/** The package whose version names the Cypress binary. */
const CYPRESS = "cypress";

/** Where Cypress publishes its binary. */
const CYPRESS_DOWNLOADS = "https://download.cypress.io/desktop";

/** Make a browser test's requirements: its tests, compiled with `deps` and `compile_deps`, with `resources` and `expectations` beside them. */
export function browserTestRequirements(context: TargetContext): Computable<ResolutionSpec<TestRequirements>> {
  return Computable.forAll(
    [
      browserFramework(context),
      context.getFileProperty("tests", BUILD_OVERRIDE),
      context.getPackageProperty("deps", BUILD_OVERRIDE, NPM_FORMAT),
      context.getPackageProperty("compile_deps", BUILD_OVERRIDE, NPM_FORMAT),
      context.getFileProperty("resources", BUILD_OVERRIDE),
      context.getFileProperty("expectations", BUILD_OVERRIDE),
    ],
    ([, browser]: [ITestFramework, IBrowserFramework], tests, deps, compile_deps, test_resources, expectations) => ({
      ...testRequirements({
        package: new PackageSources([]),
        srcs: [],
        tests,
        deps,
        compile_deps,
        test_deps: new PackageSources([]),
        test_resources,
        resources: [],
        expectations,
      }),
      ...(browser.permissive ? { permissive: true } : {}),
    })
  );
}

/**
 * Compile a browser test's tests and run them in its browser, `base_url`
 * given in the framework's variable where it is set. As a test run, the
 * installs the runner is given (the browser, the framework's program) are
 * linked beside the runner; where `interactive`, the result is the program
 * `fabr run` runs, the framework's own interactive run, which finds them in
 * the tree pool.
 */
export function runBrowserTests(context: TargetContext, collected: TestContents, interactive: boolean): Computable<RuleResult> {
  return Computable.forAll(
    [browserFramework(context), context.getRequiredProperty("base_url")],
    ([framework, browser]: [ITestFramework, IBrowserFramework], baseUrl): Computable<RuleResult> => {
      const links = new Map<string, FileSet>();
      const place = interactive
        ? (_link: string, files: FileSet): Computable<string> =>
            context.execution.buildCache.ensureTree(files).then(() => `${TREE_MOUNT}/${files.toManifestHash()}`)
        : (link: string, files: FileSet): Computable<string> => {
            links.set(link, files);
            return Computable.resolve(`../${link}`);
          };
      return browserArguments(context, browser, collected.deps, place).then(runnerArgs =>
        compileAndRunTests(
          context,
          framework,
          {
            envProperty: "env",
            stabilityProperty: "stability",
            runnerArgs,
            links,
            env: new Map(baseUrl.toString().length === 0 ? [] : [[browser.baseUrlVariable, baseUrl.toString()]]),
          },
          collected,
          interactive
        )
      );
    }
  );
}

/** Get the test framework the target's `framework` names, with what a browser test makes of it. Rejects where it is no browser test framework. */
export function browserFramework(context: TargetContext): Computable<[ITestFramework, IBrowserFramework]> {
  return Computable.forAll(
    [testFramework(context, "framework", true), context.getRequiredProperty("framework")],
    (framework, name) => {
      const browser = BROWSER_FRAMEWORKS.get(name.toString().toUnmaskedString());
      if (browser === undefined) {
        throw new FabrError(
          `'${name.toDisplayString()}' is not a browser test framework (${[...BROWSER_FRAMEWORKS.keys()].join(", ")})`
        );
      }
      return [framework, browser] as [ITestFramework, IBrowserFramework];
    }
  );
}

/** A target's browser, as read: a `playwright/<name>` build, a browser fabr fetches, or none, the framework's own default. */
type IBrowser = { build: string } | { fetched: RunnableFileSet } | undefined;

/** The settings a target may give its browser, by property, with the runner option each is given as. */
const BROWSER_SETTINGS = new Map([
  ["viewport", "viewport"],
  ["user_agent", "user-agent"],
  ["device", "device"],
]);

/** Read the target's `browser`, under `run`: one `playwright/<name>` flag, one browser fabr fetches, or none. */
function targetBrowser(context: TargetContext): Computable<IBrowser> {
  return context.getFileProperty("browser", context.runOverrides()).then((sources): IBrowser | Computable<IBrowser> => {
    if (sources.length === 0) {
      return undefined;
    }
    if (sources.length > 1) {
      throw new FabrError("a browser test runs in one browser: declare a browser_test for each");
    }
    const [source] = sources;
    if (source instanceof Flag) {
      if (!source.name.startsWith(PLAYWRIGHT_FLAG)) {
        throw new FabrError(`'${source.name}' is not a browser: name a '${PLAYWRIGHT_FLAG}<name>' build or a browser fabr fetches`);
      }
      return { build: source.name.substring(PLAYWRIGHT_FLAG.length) };
    }
    return context.materializeSources(sources).then(([fetched]) => {
      if (!(fetched instanceof RunnableFileSet)) {
        throw new FabrError(
          "a browser test's browser is a browser fabr fetches, such as '@browser:chrome:156', or a Playwright build"
        );
      }
      return { fetched };
    });
  });
}

/**
 * Read the target's browser settings (`viewport`, `user_agent`, `device`) that
 * are set, by the runner option each is given as. Rejects where `viewport` is
 * not `<width>x<height>`, or `device` is set for a framework that emulates
 * none.
 */
function browserSettings(context: TargetContext, browser: IBrowserFramework): Computable<ReadonlyMap<string, SecureString>> {
  return Computable.forAll(
    [...BROWSER_SETTINGS.keys()].map(property =>
      context.getProperty(property).then(value => value?.toString() ?? SecureString.of(""))
    ),
    (...values: SecureString[]) => {
      const settings = new Map<string, SecureString>();
      [...BROWSER_SETTINGS].forEach(([property, option], i) => {
        const value = values[i];
        if (value.length === 0) {
          return;
        }
        if (property === "viewport" && !value.test(/^\d+x\d+$/)) {
          throw new FabrError(`'${value.toDisplayString()}' is not a viewport (expected '<width>x<height>', such as '1280x720')`);
        }
        if (property === "device" && !browser.devices) {
          throw new FabrError("this framework runs no devices: give the target a viewport and user_agent instead");
        }
        settings.set(option, value);
      });
      return settings;
    }
  );
}

/**
 * Make the options naming the target's browser to the framework's runner, or
 * the framework's own default where it names none. The browser is declared
 * as one configuration named after the target, `--browser=<target>=<the
 * framework's name for it>`, with its settings as
 * `--browser-<setting>=<target>=<value>`. A browser fabr fetches
 * (`@browser:chrome:156`) is given as `--browser-executable=<target>=<its
 * executable>`; a Playwright build (`playwright/<name>`), as the tests'
 * `playwright-core` names it, is fetched and given as
 * `--playwright-browsers=<directory>`; the framework's own program, where it
 * needs one, is installed and given likewise. `place` puts each install where
 * the runner reaches it, as `.fabr-browser`, `.fabr-playwright-browsers` and
 * the program's link name, and yields its path from the directory the runner
 * starts in.
 */
function browserArguments(
  context: TargetContext,
  browser: IBrowserFramework,
  deps: FileSet[],
  place: (link: string, files: FileSet) => Computable<string>
): Computable<RunnableArgument[]> {
  return Computable.forAll(
    [targetBrowser(context), browserSettings(context, browser)],
    (read: IBrowser, settings: ReadonlyMap<string, SecureString>) => {
      const chosen: IBrowser = read ?? (browser.defaultBuild === undefined ? undefined : { build: browser.defaultBuild });
      if (chosen !== undefined && "build" in chosen && browser.builds === undefined) {
        throw new FabrError(`'${PLAYWRIGHT_FLAG}${chosen.build}' is a Playwright build, which this framework does not run`).withHelp(
          "name a browser fabr fetches, such as '@browser:chrome:156'"
        );
      }
      const name = context.name;
      /* Each install as the option naming it, once placed. */
      const placed = (
        link: string,
        files: Computable<FileSet>,
        option: (dir: string) => RunnableArgument[]
      ): Computable<RunnableArgument[]> => files.then(installed => place(link, installed)).then(option);
      const options: Computable<RunnableArgument[]>[] = [];
      if (chosen === undefined) {
        options.push(Computable.resolve([`--browser=${name}=${browser.defaultBrowser}`]));
      } else if ("build" in chosen) {
        options.push(
          Computable.resolve([`--browser=${name}=${chosen.build}`]),
          placed(PLAYWRIGHT_BROWSERS_LINK, browser.builds!(context, [chosen.build], deps), dir => [
            { join: "", parts: ["--playwright-browsers=", { installFile: dir }] },
          ])
        );
      } else {
        /* The browser's one entry names it, and as a link names its executable's path in its install. */
        if (chosen.fetched.surface.size !== 1) {
          throw new FabrError(
            `the browser is a program with ${chosen.fetched.surface.size === 0 ? "no entry" : "several entries"}, where a browser has one: its executable`
          ).withHelp("name a browser fabr fetches, such as '@browser:chrome:156'");
        }
        const [[own, executable]] = [...chosen.fetched.surface];
        const frameworkName = browser.browserNames.get(own);
        if (frameworkName === undefined) {
          throw new FabrError(`'${own}' is not a browser a browser test can run in (${[...browser.browserNames.keys()].join(", ")})`);
        }
        if (!(executable instanceof SymlinkFile)) {
          throw new FabrError(`'${own}' has no executable of its own to run`);
        }
        options.push(
          placed(BROWSER_LINK, Computable.resolve<FileSet>(chosen.fetched), dir => [
            `--browser=${name}=${frameworkName}`,
            { join: "", parts: [`--browser-executable=${name}=`, { installFile: `${dir}/${executable.target}` }] },
          ])
        );
      }
      options.push(Computable.resolve([...settings].map(([option, value]) => secure`--browser-${option}=${name}=${value}`)));
      const program = browser.program;
      if (program !== undefined) {
        options.push(
          placed(program.link, program.install(context, deps), dir => [{ join: "", parts: [program.option, { installFile: dir }] }])
        );
      }
      return Computable.forAll(options, (...each: RunnableArgument[][]) => each.flat());
    }
  );
}

/**
 * Fetch the Cypress binary the `cypress` package among `deps` runs, for the
 * machine it runs on, laid out as its own installer leaves its cache: under its version,
 * marked verified, so a run does not smoke-test it first.
 */
function cypressBinary(context: TargetContext, deps: FileSet[]): Computable<FileSet> {
  const cypress = packageNamed(deps, CYPRESS);
  if (cypress?.version === undefined) {
    return Computable.reject(
      new FabrError(`A Cypress suite runs the binary its ${CYPRESS} package names, and its deps hold none`).withHelp(
        "add @npm:cypress to its deps"
      )
    );
  }
  const version = cypress.version;
  /* The machine the app runs on: TARGET under a tool's run, the host. */
  return context.getGlobalString(TARGET, context.runOverrides()).then(written => {
    const target = written.toUnmaskedString();
    const { os: platform, cpu } = tripleToNpm(target);
    if (platform === undefined || cpu === undefined) {
      throw new FabrError(`Cypress publishes no app for '${written.toDisplayString()}'`);
    }
    /* Cypress has no Windows arm64 build, and runs its x64 one there. */
    const arch = platform === "win32" && cpu === "arm64" ? "x64" : cpu;
    const url = `${CYPRESS_DOWNLOADS}/${version}?platform=${platform}&arch=${arch}`;
    return fetchArchive(context, {
      key: url,
      tag: "cypress:binary:1",
      report: { resource: `Cypress ${version}`, role: "content" },
      source: () => Computable.resolve({ url: SecureString.of(url), expected: undefined }),
    }).then(files =>
      FileSet.layout({ [version]: files, [`${version}/binary_state.json`]: new MemoryFile(Buffer.from('{ "verified": true }\n')) })
    );
  });
}

/**
 * Fetch Playwright's own builds of the browsers `names` (`chromium`,
 * `firefox`, `webkit`), as the `playwright-core` among `deps` names them for
 * this machine: each, with what Playwright installs beside it (its headless
 * shell, ffmpeg), unpacked into the directory Playwright looks for it in and
 * marked installed, as Playwright's own installer leaves it.
 */
function playwrightBuilds(context: TargetContext, names: string[], deps: FileSet[]): Computable<FileSet> {
  const core = packageNamed(deps, PLAYWRIGHT_CORE);
  if (core === undefined) {
    return Computable.reject(
      new FabrError(
        `'${PLAYWRIGHT_FLAG}<name>' installs the builds the tests' Playwright uses, and its deps hold no ${PLAYWRIGHT_CORE}`
      ).withHelp("add @playwright/test to its deps")
    );
  }
  return context.execution.buildCache.ensureTree(core).then(dir => {
    const executables = playwrightRegistry(dir, core.version).resolveBrowsers(names, {});
    return Computable.forAll(
      executables.map(executable => {
        const [url] = executable.downloadURLs ?? [];
        if (executable.directory === undefined || url === undefined) {
          throw new FabrError(`Playwright ${core.version ?? ""} has no build of ${executable.name} for this machine`);
        }
        const directory = path.basename(executable.directory);
        return fetchArchive(context, {
          key: url,
          tag: "playwright:build:1",
          report: { resource: `Playwright's ${executable.name}`, role: "content" },
          source: () => Computable.resolve({ url: SecureString.of(url), expected: undefined }),
        }).then(files =>
          FileSet.layout({ [directory]: files, [`${directory}/${INSTALLED_MARKER}`]: new MemoryFile(Buffer.alloc(0)) })
        );
      }),
      (...installed: FileSet[]) => FileSet.unionAll(...installed)
    );
  });
}

/** The part of Playwright's browser registry read: what an install of some browsers fetches. */
interface IPlaywrightRegistry {
  resolveBrowsers(names: string[], options: object): Array<{ name: string; directory?: string; downloadURLs?: string[] }>;
}

/**
 * Load the browser registry of the `playwright-core` installed at `dir`, in
 * this process: it names the builds for the machine it runs on. Throws where
 * the package has none of the shape read.
 */
function playwrightRegistry(dir: string, version: string | undefined): IPlaywrightRegistry {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const bundle = require(path.join(dir, "lib", "coreBundle")) as { registry?: { registry?: Partial<IPlaywrightRegistry> } };
  const registry = bundle.registry?.registry;
  if (typeof registry?.resolveBrowsers !== "function") {
    throw new FabrError(`${PLAYWRIGHT_CORE} ${version ?? ""} has no browser registry fabr can read`).withHelp(
      `use @playwright/test ${MINIMUM_PLAYWRIGHT} or later, or name the browsers with '@browser' references`
    );
  }
  return registry as IPlaywrightRegistry;
}

/** @return the package named `name` that `sets` hold or reach, or undefined where none does. */
function packageNamed(sets: FileSet[], name: string): PackageFileSet | undefined {
  const seen = new Set<PackageFileSet>();
  const visit = (pkg: PackageFileSet): PackageFileSet | undefined => {
    if (seen.has(pkg)) {
      return undefined;
    }
    seen.add(pkg);
    return pkg.packageName === name ? pkg : pkg.packages.map(visit).find(found => found !== undefined);
  };
  return sets
    .filter((set): set is PackageFileSet => set instanceof PackageFileSet)
    .map(visit)
    .find(found => found !== undefined);
}
