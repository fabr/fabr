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
 * The `jest-runtime` and environment objects jest-circus's adapter is handed:
 * the eleven runtime methods and three environment members it calls, backed by
 * node's own module loader and fabr's mock registry. A circus that calls
 * anything else fails with a TypeError on the first test.
 */

import { MockRegistry } from "./Registry";

/** The slice of jest-mock's ModuleMocker the facade forwards. */
export interface IMockerControls {
  clearAllMocks(): void;
  resetAllMocks(): void;
  restoreAllMocks(): void;
}

/**
 * The environment circus is handed. `global` is the process's own global object,
 * where Environment.ts installs a DOM. `fakeTimers`/`fakeTimersModern` are read
 * only under `fakeTimers.enableGlobally`, which the config never sets.
 */
export interface IEnvironmentFacade {
  global: typeof globalThis;
  fakeTimers: null;
  fakeTimersModern: null;
}

export function makeEnvironmentFacade(): IEnvironmentFacade {
  return { global: globalThis, fakeTimers: null, fakeTimersModern: null };
}

/**
 * Make the runtime facade for one test process. Modules load through node's
 * `require`, and so through the registry, which serves a mocked specifier its
 * mock.
 */
export function makeRuntimeFacade(registry: MockRegistry, mocker: IMockerControls): Record<string, unknown> {
  return {
    /* Circus's own initializer, an ordinary module of the runner's install. */
    requireInternalModule: (request: string) => require(request),
    /* Setup files and the test file, through the registry's `Module._load`
     * wrap. */
    requireModule: (request: string) => require(request),
    /* The globals circus made (describe/it/hooks/expect); the `jest` object is
     * not among them (JestObject.ts makes it). */
    setGlobalsForRuntime: (globals: Record<string, unknown>) => Object.assign(globalThis, globals),

    /* The config-driven per-test resets (`resetModules`, `clearMocks`, …). */
    resetModules: () => registry.resetModules(),
    clearAllMocks: () => mocker.clearAllMocks(),
    resetAllMocks: () => mocker.resetAllMocks(),
    restoreAllMocks: () => mocker.restoreAllMocks(),

    /* Always false: tests are compiled to CommonJS, and an ES module dependency
     * loads through node's `require(esm)`. */
    unstable_shouldLoadAsEsm: () => false,
    unstable_importModule: (request: string) => import(request),

    /* No-ops: in jest-runtime these only record the runtime's state. */
    enterTestCode: () => undefined,
    leaveTestCode: () => undefined,
  };
}
