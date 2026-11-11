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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  answerWithGlobal,
  environmentFor,
  hideNodeSchedulers,
  inheritedMethods,
  packageRootOf,
  withNodeSchedulers,
} from "./Environment";

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

describe("answerWithGlobal", () => {
  const window = {};
  const globals = {};
  /** An event class whose `view` getter answers `value`, given answerWithGlobal. */
  const eventAnswering = (value: unknown): { view: unknown } => {
    class Event {
      get view(): unknown {
        return value;
      }
    }
    answerWithGlobal(Event.prototype, "view", window, globals);
    return new Event();
  };

  it("answers the global object where the getter would answer jsdom's window", () => {
    expect(eventAnswering(window).view).to.equal(globals);
  });

  it("leaves any other answer as it is", () => {
    const other = {};
    expect(eventAnswering(other).view).to.equal(other);
  });
});

describe("environmentFor", () => {
  it("is the invocation's environment for a file with no pragma", () => {
    expect(environmentFor({}, "jsdom")).to.deep.equal({ env: "jsdom", options: {} });
    expect(environmentFor({ other: "x" }, "node")).to.deep.equal({ env: "node", options: {} });
  });

  it("takes the file's pragma over the invocation's environment", () => {
    expect(environmentFor({ "jest-environment": "node" }, "jsdom").env).to.equal("node");
    expect(environmentFor({ "jest-environment": "jsdom" }, "node").env).to.equal("jsdom");
  });

  it("accepts jest's package names for the two environments", () => {
    expect(environmentFor({ "jest-environment": "jest-environment-jsdom" }, "node").env).to.equal("jsdom");
    expect(environmentFor({ "jest-environment": "jest-environment-node" }, "jsdom").env).to.equal("node");
  });

  it("rejects a pragma written twice, as jest does", () => {
    expect(() => environmentFor({ "jest-environment": ["node", "jsdom"] }, "node")).to.throw(
      TypeError,
      'You can only define a single test environment through docblocks, got "node, jsdom"'
    );
  });

  it("rejects an environment this runner does not provide", () => {
    expect(() => environmentFor({ "jest-environment": "./my-environment.js" }, "node")).to.throw(
      /Unsupported test environment '\.\/my-environment\.js'/
    );
  });

  it("parses the environment options, with or without an environment pragma", () => {
    const options = '{"url": "https://example.test/"}';
    expect(environmentFor({ "jest-environment-options": options }, "jsdom")).to.deep.equal({
      env: "jsdom",
      options: { url: "https://example.test/" },
    });
    expect(environmentFor({ "jest-environment": "jsdom", "jest-environment-options": options }, "node").options).to.deep.equal({
      url: "https://example.test/",
    });
  });

  it("ignores environment options written twice, and fails on ones that are not JSON", () => {
    expect(environmentFor({ "jest-environment-options": ["{}", "{}"] }, "node").options).to.deep.equal({});
    expect(() => environmentFor({ "jest-environment-options": "{url:" }, "node")).to.throw(SyntaxError);
  });
});

describe("hideNodeSchedulers", () => {
  it("removes node's scheduling globals that the window lacks, as jest's jsdom environment has none", () => {
    const globals: Record<string, unknown> = {
      setImmediate() {},
      clearImmediate() {},
      MessageChannel() {},
      MessagePort() {},
      setTimeout() {},
    };
    hideNodeSchedulers(globals, {});
    expect(Object.keys(globals)).to.deep.equal(["setTimeout"]);
  });

  it("keeps one the window provides", () => {
    const own = (): void => {};
    const globals: Record<string, unknown> = { MessageChannel: own, setImmediate() {} };
    hideNodeSchedulers(globals, { MessageChannel: own });
    expect(globals).to.deep.equal({ MessageChannel: own });
  });
});

describe("withNodeSchedulers", () => {
  const key = Symbol.for("fabr.jest.nodeSchedulers");
  const scheduled = (): void => {};
  const cleared = (): void => {};

  function load(source: string): Record<string, unknown> {
    const exports: Record<string, unknown> = {};
    Object.defineProperty(globalThis, key, { value: [scheduled, cleared], configurable: true });
    try {
      new Function("exports", withNodeSchedulers(source)).call(exports, exports);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[key];
    }
    return exports;
  }

  it("binds the module's setImmediate and clearImmediate to the functions kept for it", () => {
    const exports = load("exports.set = setImmediate; exports.clear = clearImmediate;");
    expect(exports.set).to.equal(scheduled);
    expect(exports.clear).to.equal(cleared);
  });

  it("keeps the module strict, its `this`, and its line numbers", () => {
    const source = '"use strict";\nexports.strict = (function () { return this; })() === undefined;\nexports.self = this;\n';
    const exports = load(source);
    expect(exports.strict).to.equal(true);
    expect(exports.self).to.equal(exports);
    expect(withNodeSchedulers(source).split("\n").length).to.equal(source.split("\n").length + 1);
    expect(withNodeSchedulers(source).split("\n")[1]).to.equal(source.split("\n")[1]);
  });

  it("turns a leading hashbang into a comment of the same line", () => {
    expect(withNodeSchedulers("#!/usr/bin/env node\nexports.x = 1;").split("\n")[0]).to.contain("///usr/bin/env node");
  });
});

describe("packageRootOf", () => {
  it("finds the package of a file under a PnP virtual location, reading its manifest physically", () => {
    const pool = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-env-")));
    try {
      fs.mkdirSync(path.join(pool, "jsdom", "lib"), { recursive: true });
      fs.writeFileSync(path.join(pool, "jsdom", "package.json"), JSON.stringify({ name: "jsdom" }));
      const virtual = path.join(pool, "__virtual__", "abc123", "0", "jsdom");
      expect(packageRootOf(path.join(virtual, "lib", "api.js"), "jsdom")).to.equal(virtual);
    } finally {
      fs.rmSync(pool, { recursive: true, force: true });
    }
  });
});
