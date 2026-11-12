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
 * Run one test file in this process: install its environment, the mock
 * registry, the hoist and the `jest` object, then run the file with
 * jest-circus.
 *
 * runner.ts runs a single-file invocation in its own process, and forks this
 * module as a child for each file of a list, which sends its result back over
 * the IPC channel. A child that dies before sending one (a module that fails to
 * load, a broken preload) is reported as failed with the stderr it wrote.
 */

import * as fs from "node:fs";
import { inspect } from "node:util";
import { endAfterReport, sourcePathOf } from "../testRunner/Report";
import { DocblockPragmas, environmentFor, IFileEnvironment, installJsdom } from "./Environment";
import { installHoist } from "./Hoist";
import { IFakeTimers, IMocker, makeJestObject } from "./JestObject";
import { ILoaderModule, installSeams, MockRegistry } from "./Registry";
import { IMockerControls, makeEnvironmentFacade, makeRuntimeFacade } from "./RuntimeFacade";
import { jestLibrary, requireEnvironment } from "./Tools";
import { makeJestConfig } from "./Config";
import { formatExecError, formatFailures, IExecError, IFormattableResult } from "./Failures";

/** The test file a child runs, and how. */
export interface IChildRequest {
  testFile: string;
  root: string;
  env: string;
  updateSnapshots: boolean;
  namePattern?: string;
  timeoutMs: number;
  setup: string[];
}

/** One test's outcome, as circus reports it, with its `failureMessages`
 * formatted (see Failures.ts), which needs the child's jest config. */
export interface IChildTestResult {
  fullName: string;
  status: string;
  duration?: number | null;
  failureMessages: string[];
}

export interface IChildResult {
  testFile: string;
  results: IChildTestResult[];
  /** A failure of the file rather than of a test in it, formatted: the file
   * could not be run, or an error was raised outside any test (an unhandled
   * rejection, a failed `afterAll`), `results` then holding the tests that
   * ran. */
  execError?: string;
}

/** jest-mock, as this module constructs it. */
interface IMockerModule {
  ModuleMocker: new (
    global: unknown
  ) => IMocker & IMockerControls & { getMetadata(c: unknown): unknown; generateFromMetadata(m: unknown): unknown };
}

type CircusResult = IChildTestResult & IFormattableResult;

type TestFramework = (
  globalConfig: unknown,
  projectConfig: unknown,
  environment: unknown,
  runtime: unknown,
  testPath: string,
  sendMessageToJest?: unknown
) => Promise<{ testResults: CircusResult[]; testExecError?: IExecError }>;

/**
 * Run `request`'s test file in this process, its environment chosen by
 * {@link fileEnvironment}.
 * @return each test's outcome, its failures formatted, and the file's own
 *   failure as `execError`. Rejects where the environment cannot be provided
 *   or circus itself fails.
 */
export async function runTestFile(request: IChildRequest): Promise<IChildResult> {
  const environment = fileEnvironment(request);
  requireEnvironment(environment.env, environment.env !== request.env);
  if (environment.env === "jsdom") {
    installJsdom(environment.options);
  }

  const { globalConfig, projectConfig } = await makeJestConfig(request);

  /* The module registry, the load-time hoist and the `jest` object, which
   * circus does not provide. */
  const mocker = new (jestLibrary("jest-mock") as IMockerModule).ModuleMocker(globalThis);
  const registry = new MockRegistry(request.root, mocker);
  installSeams(registry);
  installHoist(request.root);

  const timers = new (
    jestLibrary("@jest/fake-timers") as {
      ModernFakeTimers: new (opts: unknown) => IFakeTimers;
    }
  ).ModernFakeTimers({ global: globalThis, config: { rootDir: request.root, fakeTimers: {} } });
  const env = { registry, mocker, timers, seed: (globalConfig as { seed?: number }).seed };
  /* The `jest` global resolves module specifiers relative to the test file;
   * `@jest/globals`, which the hoisted `jest.mock` calls require, serves each
   * module a `jest` resolving relative to it. A mock registered from another
   * base than the requires it should catch is never served. */
  const jest = makeJestObject(env, { filename: request.testFile });
  (globalThis as Record<string, unknown>).jest = jest;
  registry.jestGlobalsFor = (caller: ILoaderModule | undefined) =>
    makeJestGlobals(makeJestObject(env, caller ?? { filename: request.testFile }));

  /* jest 29 exports the adapter directly; 30 exports it as `.default`. */
  const circus = jestLibrary("jest-circus/runner") as { default?: TestFramework };
  const testFramework = (circus.default ?? circus) as TestFramework;

  let result;
  try {
    result = await testFramework(
      globalConfig,
      projectConfig,
      makeEnvironmentFacade(),
      makeRuntimeFacade(registry, mocker),
      request.testFile
    );
  } finally {
    /* Restore real timers, which circus does not (the environment facade has
     * no fakeTimers), so a file whose last test leaves fake timers installed
     * does not fake the clock for the reporting that follows. */
    timers.dispose();
  }
  return {
    testFile: request.testFile,
    results: (result.testResults ?? []).map(test => ({
      ...test,
      failureMessages: test.failureMessages.length === 0 ? [] : formatFailures(test, projectConfig, globalConfig, request.testFile),
    })),
    execError:
      result.testExecError === undefined
        ? undefined
        : formatExecError(result.testExecError, projectConfig, globalConfig, request.testFile),
  };
}

interface IDocblockModule {
  extract(contents: string): string;
  parse(docblock: string): DocblockPragmas;
}

/**
 * Choose the environment the file runs in: `request.env` unless its leading
 * docblock says otherwise (see environmentFor). The docblock is read from the
 * source the test was compiled from, as jest reads it, else from the compiled
 * file where the source is not staged.
 */
function fileEnvironment(request: IChildRequest): IFileEnvironment {
  const docblock = jestLibrary("jest-docblock") as IDocblockModule;
  const source = sourcePathOf(request.testFile);
  const text = fs.readFileSync(source !== undefined && fs.existsSync(source) ? source : request.testFile, "utf8");
  return environmentFor(docblock.parse(docblock.extract(text)), request.env);
}

/** `@jest/globals`' exports besides `jest`: the globals circus installs, read
 * off the global object. */
const FRAMEWORK_GLOBALS = [
  "expect",
  "describe",
  "fdescribe",
  "xdescribe",
  "it",
  "fit",
  "xit",
  "test",
  "xtest",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
];

/**
 * Make the `@jest/globals` namespace for one module: `jest`, the module's own
 * `jest` object, and each of {@link FRAMEWORK_GLOBALS} as the global object
 * holds it. Throws where one of those is not installed yet, which circus does
 * before it loads any module.
 */
export function makeJestGlobals(jest: unknown): Record<string, unknown> {
  const globals = globalThis as Record<string, unknown>;
  const namespace: Record<string, unknown> = { jest };
  for (const name of FRAMEWORK_GLOBALS) {
    if (globals[name] === undefined) {
      throw new Error(`fabr jest runner: '@jest/globals' cannot serve '${name}' — the framework's globals are not installed yet`);
    }
    namespace[name] = globals[name];
  }
  return namespace;
}

/** Describe a thrown value, which need not be an Error: an Error by its stack
 * (else its message), anything else as `Non-Error thrown: <inspected>`. */
export function describeThrown(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : `Non-Error thrown: ${inspect(err)}`;
}

if (require.main === module) {
  process.on("message", (request: IChildRequest) => {
    runTestFile(request)
      .catch((err: unknown): IChildResult => ({ testFile: request.testFile, results: [], execError: describeThrown(err) }))
      /* End the process once the result is sent, whatever the tests left
       * running. Exit from `process.send`'s callback: exiting sooner truncates
       * a result larger than the pipe buffer. */
      .then(result => {
        if (process.send === undefined) {
          process.exit(1);
        }
        process.send(result, undefined, undefined, () => endAfterReport(0));
      });
  });
}
