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

/*
 * Surface parity of the `jest` object — the drift detector for the jest
 * compatibility layer (jestRunner/JestObject.ts).
 *
 * This file is DUAL-RUN, and that is the whole device: under `yarn jest` the
 * `jest` global is REAL jest, so the member list below is audited against
 * ground truth; under `fabr test` (JS_TEST_RUNNER = the jest flavour) the same
 * assertions run against fabr's object. Neither side can drift silently: a
 * member real jest drops or renames fails the jest side when the devchain
 * pin moves, and a member the layer loses fails the fabr side. The list is
 * the intersection of the SUPPORTED majors (29 and 30) — version-specific
 * members (`advanceTimersToNextFrame`, `genMockFromModule`) are deliberately
 * absent, since their presence legitimately differs by release.
 *
 * Under a non-jest runner there is no `jest` global and parity is vacuous —
 * one placeholder test registers so the file never reads as "registered
 * nothing" (which the jest flavour treats as a failure).
 */

import { expect } from "chai";

/** jest-object members every supported jest provides, and so fabr must. */
const JEST_SURFACE = [
  /* module registry */
  "mock",
  "doMock",
  "unmock",
  "dontMock",
  "deepUnmock",
  "setMock",
  "requireActual",
  "requireMock",
  "createMockFromModule",
  "resetModules",
  "isolateModules",
  "isolateModulesAsync",
  "enableAutomock",
  "disableAutomock",
  "autoMockOn",
  "autoMockOff",
  /* mock functions and spies (adopted from jest-mock) */
  "fn",
  "spyOn",
  "mocked",
  "replaceProperty",
  "clearAllMocks",
  "resetAllMocks",
  "restoreAllMocks",
  /* fake timers (adopted from @jest/fake-timers) */
  "useFakeTimers",
  "useRealTimers",
  "runAllTimers",
  "runAllTimersAsync",
  "runAllTicks",
  "runOnlyPendingTimers",
  "runOnlyPendingTimersAsync",
  "advanceTimersByTime",
  "advanceTimersByTimeAsync",
  "advanceTimersToNextTimer",
  "advanceTimersToNextTimerAsync",
  "clearAllTimers",
  "getTimerCount",
  "getRealSystemTime",
  "setSystemTime",
  "now",
  /* the rest */
  "setTimeout",
  "retryTimes",
  "getSeed",
  "isEnvironmentTornDown",
];

if (typeof jest === "undefined") {
  describe("jest object parity", () => {
    it("is vacuous under a runner that provides no jest object", () => {});
  });
} else {
  const jestObject = jest as unknown as Record<string, unknown>;

  describe("jest object parity", () => {
    it("provides every member of the supported jest surface", () => {
      const missing = JEST_SURFACE.filter(name => typeof jestObject[name] !== "function");
      expect(missing, `missing jest members: ${missing.join(", ")}`).to.deep.equal([]);
    });

    it("chains the registry operations, returning the jest object", () => {
      /* A real, never-mocked module: dontMock is a no-op on both sides (only
       * the chaining contract is observed), and the name must RESOLVE — real
       * jest resolves it eagerly and throws on a module that does not exist. */
      expect(jest.dontMock("chai")).to.equal(jest);
      expect(jest.setTimeout(120_000)).to.equal(jest);
    });

    it("reports a numeric seed", () => {
      expect(jest.getSeed()).to.be.a("number");
    });

    it("is not torn down while a test is running", () => {
      expect(jest.isEnvironmentTornDown()).to.equal(false);
    });
  });

  /* Last in the file: retryTimes applies to every test that RUNS after it is
   * set (the count is read per test, before the attempt), so it is set in the
   * describe body — the documented usage — and reset after. End-to-end proof
   * that the retry machinery (circus's, on both sides) actually retries under
   * this layer. */
  describe("jest.retryTimes", () => {
    jest.retryTimes(2);
    let attempts = 0;

    it("retries a test that fails its first attempt", () => {
      attempts++;
      if (attempts < 2) {
        throw new Error(`attempt ${attempts} fails on purpose`);
      }
      expect(attempts).to.equal(2);
    });

    afterAll(() => {
      jest.retryTimes(0);
    });
  });
}
