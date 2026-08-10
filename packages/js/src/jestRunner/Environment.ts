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
 * Test environments. `node` is free — the process *is* the environment, which
 * is the whole benefit of process-per-file over a simulated sandbox. `jsdom`
 * installs a DOM into that process's globals.
 *
 * `jest-environment-jsdom` is deliberately not used: its job is to construct a
 * global object for a vm context, and there is no vm context here. What it does
 * that matters is copied instead — in particular the *shadowing* of node's own
 * overlapping globals, which is load-bearing rather than cosmetic (see below).
 *
 * jsdom comes from the TARGET's `test_deps`, not from the runner's mount: the
 * DOM implementation and its version are the project's choice, exactly like any
 * other dependency.
 */

import { userModule } from "./Tools";

interface IJsdomWindow {
  document: unknown;
  location: unknown;
  [key: string]: unknown;
}

interface IJsdom {
  window: IJsdomWindow;
}

interface IJsdomModule {
  JSDOM: new (html: string, options: unknown) => IJsdom;
}

/**
 * Globals node provides that jsdom ALSO provides, which must be replaced by
 * jsdom's rather than left alone.
 *
 * Leaving node's in place looks harmless and is not: a test that constructs a
 * node-realm `Event` and dispatches it at a jsdom `EventTarget` hits a realm
 * mismatch and fails in a way that has nothing to do with the test. The list is
 * jest's own (`@jest/environment-jsdom-abstract`'s curated overrides) rather
 * than one discovered failure by failure — plus `navigator` and `WebSocket`,
 * which node itself now ships (21 and 22.4 respectively) and which a
 * browser-targeted test must see as jsdom's: its `navigator` carries the DOM's
 * userAgent (and is what jsdom's own APIs consult), and a node-realm WebSocket
 * is the same realm mismatch as a node-realm Event.
 */
const SHADOWED_NODE_GLOBALS = new Set([
  "AbortController",
  "AbortSignal",
  "Blob",
  "BroadcastChannel",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "CustomEvent",
  "DOMException",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Headers",
  "MessageChannel",
  "MessageEvent",
  "MessagePort",
  "navigator",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextDecoderStream",
  "TextEncoder",
  "TextEncoderStream",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WebSocket",
  "WritableStream",
]);

/** Globals that must stay node's: replacing them would break the runner itself
 * or the module system the tests load through. */
const KEEP_NODE = new Set([
  "global",
  "globalThis",
  "process",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "Buffer",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
]);

/**
 * `window`'s self-references. In a top-level browsing context every one of them
 * IS the window, and since the global object is the window here too (see
 * {@link installJsdom}) they all name the global.
 */
const SELF_REFERENCES = ["window", "self", "parent", "top", "frames"];

/**
 * The window methods that live on a PROTOTYPE rather than on the window
 * instance, and so must be bound: jsdom's own properties are closures over
 * their window, but an inherited method reads the `this` it was called on —
 * which, called as a bare global, is the global object and not the window.
 * Discovered by walking the chain, so a jsdom that inherits more keeps working.
 */
export function inheritedMethods(window: IJsdomWindow): string[] {
  const own = new Set(Object.getOwnPropertyNames(window));
  const names: string[] = [];
  for (let proto = Object.getPrototypeOf(window); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== "constructor" && !own.has(key) && !names.includes(key)) {
        names.push(key);
      }
    }
  }
  return names;
}

/**
 * Install a DOM into this process's globals. Everything jsdom's window exposes
 * becomes a global (that is what "a browser environment" means to the code
 * under test).
 *
 * **`window` is then made the global object itself**, not jsdom's window —
 * which is the single most load-bearing line here. Under jest the two are
 * literally one object (its environment hands the vm context jsdom's window as
 * its global), so a suite may set `window.getComputedStyle = jest.fn()` in a
 * `beforeEach` and have the code under test see it through the bare global;
 * with two distinct objects that assignment would silently go nowhere, and the
 * test would fail somewhere else entirely. The same identity is what makes
 * `Object.defineProperty(window, …)` — the standard way to stub `devicePixelRatio`,
 * `matchMedia`, `location` — work, and what makes a `global.X = …` in a setup
 * file visible as `window.X`.
 *
 * jsdom's own window object stays behind it: the copied properties are its
 * closures, and the inherited methods are bound to it, so everything still
 * operates on the one real DOM.
 */
export function installJsdom(): void {
  /* The runner has already checked that jsdom is installed (see
   * requireEnvironment), where the failure can be reported properly. */
  const jsdom = userModule("jsdom") as IJsdomModule | undefined;
  if (jsdom?.JSDOM === undefined) {
    throw new Error("'jsdom' is not installed in this test environment");
  }
  const dom = new jsdom.JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  const window = dom.window;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (KEEP_NODE.has(key)) {
      continue;
    }
    if (globals[key] === undefined || SHADOWED_NODE_GLOBALS.has(key)) {
      define(globals, key, window, key);
    }
  }
  for (const key of inheritedMethods(window)) {
    const method = window[key];
    if (typeof method === "function") {
      globals[key] = method.bind(window);
    }
  }
  /* Defined rather than assigned: the copy above will have installed jsdom's
   * own self-referential accessors, which are getters. */
  for (const name of SELF_REFERENCES) {
    Object.defineProperty(globals, name, { value: globals, writable: true, configurable: true });
  }
  /* `document.defaultView` is the same self-reference by another route, and
   * code that reaches the window through its document (testing-library does)
   * must land on the same object as `window` or the identity above is only half
   * true. jsdom's internals take their window from their own state, not from
   * this accessor, so nothing inside it is disturbed. */
  Object.defineProperty(window.document as object, "defaultView", { get: () => globals, configurable: true });
  patchLocation(window);
}

/** Copy one of the window's properties onto the global object, preserving
 * accessors (a getter that reads window state must keep reading it, not be
 * snapshotted to its current value). */
function define(globals: Record<string, unknown>, name: string, window: IJsdomWindow, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (descriptor === undefined) {
    return;
  }
  try {
    Object.defineProperty(globals, name, { ...descriptor, configurable: true });
  } catch {
    /* A non-configurable global of node's own (rare) simply stays node's. */
  }
}

/**
 * Make `location` replaceable — the thing jsdom-based suites routinely need
 * (stubbing the URL, asserting on a redirect).
 *
 * On jsdom's own window it is not: jsdom implements it as WebIDL
 * `[Unforgeable]`, i.e. non-configurable, so `Object.defineProperty(window,
 * "location", …)` throws — under jest too, which is why such suites need a
 * patched environment there. Here the global object is a real node global and
 * not jsdom's window, so its `location` is an ordinary configurable property
 * that a test can redefine; jsdom's window keeps its own, unforgeable, and its
 * internals go on reading that one.
 */
function patchLocation(window: IJsdomWindow): void {
  Object.defineProperty(globalThis, "location", { value: window.location, writable: true, configurable: true });
}
