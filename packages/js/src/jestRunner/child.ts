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
 * One test file, in its own process: assemble the jest environment, then hand
 * jest-circus the facades and let it run the file.
 *
 * A process per file is the isolation `jest.mock` actually requires (it is
 * file-scoped by construction), and here it is the real thing rather than a
 * simulated one — `process.env`, native state, leaked handles and heap are all
 * genuinely separate, which a vm context cannot give you.
 *
 * Invoked by the parent (runner.ts) as a forked child; the result goes back
 * over the IPC channel. Anything that kills the process before that — a module
 * that fails to load, a broken preload — leaves no message, and the parent
 * reports the file as failed using the stderr it captured.
 */

import { inspect } from "node:util";
import { installJsdom } from "./Environment";
import { installHoist } from "./Hoist";
import { IFakeTimers, IMocker, makeJestObject } from "./JestObject";
import { ILoaderModule, installSeams, MockRegistry } from "./Registry";
import { IMockerControls, makeEnvironmentFacade, makeRuntimeFacade } from "./RuntimeFacade";
import { jestLibrary, requireEnvironment } from "./Tools";
import { makeJestConfig } from "./Config";
import { formatFailures, IFormattableResult } from "./Failures";

/** What the parent tells a child to do. */
export interface IChildRequest {
  testFile: string;
  root: string;
  env: string;
  updateSnapshots: boolean;
  timeoutMs: number;
  setup: string[];
}

/** One test's outcome, as circus reports it — narrowed to what the report needs.
 * `failureMessages` are FORMATTED here (see Failures.ts) rather than in the
 * parent: presenting them needs the run's jest config, which only exists in the
 * child. */
export interface IChildTestResult {
  fullName: string;
  status: string;
  duration?: number | null;
  failureMessages: string[];
}

export interface IChildResult {
  testFile: string;
  results: IChildTestResult[];
  /** A failure of the FILE rather than of a test in it (circus could not even
   * get as far as running). */
  execError?: string;
}

/** The two jest libraries this module constructs by name. */
interface IMockerModule {
  ModuleMocker: new (global: unknown) => IMocker & IMockerControls & { getMetadata(c: unknown): unknown; generateFromMetadata(m: unknown): unknown };
}

type CircusResult = IChildTestResult & IFormattableResult;

type TestFramework = (
  globalConfig: unknown,
  projectConfig: unknown,
  environment: unknown,
  runtime: unknown,
  testPath: string,
  sendMessageToJest?: unknown
) => Promise<{ testResults: CircusResult[]; testExecError?: { message?: string } }>;

export async function runTestFile(request: IChildRequest): Promise<IChildResult> {
  requireEnvironment(request.env);
  if (request.env === "jsdom") {
    installJsdom();
  }

  const { globalConfig, projectConfig } = await makeJestConfig(request);

  /* fabr's half: the module registry, the load-time hoist, and the `jest`
   * object — none of which circus provides. */
  const mocker = new (jestLibrary("jest-mock") as IMockerModule).ModuleMocker(globalThis);
  const registry = new MockRegistry(request.root, mocker);
  installSeams(registry);
  installHoist(request.root);

  const timers = new (jestLibrary("@jest/fake-timers") as {
    ModernFakeTimers: new (opts: unknown) => IFakeTimers;
  }).ModernFakeTimers({ global: globalThis, config: { rootDir: request.root, fakeTimers: {} } });
  const env = { registry, mocker, timers, seed: (globalConfig as { seed?: number }).seed };
  /* The plain `jest` global resolves module specifiers against the test file
   * (there is only one of it). A module that wants its OWN resolution base
   * imports from '@jest/globals', which the registry serves per caller — and
   * which is also what the hoisted `jest.mock` calls reach for. Registration
   * and require-time lookup must resolve a specifier from the same base, or
   * the mock silently never applies. */
  const jest = makeJestObject(env, { filename: request.testFile });
  (globalThis as Record<string, unknown>).jest = jest;
  registry.jestGlobalsFor = (caller: ILoaderModule | undefined) => ({
    jest: makeJestObject(env, caller ?? { filename: request.testFile }),
    expect: (globalThis as Record<string, unknown>).expect,
  });

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
    /* A file whose last test leaves fake timers active must not fake the clock
     * (or clearTimeout) for the reporting that follows — circus tears nothing
     * down here (the environment facade owns no fakeTimers), so the run does. */
    timers.dispose();
  }
  return {
    testFile: request.testFile,
    results: (result.testResults ?? []).map(test => ({
      ...test,
      failureMessages: test.failureMessages.length === 0 ? [] : formatFailures(test, projectConfig, globalConfig, request.testFile),
    })),
    execError: result.testExecError?.message,
  };
}

/** A throw need not be an Error: a string or object rejection must still be
 * reported as what it was — an undefined execError would make the parent
 * misread the failure as "this file registered no tests". */
export function describeThrown(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : `Non-Error thrown: ${inspect(err)}`;
}

if (require.main === module) {
  process.on("message", (request: IChildRequest) => {
    runTestFile(request)
      .catch((err: unknown): IChildResult => ({ testFile: request.testFile, results: [], execError: describeThrown(err) }))
      /* The tests are done; anything they leaked must not keep the process
       * alive (the complement of node:test's forceExit). Whatever they SPAWNED
       * is reaped by the host's process-group sweep at the action boundary.
       * `process.send` is asynchronous — exit from its completion callback,
       * never on the next line, or a result larger than the pipe buffer is
       * truncated by the exit and a green file reports as a crash. */
      .then(result => {
        if (process.send === undefined) {
          process.exit(1);
        }
        process.send(result, undefined, undefined, () => process.exit(0));
      });
  });
}
