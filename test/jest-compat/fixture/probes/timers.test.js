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

const { probe, attempt } = require("./lib/probe");
/* Captured at load, before any test fakes timers, as a library does. */
const raf = window.requestAnimationFrame.bind(window);

afterEach(() => jest.useRealTimers());

it("fakes these by default", () => {
  const before = { setTimeout, setInterval, nextTick: process.nextTick, queueMicrotask, raf: globalThis.requestAnimationFrame, now: performance.now, dateNow: Date.now, setImmediate: globalThis.setImmediate, hrtime: process.hrtime };
  jest.useFakeTimers();
  probe("timers.faked", {
    setTimeout: setTimeout !== before.setTimeout, setInterval: setInterval !== before.setInterval,
    nextTick: process.nextTick !== before.nextTick, queueMicrotask: queueMicrotask !== before.queueMicrotask,
    requestAnimationFrame: globalThis.requestAnimationFrame !== before.raf, performanceNow: performance.now !== before.now,
    dateNow: Date.now !== before.dateNow, setImmediate: typeof globalThis.setImmediate, hrtime: process.hrtime !== before.hrtime,
    clockProperty: Object.prototype.hasOwnProperty.call(setTimeout, "clock"), isMockFunction: setTimeout._isMockFunction === true,
  });
});

it("orders a faked nextTick and microtask", () => {
  jest.useFakeTimers();
  const order = [];
  process.nextTick(() => order.push("tick"));
  queueMicrotask(() => order.push("microtask"));
  Promise.resolve().then(() => order.push("promise"));
  order.push("sync");
  const afterSync = [...order];
  jest.runAllTicks();
  probe("timers.ticks", { afterSync, afterRunAllTicks: [...order] });
});

it("runs animation frames under fake timers", () => {
  jest.useFakeTimers();
  const seen = [];
  requestAnimationFrame(t => seen.push(typeof t));
  jest.advanceTimersByTime(16);
  const after16 = seen.length;
  jest.advanceTimersByTime(1);
  probe("timers.raf-fake", { after16, after17: seen.length, timerCount: jest.getTimerCount() });
});

it("requests a frame captured before faking, then goes back to real timers", () => {
  jest.useFakeTimers();
  raf(() => undefined);
  jest.useRealTimers();
});

it("still runs a captured animation frame on real timers", () =>
  new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("no frame")), 1000); raf(() => { clearTimeout(t); resolve(); }); }));

it("sets the system time", () => {
  jest.useFakeTimers({ now: new Date("2020-01-01T00:00:00Z") });
  probe("timers.now", { date: new Date().toISOString(), dateNow: Date.now(), jestNow: jest.now() });
});

it("takes a legacy fake timers config", () => {
  probe("timers.legacy", attempt(() => { jest.useFakeTimers({ legacyFakeTimers: true }); return { isMock: setTimeout._isMockFunction === true, clock: Object.prototype.hasOwnProperty.call(setTimeout, "clock") }; }));
});

it("advances timers automatically", async () => {
  jest.useFakeTimers({ advanceTimers: true });
  const fired = await new Promise(resolve => { setTimeout(() => resolve("fired"), 5); setTimeout(() => resolve("stuck"), 2000).unref?.(); });
  probe("timers.advance", fired);
});

it("counts and clears timers", () => {
  jest.useFakeTimers();
  setTimeout(() => {}, 10); setInterval(() => {}, 10); requestAnimationFrame(() => {});
  const count = jest.getTimerCount();
  jest.clearAllTimers();
  probe("timers.count", { count, cleared: jest.getTimerCount() });
});

it("runs only pending timers and to the last", () => {
  jest.useFakeTimers();
  const log = [];
  setTimeout(() => { log.push("a"); setTimeout(() => log.push("b"), 10); }, 10);
  jest.runOnlyPendingTimers();
  const pending = [...log];
  jest.runAllTimers();
  probe("timers.run", { pending, all: [...log], now: Date.now() - jest.now() });
});

it("fakes legacy timers as mock functions and runs them", () => {
  jest.useFakeTimers({ legacyFakeTimers: true });
  const log = [];
  setTimeout(() => log.push("timeout"), 100);
  const id = setInterval(() => log.push("interval"), 40);
  jest.advanceTimersByTime(100);
  clearInterval(id);
  probe("timers.legacy-run", {
    log, calls: setTimeout.mock.calls.length, delay: setTimeout.mock.calls[0][1], count: jest.getTimerCount(),
    systemTime: (() => { try { jest.setSystemTime(0); return "set"; } catch (e) { return e.constructor.name + ": " + e.message; } })(),
  });
});
