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

const { probe } = require("./lib/probe");

it("fails where an event listener throws", () => {
  const target = document.createElement("div");
  target.addEventListener("click", () => { throw new Error("listener threw"); });
  target.dispatchEvent(new Event("click"));
});

it("does not fail where the test listens for error events itself", () => {
  const seen = [];
  const onError = event => { seen.push(event.message); event.preventDefault(); };
  window.addEventListener("error", onError);
  const target = document.createElement("div");
  target.addEventListener("click", () => { throw new Error("listener threw, handled"); });
  target.dispatchEvent(new Event("click"));
  window.removeEventListener("error", onError);
  probe("errors.listened", seen);
});

it("fails where a timer callback throws during the test", () =>
  new Promise(resolve => { setTimeout(() => { throw new Error("timer threw"); }, 0); setTimeout(resolve, 50); }));

it("passes an unhandled rejection during the test", () =>
  new Promise(resolve => { Promise.reject(new Error("unhandled")); setTimeout(resolve, 50); }));

it("reports jsdom's not-implemented features to console.error", () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  window.scrollTo(0, 0);
  window.alert("x");
  probe("errors.not-implemented", spy.mock.calls.map(call => String(call[0] && (call[0].message || call[0])).split("\n")[0]));
  spy.mockRestore();
});

it("routes window.onerror", () => {
  const seen = [];
  window.onerror = message => { seen.push(String(message)); return true; };
  const target = document.createElement("div");
  target.addEventListener("click", () => { throw new Error("to onerror"); });
  target.dispatchEvent(new Event("click"));
  window.onerror = null;
  probe("errors.onerror", seen);
});

it("keeps a long stack", () => {
  const deep = n => (n === 0 ? new Error("deep").stack : deep(n - 1));
  probe("errors.stack", { limit: Error.stackTraceLimit, frames: deep(50).split("\n").length > 20 });
});

it("calls process.exit", () => {
  probe("errors.exit-type", typeof process.exit);
});
