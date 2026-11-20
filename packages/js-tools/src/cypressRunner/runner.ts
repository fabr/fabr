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
 * Fabr's test runner for Cypress: it runs the real Cypress, from the target's
 * own dependencies, through its Module API (`cypress.run`), over the compiled
 * spec files, with the project's own config (a compiled `cypress.config` at
 * the root of the tree; Cypress's defaults where there is none), and writes
 * fabr's test report. The Cypress binary is in the directory `--cypress-cache`
 * names, laid out as Cypress's own cache. The target's browser is given as
 * `--browser=<target>=<Cypress's name for it>` and its settings
 * (`support/BrowserConfigurations.ts`): the specs run in its executable, at
 * its viewport and user agent, or in Cypress's own Electron where fabr
 * fetched none. The URL the suite
 * runs against is `CYPRESS_BASE_URL`.
 *
 * Usage (the runner contract, as for every runner):
 *   node runner.js --report=<path> --env=node [--update-snapshots]
 *                  [--name-pattern=<regex>] [--setup=<file>]... [--pnp=<file>] [--reads=<file>] [--artifacts=<dir>]
 *                  [--browser=<target>=<browser>]
 *                  [--browser-<setting>=<target>=<value>]... [--cypress-cache=<dir>]
 *                  <spec-file>...
 *
 * With `--artifacts`, Cypress's screenshots and videos are kept there. A
 * setup file (`--setup`) runs in the browser before every spec, after the
 * suite's own support file; with `--name-pattern`, only the tests whose full
 * names it matches are registered. Both are done by a support file of fabr's
 * that loads the suite's own first.
 *
 * Under `fabr run` it is started in the installation as
 *   node runner.js <options>... --interactive <compiled-tree> <spec-file>... -- <args>...
 * and runs `cypress open <args>...` over the same specs and config, in the
 * target's browser where fabr fetched one.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { configurationOf, isConfigurationOption } from "../support/BrowserConfigurations";
import { buildReport, endAfterReport } from "../testRunner/Report";
import { childPreloads, enterInteractiveRun, loadPnpPreload, parseRunnerArgs } from "../testRunner/RunTests";
import { ICypressResult, supportFileOf, supportSource, toTestResults } from "./CypressRun";

/** The option naming the Cypress cache directory, which only this runner takes. */
const CACHE_OPTION = "--cypress-cache=";

/** The compiled config files Cypress may find at the root of the tree, in the order looked for. */
const CONFIG_FILES = ["cypress.config.js", "cypress.config.cjs"];

/** The config fabr writes for a suite with none of its own. */
const DEFAULT_CONFIG_FILE = "fabr-cypress.config.js";

/** The support file fabr writes for a suite's setup files or a name pattern, beside the compiled specs (no dotfile: Cypress serves none). */
const SUPPORT_FILE = "fabr-cypress-support.js";

/** The part of Cypress's Module API used, and the directory its module is in. */
interface ICypress {
  run(options: Record<string, unknown>): Promise<ICypressResult>;
  open(options: Record<string, unknown>): Promise<number | undefined>;
  dir: string;
}

/** The part of Cypress's command line module used: what `cypress open` makes of its arguments. */
interface ICypressCli {
  parseOpenCommand(args: string[]): Promise<Record<string, unknown>>;
}

/** Run the spec files `argv` names under Cypress, and write the report. */
export async function main(argv: string[]): Promise<void> {
  const configuration = configurationOf(argv);
  const cacheOption = argv.find(arg => arg.startsWith(CACHE_OPTION));
  /* By its real path, which its content fixes. */
  const cache = cacheOption === undefined ? undefined : fs.realpathSync(path.resolve(cacheOption.substring(CACHE_OPTION.length)));
  const interactive = enterInteractiveRun(argv);
  const options = parseRunnerArgs(
    (interactive?.argv ?? argv).filter(arg => !isConfigurationOption(arg) && !arg.startsWith(CACHE_OPTION))
  );
  if (options.env !== "node") {
    throw new Error(
      "Cypress specs are run by Cypress, not in a DOM: move 'dom' to the target's compile_deps, where it gives the browser types alone."
    );
  }
  loadPnpPreload(options);
  if (cache !== undefined) {
    process.env.CYPRESS_CACHE_FOLDER = cache;
  }
  const root = process.cwd();
  const cypress = findCypress(root);
  const files = options.files.map(file => path.resolve(root, file));
  const config = CONFIG_FILES.map(file => path.join(root, file)).find(file => fs.existsSync(file)) ?? defaultConfig(root);
  const support = supportFor(root, config, options.setup, options.namePattern);
  const children = childPreloads(options);
  process.on("exit", () => children.finish());
  const start = Date.now();
  const kept = options.artifacts === undefined ? undefined : path.resolve(root, options.artifacts);
  const browser = configuration?.executable === undefined ? {} : { browser: configuration.executable };
  /* The files to run are fabr's to choose, so the config's own pattern,
   * written for the sources, is replaced by them. */
  const settings = {
    specPattern: files,
    /* The target's stability decides, whatever the config says. */
    retries: { runMode: options.retries ?? 0, openMode: 0 },
    ...(support === undefined ? {} : { supportFile: support }),
    ...(kept === undefined ? {} : { screenshotsFolder: path.join(kept, "screenshots"), videosFolder: path.join(kept, "videos") }),
    ...(configuration?.viewport === undefined
      ? {}
      : { viewportWidth: configuration.viewport.width, viewportHeight: configuration.viewport.height }),
    ...(configuration?.userAgent === undefined ? {} : { userAgent: configuration.userAgent }),
  };
  if (interactive !== undefined) {
    const written = await openArguments(cypress, interactive.frameworkArgs);
    const code = await cypress.open({ project: root, configFile: config, e2e: true, ...browser, ...written, config: settings });
    process.exit(code ?? 0);
  }
  const result = await cypress.run({
    project: root,
    configFile: config,
    spec: files.join(","),
    ...browser,
    headless: true,
    config: settings,
  });
  const tests = toTestResults(result, files);
  fs.writeFileSync(path.resolve(root, options.report), JSON.stringify(buildReport(tests, start, Date.now()), undefined, 2));
  endAfterReport(0);
}

/**
 * Write a config for a suite with none of its own, which Cypress requires:
 * Cypress's defaults, with no support file unless one is at its default
 * location.
 * @return the config's path.
 */
function defaultConfig(root: string): string {
  const support = supportFileOf(root, undefined, file => fs.existsSync(file));
  const file = path.join(root, DEFAULT_CONFIG_FILE);
  fs.writeFileSync(file, `module.exports = { e2e: { supportFile: ${JSON.stringify(support ?? false)} } };\n`);
  return file;
}

/**
 * @return the support file to run in place of the one the suite's `config`
 * names, or undefined to leave its own: with setup files (`--setup`, the
 * suite's `setupTests`) or a name pattern, a file of fabr's that loads the
 * suite's own support file and then the setup files, and runs only the tests
 * the pattern matches ({@link supportSource}); without either, the suite's own
 * where its config names a TypeScript source, by its compiled file.
 */
function supportFor(root: string, config: string, setup: ReadonlyArray<string>, namePattern: string | undefined): string | undefined {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const loaded = require(config) as { default?: unknown };
  const written = (loaded.default ?? loaded) as { e2e?: { supportFile?: unknown } };
  const named = written.e2e?.supportFile;
  const own = supportFileOf(root, named, file => fs.existsSync(file));
  if (namePattern === undefined && setup.length === 0) {
    return typeof named === "string" && own !== undefined && own !== path.resolve(root, named) ? own : undefined;
  }
  if (namePattern !== undefined) {
    try {
      new RegExp(namePattern);
    } catch (err) {
      throw new Error(
        `'fabr test -t ${namePattern}' is not a regular expression: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const fromTree = createRequire(path.join(root, "index.js"));
  const setupFiles = setup.map(spec => (spec.startsWith("./") ? path.resolve(root, spec) : fromTree.resolve(spec)));
  const file = path.join(root, SUPPORT_FILE);
  fs.writeFileSync(file, supportSource([...(own === undefined ? [] : [own]), ...setupFiles], namePattern));
  return file;
}

/** Find Cypress in the test installation, resolved from `root`, the working directory inside it. Throws where `cypress` is not installed there. */
function findCypress(root: string): ICypress {
  const fromInstall = createRequire(path.join(root, "index.js"));
  let entry: string;
  try {
    entry = fromInstall.resolve("cypress");
  } catch {
    throw new Error(
      "These specs run under Cypress, but 'cypress' is not among the target's dependencies.\nAdd it to the target's deps."
    );
  }
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const cypress = require(entry) as Partial<ICypress> & { default?: Partial<ICypress> };
  const api = typeof cypress.run === "function" ? cypress : cypress.default;
  if (typeof api?.run !== "function" || typeof api.open !== "function") {
    throw new Error(`The target's Cypress has no Module API run() fabr can call (${entry})`);
  }
  return { run: api.run.bind(api), open: (api.open as ICypress["open"]).bind(api), dir: path.dirname(entry) };
}

/**
 * Read the arguments of `cypress open` as Cypress's own command line does, into
 * options of its Module API. Throws where they set the config, which the run
 * sets.
 */
async function openArguments(cypress: ICypress, args: string[]): Promise<Record<string, unknown>> {
  /* The command line's own module, beside the Module API's, as Cypress's bin loads it. */
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const loaded = require(path.join(cypress.dir, "cli")) as { default?: Partial<ICypressCli> };
  if (typeof loaded.default?.parseOpenCommand !== "function") {
    throw new Error(`The target's Cypress reads no 'cypress open' arguments fabr can pass on (${cypress.dir})`);
  }
  const written = await loaded.default.parseOpenCommand(["open", ...args]);
  if (written.config !== undefined || written.configFile !== undefined || written.project !== undefined) {
    throw new Error("fabr sets the config and project Cypress opens: set what you need in the suite's cypress.config");
  }
  return written;
}
