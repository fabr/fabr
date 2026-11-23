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
 * Test environments. `node` is the test process as it is; `jsdom` installs a
 * DOM into the process's globals, as `jest-environment-jsdom` installs one
 * into a vm context's (which is not used). jsdom is loaded from the target's
 * `test_deps`.
 */

import * as fs from "node:fs";
import { Module } from "node:module";
import * as path from "node:path";
import * as vm from "node:vm";
import { readManifest } from "../pnp/PnPResolver";
import { isJsonObject } from "../support/Json";
import { userModule, userModuleFile } from "./Tools";

interface IJsdomWindow {
  document: unknown;
  location: unknown;
  [key: string]: unknown;
}

interface IJsdom {
  window: IJsdomWindow;
}

interface IVirtualConsole {
  /** jsdom 27 and later. */
  forwardTo?(target: Console): void;
  /** jsdom 26 and earlier. */
  sendTo?(target: Console, options: { omitJSDOMErrors: boolean }): void;
  on(event: "jsdomError", listener: (error: Error) => void): void;
}

interface IJsdomModule {
  JSDOM: new (html: string, options: unknown) => IJsdom;
  ResourceLoader: new (options: { userAgent: string }) => unknown;
  VirtualConsole: new () => IVirtualConsole;
}

/** A test file's docblock pragmas, as `jest-docblock` parses them: a pragma
 * written more than once is an array. */
export type DocblockPragmas = Record<string, string | string[]>;

/** The environment one test file runs in. */
export interface IFileEnvironment {
  env: string;
  /** The file's `@jest-environment-options`, if it wrote any. */
  options: Record<string, unknown>;
}

const ENVIRONMENT_PACKAGE_PREFIX = "jest-environment-";

/** Convert the parsed options of an `@jest-environment-options` docblock. */
function environmentOptions(json: unknown): Record<string, unknown> {
  if (!isJsonObject(json)) {
    throw new TypeError(`@jest-environment-options must be a JSON object, got ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Choose the environment a test file runs in: its `@jest-environment` pragma if
 * it has one, else `fallback` (the invocation's `--env`), with its
 * `@jest-environment-options` parsed as JSON.
 *
 * The pragma names `node` or `jsdom`, bare or by jest's package name
 * (`jest-environment-jsdom`). Throws for any other environment, for a pragma
 * written twice (jest's TypeError), and for options that are not a JSON
 * object.
 */
export function environmentFor(pragmas: DocblockPragmas, fallback: string): IFileEnvironment {
  const written = pragmas["jest-environment"];
  if (Array.isArray(written)) {
    throw new TypeError(`You can only define a single test environment through docblocks, got "${written.join(", ")}"`);
  }
  const rawOptions = pragmas["jest-environment-options"];
  /* JSON.parse's own SyntaxError, as jest reports one. */
  const options = typeof rawOptions === "string" ? environmentOptions(JSON.parse(rawOptions)) : {};
  if (!written) {
    return { env: fallback, options };
  }
  const env = written.startsWith(ENVIRONMENT_PACKAGE_PREFIX) ? written.slice(ENVIRONMENT_PACKAGE_PREFIX.length) : written;
  if (env !== "node" && env !== "jsdom") {
    throw new Error(
      `Unsupported test environment '${written}' in a @jest-environment docblock — this runner provides 'node' and 'jsdom', ` +
        "and does not load custom environment modules."
    );
  }
  return { env, options };
}

/**
 * Globals both node and jsdom provide, which are replaced by jsdom's: a
 * node `Event` dispatched at a jsdom `EventTarget`, say, is refused. The list
 * is `@jest/environment-jsdom-abstract`'s, plus `navigator` and `WebSocket`,
 * which node provides from 21 and 22.4.
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
  "performance",
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

/** Globals that stay node's: the runner and the module loader use them. */
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
  "queueMicrotask",
  "structuredClone",
]);

/** The globals jest's jsdom environment adds to the window, which stay node's
 * here: `installCommonGlobals`' and the test's console. */
const JEST_ADDED_GLOBALS = new Set(["global", "globalThis", "process", "Buffer", "console"]);

/** The ECMAScript built-ins, the globals of a fresh context. */
const BUILT_INS = new Set(vm.runInNewContext("Object.getOwnPropertyNames(globalThis)") as string[]);

/**
 * `window`'s self-references, each made to name the global object (see
 * {@link installJsdom}).
 */
const SELF_REFERENCES = ["window", "self", "parent", "top", "frames"];

/**
 * List the window's methods inherited through its prototype chain, which are
 * not shadowed by its own properties. Each reads its `this`, so it must be
 * bound to the window to be called as a bare global.
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
 * Install a DOM into this process's globals, making the global object the
 * window, as under jest (where jsdom's window is the vm context's global): so
 * `window.getComputedStyle = jest.fn()` is seen through the bare global, and
 * `global.X = …` as `window.X`.
 *
 * Each of the window's own properties becomes a global where node has none of
 * that name or it is in {@link SHADOWED_NODE_GLOBALS}, bar
 * {@link KEEP_NODE}'s; accessors are copied as accessors. Node's other
 * globals are removed ({@link hideNodeGlobals}). The inherited methods
 * are bound to jsdom's window, which stays the DOM they act on. `window`,
 * `self`, `parent`, `top`, `frames`, `document.defaultView`, a UI event's
 * `view` and a message event's `source` all answer the global object, and
 * `location` is a writable property of it (see {@link patchLocation}). An
 * error event at the window fails the running test ({@link reportUncaughtErrors}).
 *
 * `options` are jest's `testEnvironmentOptions` for jsdom, applied as
 * `jest-environment-jsdom` applies them: `html` is the document, `userAgent`
 * the resource loader's, and all of them are passed to the `JSDOM` constructor
 * over the defaults. Throws where jsdom is not installed.
 */
export function installJsdom(options: Record<string, unknown> = {}): void {
  compileEnvironmentWithNodeGlobals(userModuleFile("jsdom"));
  /* requireEnvironment has reported a missing jsdom already. */
  const jsdom = userModule("jsdom") as IJsdomModule | undefined;
  if (jsdom?.JSDOM === undefined) {
    throw new Error("'jsdom' is not installed in this test environment");
  }
  const { html, userAgent } = options;
  const dom = new jsdom.JSDOM(typeof html === "string" ? html : "<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
    resources: typeof userAgent === "string" ? new jsdom.ResourceLoader({ userAgent }) : undefined,
    virtualConsole: virtualConsoleOf(jsdom),
    ...options,
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  const window = dom.window;
  runScriptsInTestContext(window);
  for (const key of Object.getOwnPropertyNames(window)) {
    if (KEEP_NODE.has(key)) {
      continue;
    }
    if (globals[key] === undefined || SHADOWED_NODE_GLOBALS.has(key)) {
      define(globals, key, window, key);
    }
  }
  hideNodeGlobals(globals, window);
  /* jsdom's symbol-keyed members (its implementation link among them), so
   * that jsdom takes the global object for a Window: as an event's `view`,
   * say. */
  for (const key of Object.getOwnPropertySymbols(window)) {
    Object.defineProperty(globals, key, { ...Object.getOwnPropertyDescriptor(window, key), configurable: true });
  }
  for (const key of inheritedMethods(window)) {
    const method = window[key];
    if (typeof method === "function") {
      globals[key] = method.bind(window);
    }
  }
  /* Defined, not assigned: the copy above installed jsdom's getters for
   * these. */
  for (const name of SELF_REFERENCES) {
    Object.defineProperty(globals, name, { value: globals, writable: true, configurable: true });
  }
  /* Code that reaches the window through its document (testing-library does)
   * gets the global object too. jsdom's internals do not read this
   * accessor. */
  Object.defineProperty(window.document as object, "defaultView", { get: () => globals, configurable: true });
  /* The other properties through which jsdom hands its window out: a UI
   * event's (mouse, keyboard, focus) and a message event's. */
  const prototypeOf = (name: string): object | undefined => (window[name] as { prototype?: object } | undefined)?.prototype;
  answerWithGlobal(prototypeOf("UIEvent"), "view", window, globals);
  answerWithGlobal(prototypeOf("MessageEvent"), "source", window, globals);
  patchLocation(window);
  reportUncaughtErrors(window, globals);
  shareGlobals(window, globals);
}

/**
 * Make each of jsdom's window and the global object read the other's own
 * properties where it has none of that name, through a fallback at the end of
 * its prototype chain. Under jest the two are one object; here an `on…`
 * attribute's handler runs within jsdom's window, whose `window` is jsdom's
 * own (jsdom makes it unforgeable), so what it sets on `window` is jsdom's,
 * and what the test sets there is the global object's. An assignment stays
 * on the object it is made to.
 */
function shareGlobals(window: IJsdomWindow, globals: Record<string, unknown>): void {
  const fallBackTo = (object: object, other: object): void => {
    const end = Object.getPrototypeOf(object) as object;
    Object.setPrototypeOf(
      object,
      new Proxy(end, {
        get: (target, key, receiver) =>
          !Reflect.has(target, key) && Object.prototype.hasOwnProperty.call(other, key)
            ? (other as Record<string | symbol, unknown>)[key]
            : Reflect.get(target, key, receiver),
        has: (target, key) => Reflect.has(target, key) || Object.prototype.hasOwnProperty.call(other, key),
      })
    );
  };
  fallBackTo(globals, window);
  /* At the end of the chain of jsdom's Window, whose instance is the window. */
  fallBackTo(Object.getPrototypeOf(window) as object, globals);
}

/** node's `vm` module itself, whose functions jsdom looks up at each call. */
const nodeVm = Module.createRequire(__filename)("node:vm") as typeof vm;

/**
 * Have jsdom run page scripts, as `jest-environment-jsdom` does, in the
 * test's own context, where jest runs them: an inline `<script>`, an `on…`
 * attribute and a `javascript:` URL. The window is made without
 * `runScripts`, so it is no vm context and jsdom builds its objects from
 * node's built-ins, as the test's are; it is then marked as running scripts,
 * and node's `vm.runInContext`, which jsdom runs them with, runs code given
 * this window in this context instead. Call before the window's properties
 * are copied.
 */
function runScriptsInTestContext(window: IJsdomWindow): void {
  window._runScripts = "dangerously";
  const runInContext = nodeVm.runInContext;
  nodeVm.runInContext = function (code: string, context: vm.Context, options?: vm.RunningScriptOptions | string): unknown {
    return context === window ? nodeVm.runInThisContext(code, options) : runInContext.call(nodeVm, code, context, options);
  } as typeof vm.runInContext;
}

/**
 * Make the virtual console `jest-environment-jsdom` gives jsdom: what the
 * page logs goes to the test's console, and each jsdom error (a feature it
 * does not implement, an uncaught exception) is passed to `console.error`
 * as the error.
 */
function virtualConsoleOf(jsdom: IJsdomModule): IVirtualConsole {
  const virtualConsole = new jsdom.VirtualConsole();
  if (typeof virtualConsole.forwardTo === "function") {
    virtualConsole.forwardTo(console);
  } else if (typeof virtualConsole.sendTo === "function") {
    virtualConsole.sendTo(console, { omitJSDOMErrors: true });
  }
  virtualConsole.on("jsdomError", error => console.error(error));
  return virtualConsole;
}

type Listener = (...args: unknown[]) => unknown;

/**
 * Report each error jsdom dispatches as an `error` event at the window (an
 * exception thrown by an event listener or an `on…` handler) as an uncaught
 * exception, which fails the running test, as `jest-environment-jsdom` does:
 * unless the test has added an `error` listener of its own with
 * `addEventListener`, in which case it handles them itself. An `onerror`
 * handler does not count as one.
 */
function reportUncaughtErrors(window: IJsdomWindow, globals: Record<string, unknown>): void {
  let userListeners = 0;
  const addListener = window.addEventListener as (type: string, listener: Listener) => void;
  addListener.call(window, "error", (event: unknown) => {
    const error = (event as { error?: unknown }).error;
    if (userListeners === 0 && error != null) {
      process.emit("uncaughtException", error as Error);
    }
  });
  const add = globals.addEventListener as Listener;
  const remove = globals.removeEventListener as Listener;
  globals.addEventListener = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] === "error") {
      userListeners++;
    }
    return add.apply(this, args);
  };
  globals.removeEventListener = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] === "error") {
      userListeners--;
    }
    return remove.apply(this, args);
  };
}

/**
 * Set up what jest sets up for a test file under either environment: the
 * global entries `installCommonGlobals` keeps for jest and for libraries
 * (`Symbol.for("jest-native-now")`, the real `Date.now` under fake timers,
 * and the others), `Error.stackTraceLimit` at 100, `NODE_ENV` as `test`
 * where it is unset, as jest's command line sets it, and `JEST_WORKER_ID` as
 * the one worker running the file. Call after the environment is installed.
 */
export function installJestGlobals(): void {
  const define = (key: string | symbol, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, enumerable: false, writable: false, configurable: true });
  };
  define(Symbol.for("jest-native-promise"), Promise);
  define(Symbol.for("jest-native-now"), Date.now.bind(Date));
  define(Symbol.for("jest-native-read-file"), fs.readFileSync.bind(fs));
  define(Symbol.for("jest-native-write-file"), fs.writeFileSync.bind(fs));
  define(Symbol.for("jest-native-exists-file"), fs.existsSync.bind(fs));
  define("jest-symbol-do-not-touch", Symbol);
  Error.stackTraceLimit = 100;
  process.env.NODE_ENV ??= "test";
  process.env.JEST_WORKER_ID ??= "1";
}

/** The `Symbol.for` key of the global holding node's `setImmediate`,
 * `clearImmediate`, `setInterval`, `clearInterval` and `performance` for
 * jsdom's modules. */
const NODE_GLOBALS = "fabr.jest.nodeGlobals";

interface ICompilingModule {
  parent?: { filename?: string } | null;
  _compile(content: string, filename: string): unknown;
}

/**
 * Compile jsdom's modules, and every module one of them is the first to load,
 * with node's own globals that jsdom reads bound in them, as under jest, where
 * these modules run outside the test's vm context: `setImmediate` and
 * `clearImmediate`, which {@link hideNodeGlobals} removes from the global
 * object; `performance`, whose global is jsdom's, which reads node's; and the
 * real `setInterval` and `clearInterval`, which fake timers do not replace
 * there: jsdom's `requestAnimationFrame` runs on an interval, which a test
 * switching back to real timers would otherwise leave stopped. Give them no
 * other timer: jsdom's timeouts must be the ones a test fakes.
 * Call before jsdom is loaded; does nothing where jsdom is not found.
 */
function compileEnvironmentWithNodeGlobals(jsdomMain: string | undefined): void {
  const root = jsdomMain === undefined ? undefined : packageRootOf(jsdomMain, "jsdom");
  if (root === undefined) {
    return;
  }
  const jsdomRoot = root + path.sep;
  Object.defineProperty(globalThis, Symbol.for(NODE_GLOBALS), {
    value: [setImmediate, clearImmediate, setInterval, clearInterval, performance],
  });
  const environment = new Set<string>();
  const compiling = Module as unknown as { prototype: ICompilingModule };
  const original = compiling.prototype._compile;
  compiling.prototype._compile = function (this: ICompilingModule, content: string, filename: string): unknown {
    const requirer = this.parent?.filename;
    if (filename.startsWith(jsdomRoot) || (requirer !== undefined && environment.has(requirer))) {
      environment.add(filename);
      content = withNodeGlobals(content);
    }
    return original.call(this, content, filename);
  };
}

/** @return the directory of the package `name` that `file` belongs to: the
 * nearest above it whose `package.json` names it, read through the physical
 * location where the directory is a PnP virtual one. */
export function packageRootOf(file: string, name: string): string | undefined {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    /* No manifest here, or not one that names it: keep looking. */
    if (readManifest(directory)?.name === name) {
      return directory;
    }
    if (path.dirname(directory) === directory) {
      return undefined;
    }
  }
}

/**
 * Wrap a CommonJS module's source so that `setImmediate`, `clearImmediate`,
 * `setInterval`, `clearInterval` and `performance` inside it name node's,
 * whatever the global object holds. Line numbers are unchanged, and a leading
 * `"use strict"` still applies.
 */
export function withNodeGlobals(content: string): string {
  const body = content.startsWith("#!") ? "//" + content.slice(2) : content;
  return `(function (setImmediate, clearImmediate, setInterval, clearInterval, performance) {${body}\n}).apply(this, globalThis[Symbol.for(${JSON.stringify(NODE_GLOBALS)})]);`;
}

/**
 * Remove from `globals` each global that a test under `jest-environment-jsdom`
 * does not see: one that `window` does not provide, that is no ECMAScript
 * built-in, and that jest's environment does not add itself (`process`,
 * `Buffer`, `global`, `console`). Code that picks what to use by what exists
 * (`fetch` or `XMLHttpRequest`; React's scheduler, `setImmediate` or
 * `MessageChannel`) then picks what it picks under jest.
 */
export function hideNodeGlobals(globals: Record<string, unknown>, window: object): void {
  for (const key of Object.getOwnPropertyNames(globals)) {
    if (!(key in window) && !BUILT_INS.has(key) && !JEST_ADDED_GLOBALS.has(key)) {
      Reflect.deleteProperty(globals, key);
    }
  }
}

/**
 * Make the getter `name` of `prototype` answer `globals` where it would answer
 * jsdom's `window`, so that a value jsdom hands out is the same object as the
 * test's `window`. Anything else it answers is left as it is.
 */
export function answerWithGlobal(prototype: object | undefined, name: string, window: object, globals: object): void {
  const descriptor = prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, name);
  const getter = descriptor?.get;
  if (prototype === undefined || descriptor === undefined || getter === undefined) {
    return;
  }
  Object.defineProperty(prototype, name, {
    ...descriptor,
    get(this: unknown) {
      const value: unknown = getter.call(this);
      return value === window ? globals : value;
    },
  });
}

/** Copy one of the window's properties onto the global object, an accessor as
 * an accessor. */
function define(globals: Record<string, unknown>, name: string, window: IJsdomWindow, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (descriptor === undefined) {
    return;
  }
  try {
    Object.defineProperty(globals, name, { ...descriptor, configurable: true });
  } catch {
    /* A non-configurable global of node's stays node's. */
  }
}

/**
 * Make the global object's `location` (jsdom's) a writable, configurable
 * property, so a test can redefine it with `Object.defineProperty(window,
 * "location", …)`, which under jest throws (jsdom's own is `[Unforgeable]`).
 * jsdom's window keeps its own, which jsdom reads.
 */
function patchLocation(window: IJsdomWindow): void {
  Object.defineProperty(globalThis, "location", { value: window.location, writable: true, configurable: true });
}
