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

it("fails where a listener throws inside a promise callback", async () => {
  const target = document.createElement("div");
  target.addEventListener("click", () => { Promise.resolve().then(() => { throw new Error("async listener threw"); }); });
  target.dispatchEvent(new Event("click"));
  await new Promise(resolve => setTimeout(resolve, 20));
});

it("fails where reportError is called", () => {
  if (typeof reportError === "function") reportError(new Error("reported"));
  probe("errors2.reportError", typeof reportError);
});

it("fails where an element's onclick throws", () => {
  const el = document.createElement("button");
  el.onclick = () => { throw new Error("onclick threw"); };
  el.click();
});

it("passes where an error event is dispatched without an error", () => {
  window.dispatchEvent(new ErrorEvent("error", { message: "no error object" }));
});

it("logs from console in a test", () => {
  const spy = jest.spyOn(console, "log").mockImplementation(() => {});
  console.log("hello");
  probe("errors2.console", spy.mock.calls);
  spy.mockRestore();
});
