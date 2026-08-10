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
import { inheritedMethods } from "./Environment";

/* installJsdom itself needs a real jsdom, which fabr's own tests do not carry
 * (it comes from the TARGET's test_deps); what is testable here is the part
 * that decides WHICH of a window's members need binding, and that is the part
 * a jsdom upgrade can silently change. */
describe("inheritedMethods", () => {
  /** A stand-in for jsdom's window: some members on the instance (closures over
   * their window, needing no binding) and some on the prototype chain
   * (EventTarget's, which read the `this` they are called on). */
  function windowLike(): Record<string, unknown> {
    const eventTarget = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const windowProto = Object.create(eventTarget) as Record<string, unknown>;
    windowProto.matchMedia = () => undefined;
    const window = Object.create(windowProto) as Record<string, unknown>;
    window.document = {};
    window.getComputedStyle = () => undefined;
    return window;
  }

  it("finds the members that come from a prototype, at any depth", () => {
    expect(inheritedMethods(windowLike() as never)).to.have.members([
      "addEventListener",
      "removeEventListener",
      "dispatchEvent",
      "matchMedia",
    ]);
  });

  it("leaves the window's own members alone — they are closures already bound", () => {
    const found = inheritedMethods(windowLike() as never);
    expect(found).to.not.contain("getComputedStyle");
    expect(found).to.not.contain("document");
  });

  it("stops at Object.prototype and skips constructor", () => {
    const found = inheritedMethods(windowLike() as never);
    expect(found).to.not.contain("hasOwnProperty");
    expect(found).to.not.contain("constructor");
  });

  it("reports a name shadowed by an own member only as the own one", () => {
    /* An own property wins the lookup, so binding the prototype's version would
     * install the wrong function over it. */
    const window = windowLike();
    window.matchMedia = () => undefined;
    expect(inheritedMethods(window as never)).to.not.contain("matchMedia");
  });
});
