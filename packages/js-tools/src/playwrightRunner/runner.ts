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
 * Fabr's test runner for Playwright Test: it runs the real Playwright, from the
 * target's own dependencies, over the compiled test files, with the project's
 * own config (a compiled `playwright.config` at the root of the tree) wrapped
 * for the invocation ({@link wrapConfig}), and writes fabr's test report.
 * The target's browser is given as `--browser=<target>=<Playwright's name for
 * it>` and its settings (`support/BrowserConfigurations.ts`): the run's one
 * project. Playwright's own builds
 * are in the directory `--playwright-browsers` names, laid out as its
 * installer lays them out. The URL the suite runs against is
 * `PLAYWRIGHT_BASE_URL`.
 *
 * A setup file (`--setup`, the suite's `setupTests`) is the run's
 * `globalSetup`, run once before any test, where the config names none.
 *
 * Usage (the runner contract, as for every runner):
 *   node runner.js --report=<path> --env=node [--update-snapshots]
 *                  [--name-pattern=<regex>] [--setup=<file>]... [--pnp=<file>] [--reads=<file>]
 *                  [--artifacts=<dir>] [--retries=<n>] [--browser=<target>=<browser>]
 *                  [--browser-<setting>=<target>=<value>]...
 *                  [--playwright-browsers=<dir>]
 *                  <test-file>...
 *
 * With `--artifacts`, Playwright's `outputDir` is that directory, and each
 * test's attachments (a trace, a screenshot, a video) are kept there.
 *
 * Under `fabr run` it is started in the installation as
 *   node runner.js <options>... --interactive <compiled-tree> <test-file>... -- <args>...
 * and runs `playwright test <args>...` over the same config, reporting through
 * the config's own reporters (so `--ui`, `--headed` and `--debug` work as
 * they do in the project).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { configurationOf, IBrowserConfiguration, isConfigurationOption } from "../support/BrowserConfigurations";
import { parseJson, toJsonObject } from "../support/Json";
import { childPreloads, enterInteractiveRun, focusAllowed, loadPnpPreload, parseRunnerArgs } from "../testRunner/RunTests";
import type { IConfigSettings } from "./Config";
import { FABR_SOCKET_VARIABLE } from "../support/FabrSocket";
import { installProcessSlot, MAX_WORKERS } from "./ProcessSlot";
import type { IProjectConfiguration } from "./PlaywrightRun";
import type { IReporterOptions } from "./Reporter";

/** The first Playwright whose `updateSnapshots` takes `"changed"`. */
const MINIMUM_PLAYWRIGHT = [1, 50] as const;

/** The environment variable naming the URL the suite runs against. */
export const BASE_URL_VARIABLE = "PLAYWRIGHT_BASE_URL";

/** The file names a project's compiled Playwright config is looked for under, in order. */
const CONFIG_FILES = ["playwright.config.js", "playwright.config.cjs"];

/** Playwright's modules this runner loads, from the test installation. */
interface IPlaywright {
  /** The path of `@playwright/test`'s command line. */
  cli: string;
  /** The path of `playwright`'s `lib/util`, which holds its file matcher. */
  util: string;
}

/**
 * Find Playwright in the test installation, resolved from `root`, the working
 * directory inside it. Throws where `@playwright/test` is not installed there
 * (it belongs in the target's `deps`) or is older than
 * {@link MINIMUM_PLAYWRIGHT}.
 */
function findPlaywright(root: string): IPlaywright {
  const fromInstall = createRequire(path.join(root, "index.js"));
  let manifest: string;
  try {
    manifest = fromInstall.resolve("@playwright/test/package.json");
  } catch {
    throw new Error(
      "These tests run under Playwright, but '@playwright/test' is not among the target's dependencies.\nAdd it to the target's deps."
    );
  }
  const written = parseJson(fs.readFileSync(manifest, "utf8"), manifest, toJsonObject).version;
  const version = typeof written === "string" ? written : undefined;
  const [major, minor] = (version ?? "").split(".").map(Number);
  if (!(major > MINIMUM_PLAYWRIGHT[0] || (major === MINIMUM_PLAYWRIGHT[0] && minor >= MINIMUM_PLAYWRIGHT[1]))) {
    throw new Error(
      `fabr runs Playwright ${MINIMUM_PLAYWRIGHT.join(".")} or later, but the target's @playwright/test is ${version ?? "an unreadable version"}.`
    );
  }
  const fromPackage = createRequire(manifest);
  return {
    cli: fromPackage.resolve("@playwright/test/cli"),
    util: createRequire(fromPackage.resolve("playwright/package.json")).resolve("playwright/lib/util"),
  };
}

/** The option naming the directory Playwright's own builds are installed in, which only this runner takes. */
const BUILDS_OPTION = "--playwright-browsers=";

/**
 * Make the browser configuration's project settings: its browser, the
 * executable fabr fetched, and its `use`, the descriptor of the device it
 * names (from the tests' own Playwright, `devices`), then its viewport and
 * user agent. Throws for a device Playwright does not know.
 */
export function projectConfiguration(
  configuration: IBrowserConfiguration,
  devices: () => Readonly<Record<string, Record<string, unknown>>>
): IProjectConfiguration {
  const device = configuration.device === undefined ? {} : devices()[configuration.device];
  if (device === undefined) {
    throw new Error(`Playwright knows no device '${configuration.device ?? ""}'`);
  }
  return {
    name: configuration.name,
    browser: configuration.browser,
    ...(configuration.executable === undefined ? {} : { executable: configuration.executable }),
    use: {
      ...device,
      ...(configuration.viewport === undefined ? {} : { viewport: configuration.viewport }),
      ...(configuration.userAgent === undefined ? {} : { userAgent: configuration.userAgent }),
    },
  };
}

/**
 * Write the run's global setup module into `root` for the setup files `setup`
 * (`./`-prefixed paths within the tree, or module names): one that loads each
 * in turn and calls the function it exports, where it exports one, with
 * Playwright's config. A setup file may thus be a script that does its work
 * as it loads, or a `globalSetup` function.
 * @return the module's path.
 */
function setupModule(root: string, setup: ReadonlyArray<string>): string {
  const fromTree = createRequire(path.join(root, "index.js"));
  const files = setup.map(spec => (spec.startsWith("./") ? path.resolve(root, spec) : fromTree.resolve(spec)));
  const module = path.join(root, SETUP_MODULE);
  fs.writeFileSync(
    module,
    [
      "module.exports = async config => {",
      `  for (const file of ${JSON.stringify(files)}) {`,
      "    const loaded = require(file);",
      '    const run = typeof loaded === "function" ? loaded : loaded && loaded.default;',
      '    if (typeof run === "function") {',
      "      await run(config);",
      "    }",
      "  }",
      "};",
      "",
    ].join("\n")
  );
  return module;
}

/** The global setup module the runner writes for a suite's setup files, beside the compiled tests. */
const SETUP_MODULE = ".fabr-playwright-setup.cjs";

/** Load Playwright's device descriptors, by name, from the `@playwright/test` whose command line is `cli`. */
function playwrightDevices(cli: string): Readonly<Record<string, Record<string, unknown>>> {
  const test = createRequire(cli)("@playwright/test") as { devices?: Record<string, Record<string, unknown>> };
  return test.devices ?? {};
}

/**
 * Run the test files `argv` names under Playwright. Playwright ends the
 * process once the run ends, after fabr's reporter has written the report.
 */
export function main(argv: string[]): void {
  const configured = configurationOf(argv);
  const buildsOption = argv.find(arg => arg.startsWith(BUILDS_OPTION));
  /* By their real path, so a browser keeps one location from run to run (a
   * firewall's permission for it holds). */
  const builds = buildsOption === undefined ? undefined : fs.realpathSync(path.resolve(buildsOption.substring(BUILDS_OPTION.length)));
  const interactive = enterInteractiveRun(argv);
  const options = parseRunnerArgs(
    (interactive?.argv ?? argv).filter(arg => !isConfigurationOption(arg) && !arg.startsWith(BUILDS_OPTION))
  );
  if (options.env !== "node") {
    throw new Error(
      "Playwright tests run under node, not in a DOM: move 'dom' to the target's compile_deps, where it gives the browser types alone."
    );
  }
  loadPnpPreload(options);
  const root = process.cwd();
  const playwright = findPlaywright(root);
  if (builds !== undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = builds;
  }
  const report = path.resolve(root, options.report);
  const name = interactive === undefined ? path.basename(report).replace(/\.json(\.\d+)?$/, "$1") : "interactive";
  const files = options.files.map(file => path.resolve(root, file));
  const baseURL = process.env[BASE_URL_VARIABLE];
  const config = CONFIG_FILES.map(file => path.join(root, file)).find(file => fs.existsSync(file));
  const settings: IConfigSettings = {
    ...(config === undefined ? {} : { config }),
    util: playwright.util,
    configDir: root,
    files,
    outputDir:
      options.artifacts === undefined ? path.resolve(root, "..", ".fabr-playwright", name) : path.resolve(root, options.artifacts),
    retries: options.retries ?? 0,
    forbidOnly: !focusAllowed(options.only, "Playwright"),
    /* As many workers as the machine's processors run at SLOTS_PER_WORKER
     * slots each: Playwright's own default, outside CI. Where the workers
     * take fabr's slots, no more than that, so that every worker of the run
     * can hold its slots at once. */
    workers: MAX_WORKERS,
    ...(process.env[FABR_SOCKET_VARIABLE] ? { maxWorkers: MAX_WORKERS } : {}),
    ...(baseURL === undefined || baseURL === "" ? {} : { baseURL }),
    ...(configured === undefined ? {} : { configuration: projectConfiguration(configured, () => playwrightDevices(playwright.cli)) }),
    ...(options.setup.length === 0 ? {} : { globalSetup: setupModule(root, options.setup) }),
    /* An interactive run reports through the config's own reporters, and
     * updates snapshots where its command line says to. */
    ...(interactive !== undefined
      ? {}
      : {
          update: options.update,
          reporter: [
            path.join(__dirname, "Reporter.js"),
            {
              ...(options.artifacts === undefined ? {} : { artifacts: path.resolve(root, options.artifacts) }),
              report,
              files,
              named: options.namePattern !== undefined,
            } satisfies IReporterOptions,
          ],
        }),
  };
  /* Beside the project's config, so that what it names relative to its own
   * directory means the same. */
  const wrapper = path.join(root, `.fabr-playwright-${name}.config.cjs`);
  fs.writeFileSync(
    wrapper,
    `module.exports = require(${JSON.stringify(path.join(__dirname, "Config.js"))}).wrappedConfig(${JSON.stringify(settings)});\n`
  );
  const children = childPreloads(options);
  process.on("exit", () => children.finish());
  /* Where fabr offers its socket, every process of the run adds the slot
   * fixture: this one, which loads the tests to list them, and each worker. */
  if (process.env[FABR_SOCKET_VARIABLE]) {
    installProcessSlot();
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(path.join(__dirname, "preload.js"))}`]
      .filter(Boolean)
      .join(" ");
  }
  /* The name pattern is passed as Playwright's `--grep`, not a config's
   * `grep`, which would also filter out the tests of the projects a run
   * depends on. */
  process.argv = [
    process.execPath,
    playwright.cli,
    "test",
    `--config=${wrapper}`,
    ...(interactive === undefined
      ? ["--pass-with-no-tests", ...(options.namePattern === undefined ? [] : [`--grep=${options.namePattern}`])]
      : interactive.frameworkArgs),
  ];
  require(playwright.cli);
}
