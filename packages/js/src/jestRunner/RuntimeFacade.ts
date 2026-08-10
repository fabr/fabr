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
 * What jest-circus thinks it is talking to.
 *
 * Circus's adapter is written against `jest-runtime` — but it only ever calls
 * **eleven methods** on it, and needs **four members** of the environment. This
 * module is those, backed by node's real module system and fabr's own mock
 * registry. That substitution is the whole hybrid: circus gets the framework it
 * expects, while modules load through node, so `require(esm)` keeps working and
 * every capability node gains arrives for free.
 *
 * The surface is measured, not guessed, and it is stable: identical across jest
 * 27.5.1 → 29.7.0, gaining only `enterTestCode`/`leaveTestCode` in 30 — which
 * are pure bookkeeping in the real Runtime (`this.state = 'inTest'`) and so are
 * honestly no-ops here. Nothing has been removed across four majors.
 *
 * If a future circus calls something absent here, it fails loudly and
 * immediately — a TypeError on the first test — rather than degrading quietly.
 */

import { MockRegistry } from "./Registry";

/** The slice of jest-mock's ModuleMocker the facade forwards. */
export interface IMockerControls {
  clearAllMocks(): void;
  resetAllMocks(): void;
  restoreAllMocks(): void;
}

/**
 * The environment circus is handed. There is no vm context — the process IS the
 * environment — so `global` is simply the real global object, which is what
 * makes a DOM installed by Environment.ts visible to circus and to the tests
 * alike. `fakeTimers`/`fakeTimersModern` are touched only when a project sets
 * `fakeTimers.enableGlobally`, which fabr does not.
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
 * Build the runtime facade for one test process. `load` is how a module is
 * brought in — node's `require`, through the registry's seams, so a mocked
 * specifier is served and everything else loads normally.
 */
export function makeRuntimeFacade(registry: MockRegistry, mocker: IMockerControls): Record<string, unknown> {
  return {
    /* Circus loads its own initializer through the runtime. Ours is node's
     * loader, which is fine: it is an ordinary module in the runner's mount. */
    requireInternalModule: (request: string) => require(request),
    /* Setup files and the test file itself. Goes through node — and therefore
     * through the registry's `Module._load` seam. */
    requireModule: (request: string) => require(request),
    /* Circus hands over the globals it assembled (describe/it/hooks/expect).
     * Note it does NOT build the `jest` object — that stays fabr's, since it is
     * the interface to the registry. */
    setGlobalsForRuntime: (globals: Record<string, unknown>) => Object.assign(globalThis, globals),

    /* The config-driven per-test resets (`resetModules`, `clearMocks`, …). */
    resetModules: () => registry.resetModules(),
    clearAllMocks: () => mocker.clearAllMocks(),
    resetAllMocks: () => mocker.resetAllMocks(),
    restoreAllMocks: () => mocker.restoreAllMocks(),

    /* Always false: fabr compiles tests to CommonJS, and an ESM-only dependency
     * is reached through node's `require(esm)` rather than jest's ESM path —
     * which is precisely the capability jest's own vm loader lacks. */
    unstable_shouldLoadAsEsm: () => false,
    unstable_importModule: (request: string) => import(request),

    /* Bookkeeping only in the real Runtime. */
    enterTestCode: () => undefined,
    leaveTestCode: () => undefined,
  };
}
