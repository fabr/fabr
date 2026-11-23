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
 * The Playwright runner's two conversions: from fabr's runner contract and the
 * project's own Playwright config to the config one invocation runs with, and
 * from what Playwright reports to fabr's test results. They are apart from
 * runner.ts so they can be tested without Playwright.
 *
 * Playwright's interfaces are typed here, structurally: Playwright comes from
 * the target's dependencies, at the version the project chose.
 */

import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ITestResult } from "@fabr-build/core";
import { framesOf, referenceInPath, reportPathOf } from "../testRunner/Report";

/** A test file pattern as Playwright's config takes one: a glob or a regular expression. */
export type FilePattern = string | RegExp | ReadonlyArray<string | RegExp>;

/** What this runner reads of one project of a Playwright config, the rest passed through. */
export interface IPlaywrightProject {
  name?: string;
  testDir?: string;
  testMatch?: FilePattern;
  testIgnore?: FilePattern;
  use?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What this runner reads of a Playwright config, the rest passed through. */
export interface IPlaywrightConfig extends IPlaywrightProject {
  projects?: IPlaywrightProject[];
  globalTimeout?: number;
  workers?: number | string;
  globalSetup?: string | string[];
  globalTeardown?: string | string[];
}

/** Playwright's own default `testMatch`. */
export const DEFAULT_TEST_MATCH = "**/*.@(spec|test).?(c|m)[jt]s?(x)";

/** What one invocation's config is made from. */
export interface IInvocation {
  /** The directory of the project's config, the compiled tree's root. */
  configDir: string;
  /** The invocation's test files, absolute. */
  files: ReadonlyArray<string>;
  /** @return the path a compiled test file is matched as: where its source
   * would be in the compiled tree (`<configDir>/tests/a.spec.ts`), since the
   * project's patterns are written for the sources. */
  sourceOf(compiled: string): string;
  /** Make Playwright's own matcher for `testMatch` or `testIgnore` patterns. */
  matcher(patterns: FilePattern): (file: string) => boolean;
  /** @return true if `file` exists, otherwise false. */
  exists(file: string): boolean;
  /** Where Playwright writes the invocation's artifacts. */
  outputDir: string;
  /** Whether to rewrite recorded expectations; undefined leaves it to the config and the command line. */
  update?: boolean;
  /** How many more times a failed test runs within the run: `retries` in the
   * config and in every project, whatever they say. */
  retries: number;
  /** How many workers the run starts where the config sets none. */
  workers?: number;
  /** The run's global setup module, made of the suite's setup files, where it has any. */
  globalSetup?: string;
  /** The URL the suite runs against, if any: `use.baseURL` in every project. */
  baseURL?: string;
  /** The target's browser configuration, which is the run's one project. */
  configuration?: IProjectConfiguration;
  /** fabr's reporter, as a config's reporter entry; undefined leaves the config's own. */
  reporter?: [string, Record<string, unknown>];
}

/** A browser configuration as the settings of its Playwright project. */
export interface IProjectConfiguration {
  name: string;
  /** The browser, by Playwright's name for it. */
  browser: string;
  /** The browser's executable, where fabr fetched it. */
  executable?: string;
  /** The project's `use`: a device's descriptor, then the viewport and user agent. */
  use: Record<string, unknown>;
}

/**
 * Make the config one invocation runs with from the project's own config,
 * `user`, which is otherwise passed through:
 * - The run has one project, named and set up as the browser configuration
 *   is where there is one, its `launchOptions.executablePath` the browser
 *   fabr fetched, where it fetched one. It runs the invocation's
 *   files that the config's `testDir`, `testMatch` and `testIgnore` select,
 *   each matched as its source ({@link IInvocation.sourceOf}); with no such
 *   file the run has no project.
 * - fabr's reporter, where the invocation has one, is the only reporter, given
 *   the invocation's files not selected as `unmatched`.
 * - `outputDir` and `retries` are the invocation's, at the top and in the
 *   project; `workers` the invocation's where the config sets none;
 *   `globalTimeout` and `shard` are off; snapshots are rewritten as `update`
 *   says, where it is given; and `use.baseURL` is the invocation's URL, where
 *   it has one.
 * - A `globalSetup` or `globalTeardown` naming a TypeScript source that is
 *   not there names its compiled file. The suite's setup files are the
 *   `globalSetup`.
 *
 * Throws where the config defines projects of its own, or names a
 * `globalSetup` while the suite has setup files.
 */
export function wrapConfig(user: IPlaywrightConfig, invocation: IInvocation): IPlaywrightConfig {
  const { projects: written, ...top } = user;
  if (written !== undefined && written.length > 0) {
    throw new Error(
      "The Playwright config defines projects, and a browser_test is one: declare a browser_test for each browser, setting its browser, viewport and device, and sign in from the config's globalSetup."
    );
  }
  if (invocation.globalSetup !== undefined && top.globalSetup !== undefined) {
    throw new Error("The Playwright config names a globalSetup, and the suite has a setupTests file: keep one of them.");
  }
  const configuration = invocation.configuration;
  const project: IPlaywrightProject =
    configuration === undefined ? {} : { name: configuration.name, use: { ...configuration.use, browserName: configuration.browser } };
  const testDir = top.testDir === undefined ? invocation.configDir : path.resolve(invocation.configDir, top.testDir);
  const match = invocation.matcher(top.testMatch ?? DEFAULT_TEST_MATCH);
  const ignore = invocation.matcher(top.testIgnore ?? []);
  const files = invocation.files.filter(file => {
    const source = invocation.sourceOf(file);
    return isWithin(testDir, source) && match(source) && !ignore(source);
  });
  const use = (written: Record<string, unknown> | undefined, ofProject = false): { use?: Record<string, unknown> } => {
    const executable = ofProject ? configuration?.executable : undefined;
    const additions = {
      ...(invocation.baseURL === undefined ? {} : { baseURL: invocation.baseURL }),
      /* A project's `launchOptions` replaces the config's whole: carry both. */
      ...(executable === undefined
        ? {}
        : {
            launchOptions: {
              ...(top.use?.launchOptions as Record<string, unknown> | undefined),
              ...(written?.launchOptions as Record<string, unknown> | undefined),
              executablePath: executable,
            },
          }),
    };
    return written === undefined && Object.keys(additions).length === 0 ? {} : { use: { ...written, ...additions } };
  };
  const reporter = invocation.reporter;
  return {
    ...top,
    ...(top.globalSetup === undefined ? {} : { globalSetup: compiledScripts(top.globalSetup, invocation) }),
    ...(invocation.globalSetup === undefined ? {} : { globalSetup: invocation.globalSetup }),
    ...(top.globalTeardown === undefined ? {} : { globalTeardown: compiledScripts(top.globalTeardown, invocation) }),
    ...use(top.use),
    ...(top.workers === undefined && invocation.workers !== undefined ? { workers: invocation.workers } : {}),
    ...(reporter === undefined
      ? {}
      : { reporter: [[reporter[0], { ...reporter[1], unmatched: invocation.files.filter(file => !files.includes(file)) }]] }),
    shard: null,
    globalTimeout: 0,
    outputDir: invocation.outputDir,
    retries: invocation.retries,
    ...(invocation.update === undefined ? {} : { updateSnapshots: invocation.update ? "changed" : "none" }),
    projects:
      files.length === 0
        ? []
        : [
            {
              ...project,
              testDir,
              testMatch: files.map(exactly),
              testIgnore: [],
              outputDir: invocation.outputDir,
              retries: invocation.retries,
              ...use(project.use, true),
            },
          ],
  };
}

/** @return true if `file` is inside `dir`, otherwise false. */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** @return a pattern matching exactly the file `file`. */
function exactly(file: string): RegExp {
  return new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** The extension a TypeScript source's compiled file has, by the source's. */
const COMPILED_EXTENSION = new Map([
  [".ts", ".js"],
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
]);

/** @return `scripts` (paths the config resolves from its own directory, or
 * module names), each naming a TypeScript source that is not there named by
 * its compiled file instead. */
function compiledScripts(scripts: string | string[], invocation: IInvocation): string | string[] {
  const compiled = (script: string): string => {
    if (!script.startsWith(".") && !path.isAbsolute(script)) {
      return script;
    }
    const file = path.resolve(invocation.configDir, script);
    const extension = COMPILED_EXTENSION.get(path.extname(file));
    if (invocation.exists(file) || extension === undefined) {
      return script;
    }
    const output = file.slice(0, -path.extname(file).length) + extension;
    return invocation.exists(output) ? output : script;
  };
  return Array.isArray(scripts) ? scripts.map(compiled) : compiled(scripts);
}

/** An error as Playwright's reporter interface presents one. */
export interface IReportedError {
  message?: string;
  stack?: string;
  value?: string;
}

/** A file a test's run attached, as Playwright's reporter interface presents
 * one: on disk at `path`, or in memory as `body`. */
export interface IReportedAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
}

/** One run of a test, as Playwright's reporter interface presents it. */
export interface IReportedResult {
  status: string;
  duration: number;
  errors: ReadonlyArray<IReportedError>;
  attachments?: ReadonlyArray<IReportedAttachment>;
}

/** One test, as Playwright's reporter interface presents it. */
export interface IReportedTest {
  titlePath(): string[];
  location: { file: string };
  outcome(): string;
  results: ReadonlyArray<IReportedResult>;
}

/**
 * Convert one test's runs to its result, named `suite › title` and for its
 * file's source. An expected outcome is passed or skipped as its last run
 * was, an unexpected one failed with its last failing run's errors, and a
 * flaky one (passed on Playwright's own retry) passed and flaky, with its
 * retries counted.
 */
export function toTestResult(test: IReportedTest): ITestResult {
  return resultOf(test).result;
}

/** @return the run of `test` its result reports: its last failing run where it
 * failed, else its last. */
export function reportedRunOf(test: IReportedTest): IReportedResult | undefined {
  return resultOf(test).run;
}

/** Convert one test's runs ({@link toTestResult}), with the run it reports. */
function resultOf(test: IReportedTest): { result: ITestResult; run: IReportedResult | undefined } {
  /* Leave out the root suite, the project and the file: the run's one project is the target's. */
  const [, , , ...titles] = test.titlePath();
  const name = titles.join(" › ");
  const duration = test.results.reduce((sum, result) => sum + result.duration, 0);
  const filePath = filePathOf(test.location.file);
  const last = test.results[test.results.length - 1];
  switch (test.outcome()) {
    case "skipped":
      return { result: { name, filePath, status: "skipped", duration }, run: last };
    case "flaky":
      return { result: { name, filePath, status: "passed", duration, flaky: true, retries: test.results.length - 1 }, run: last };
    case "unexpected": {
      const failed = [...test.results].reverse().find(result => result.errors.length > 0) ?? last;
      return { result: { name, filePath, status: "failed", duration, ...describeErrors(failed?.errors ?? []) }, run: failed };
    }
    default:
      return { result: { name, filePath, status: last?.status === "skipped" ? "skipped" : "passed", duration }, run: last };
  }
}

/** Report an error raised outside every test (a failed `globalSetup`, a test
 * file that could not be loaded) as a failure of the invocation's file. */
export function toRunFailure(error: IReportedError, file: string | undefined): ITestResult {
  const filePath = file === undefined ? undefined : filePathOf(file);
  return {
    name: filePath ?? "(outside any test)",
    ...(filePath === undefined ? {} : { filePath }),
    status: "failed",
    duration: 0,
    ...describeErrors([error]),
  };
}

/** @return the report's name for the file Playwright reports a test at: the
 * source a `fabr:` reference in it names, else its compiled file's source. */
function filePathOf(file: string): string {
  return referenceInPath(file) ?? reportPathOf(file);
}

/**
 * Split a failure into its one-line message (the first line of its first
 * error) and the rest as its trace: the remainder of each error's message,
 * and the frames of each stack in the code under test ({@link framesOf}).
 * Colour codes are removed, paths inside the compiled tree are made relative
 * to it, and a failed recorded expectation gains fabr's remedy.
 */
export function describeErrors(errors: ReadonlyArray<IReportedError>): { message: string; trace?: string } {
  const [summary = "failed", ...detail] = errors
    .map(error => {
      const message = withinTree(stripVTControlCharacters(error.message ?? error.value ?? "failed"));
      return [withFabrRemedy(message), framesOf(error.stack === undefined ? undefined : stripVTControlCharacters(error.stack))]
        .filter(part => part !== undefined && part !== "")
        .join("\n");
    })
    .join("\n\n")
    .split("\n");
  return { message: summary, trace: detail.join("\n").trim() || undefined };
}

/** @return `text` with each path inside the compiled tree, the runner's working
 * directory, written relative to it. */
function withinTree(text: string): string {
  const root = process.cwd() + path.sep;
  return text.split(root).join("");
}

/** Playwright's wording for a recorded expectation that is missing or does not match. */
const RECORD_FAILURE =
  /^(Error: )?(A snapshot doesn't exist|Screenshot comparison failed|Snapshot comparison failed|.*toMatchSnapshot|.*toHaveScreenshot|.*toMatchAriaSnapshot)/;

/** Add to a failed record's message how to record the new value with fabr
 * (`fabr test -u`). */
function withFabrRemedy(message: string): string {
  const [first, ...rest] = message.split("\n");
  return RECORD_FAILURE.test(first) ? [`${first} Run 'fabr test -u' to record the new value.`, ...rest].join("\n") : message;
}
