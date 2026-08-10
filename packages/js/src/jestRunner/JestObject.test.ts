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

import { expect } from "chai";
import { IFakeTimers, IJestEnvironment, IMocker, makeJestObject } from "./JestObject";
import { MockRegistry } from "./Registry";

/**
 * Every member of jest's own `Jest` interface (`@jest/environment`'s
 * `index.d.ts`) at the top of the supported range.
 *
 * The interface grows: measured across the majors it gained 9 members in 29 and
 * 4 in 30, and lost exactly one in three majors (`genMockFromModule`, a
 * deprecated alias, dropped in 30 — still provided, since 29 is supported). So
 * this list is expected to need updating when the `JEST` default moves, and
 * this test failing IS that reminder.
 */
const JEST_30_SURFACE = [
  "advanceTimersByTime", "advanceTimersByTimeAsync", "advanceTimersToNextFrame", "advanceTimersToNextTimer",
  "advanceTimersToNextTimerAsync", "autoMockOff", "autoMockOn", "clearAllMocks", "clearAllTimers",
  "createMockFromModule", "deepUnmock", "disableAutomock", "doMock", "dontMock", "enableAutomock", "fn",
  "getRealSystemTime", "getSeed", "getTimerCount", "isEnvironmentTornDown", "isMockFunction", "isolateModules",
  "isolateModulesAsync", "mock", "mocked", "now", "onGenerateMock", "replaceProperty", "requireActual",
  "requireMock", "resetAllMocks", "resetModules", "restoreAllMocks", "retryTimes", "runAllImmediates",
  "runAllTicks", "runAllTimers", "runAllTimersAsync", "runOnlyPendingTimers", "runOnlyPendingTimersAsync",
  "setMock", "setSystemTime", "setTimeout", "setTimerTickMode", "spyOn", "unmock", "unstable_mockModule",
  "unstable_unmockModule", "useFakeTimers", "useRealTimers",
];

/* The public methods the backing libraries really have, per release — the input
 * the object is assembled from. `_`-prefixed internals are omitted (numerous
 * and uninteresting); the two members jest 30 added to the timers are what makes
 * 29 and 30 differ. */
const MOCKER_METHODS = ["generateFromMetadata", "getMetadata", "isMockFunction", "fn", "spyOn", "replaceProperty",
  "clearAllMocks", "resetAllMocks", "restoreAllMocks", "mocked"];
const MOCKER_METHODS_30 = [...MOCKER_METHODS, "clearMocksOnScope"];
const TIMER_METHODS = ["clearAllTimers", "dispose", "runAllTimers", "runAllTimersAsync", "runOnlyPendingTimers",
  "runOnlyPendingTimersAsync", "advanceTimersToNextTimer", "advanceTimersToNextTimerAsync", "advanceTimersByTime",
  "advanceTimersByTimeAsync", "runAllTicks", "useRealTimers", "useFakeTimers", "reset", "setSystemTime",
  "getRealSystemTime", "now", "getTimerCount"];
const TIMER_METHODS_30 = [...TIMER_METHODS, "advanceTimersToNextFrame", "setTimerTickMode"];

/** Members jest 30 has that jest 29's libraries cannot provide — and which real
 * jest 29 equally does not have. */
const ADDED_IN_30 = ["advanceTimersToNextFrame", "setTimerTickMode"];

/** An instance whose PROTOTYPE carries `methods` — what `adopt` walks. Each
 * records the call it received, so binding and argument pass-through can be
 * checked. */
function library(methods: string[], calls: string[]): Record<string, unknown> {
  class Library {}
  for (const name of methods) {
    (Library.prototype as Record<string, unknown>)[name] = function (...args: unknown[]): unknown {
      calls.push(`${name}(${args.map(arg => JSON.stringify(arg)).join(",")})`);
      return undefined;
    };
  }
  /* An internal, to prove it is not adopted. */
  (Library.prototype as Record<string, unknown>)._internal = () => undefined;
  return new Library() as Record<string, unknown>;
}

function jestObject(
  mockerMethods = MOCKER_METHODS_30,
  timerMethods = TIMER_METHODS_30,
  calls: string[] = []
): Record<string, unknown> {
  const env: IJestEnvironment = {
    registry: new MockRegistry(process.cwd(), { getMetadata: () => ({}), generateFromMetadata: () => ({}) }),
    mocker: library(mockerMethods, calls) as unknown as IMocker,
    timers: library(timerMethods, calls) as unknown as IFakeTimers,
    seed: 1234,
  };
  return makeJestObject(env, undefined);
}

describe("the jest global", () => {
  it("provides every member of jest's own interface", () => {
    const jest = jestObject();
    const missing = JEST_30_SURFACE.filter(name => typeof jest[name] !== "function");
    expect(missing, `not provided by the layer: ${missing.join(", ")}`).to.deep.equal([]);
  });

  it("claims nothing jest does not have, bar the alias 29 still declares", () => {
    const surface = new Set(JEST_30_SURFACE);
    expect(Object.keys(jestObject()).filter(name => !surface.has(name))).to.deep.equal(["genMockFromModule"]);
  });

  it("adopts the libraries' methods rather than reimplementing them", () => {
    /* Bound to their own library and passed their arguments through — the whole
     * point of copying instead of hand-forwarding. */
    const calls: string[] = [];
    const jest = jestObject(MOCKER_METHODS_30, TIMER_METHODS_30, calls);
    (jest.advanceTimersByTime as (ms: number) => void)(250);
    (jest.spyOn as (o: unknown, m: unknown) => void)("obj", "method");
    expect(calls).to.deep.equal(['advanceTimersByTime(250)', 'spyOn("obj","method")']);
  });

  it("does not adopt internals or non-API members of the libraries", () => {
    const jest = jestObject();
    /* `_`-prefixed, fabr's own automock machinery, and lifecycle jest never exposes. */
    for (const name of ["_internal", "getMetadata", "generateFromMetadata", "clearMocksOnScope", "dispose", "reset"]) {
      expect(jest[name], name).to.equal(undefined);
    }
  });

  it("reproduces the pinned jest's own version differences rather than modelling them", () => {
    /* Against jest 29's libraries the two members it never had are simply
     * absent — exactly what a test sees under real jest 29. Nothing here has to
     * know which release added what. */
    const on29 = jestObject(MOCKER_METHODS, TIMER_METHODS);
    expect(ADDED_IN_30.filter(name => on29[name] !== undefined)).to.deep.equal([]);
    const on30 = jestObject();
    expect(ADDED_IN_30.filter(name => typeof on30[name] !== "function")).to.deep.equal([]);
  });

  it("overrides the adopted useFakeTimers to keep the runner's reporter alive", () => {
    const calls: string[] = [];
    const jest = jestObject(MOCKER_METHODS_30, TIMER_METHODS_30, calls);
    (jest.useFakeTimers as () => void)();
    expect(calls[0]).to.contain("setImmediate");
    expect(calls[0]).to.contain("nextTick");
  });

  it("makes an unimplemented member throw a fabr message, not 'is not a function'", () => {
    for (const name of ["onGenerateMock", "unstable_mockModule", "runAllImmediates"]) {
      expect(() => (jestObject()[name] as () => void)(), name).to.throw(
        /not supported by fabr's jest compatibility layer/
      );
    }
  });

  it("returns itself from a module operation, for chaining", () => {
    const jest = jestObject();
    expect((jest.disableAutomock as () => unknown)()).to.equal(jest);
  });
});
