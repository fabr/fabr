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
 * jest's module mocking (`jest.mock` and the rest) over node's own module
 * loader: one registry of mocks, consulted at two seams.
 *
 * - **CommonJS**: a `Module._load` wrap that serves a mock where the registry
 *   has one, and otherwise calls the original `_load`.
 * - **ES modules**: `module.registerHooks` resolve and load hooks, which
 *   resolve a mocked import to a synthetic module re-exporting the same value
 *   the CommonJS seam serves.
 *
 * Tests are compiled to CommonJS, so most requires pass the CommonJS seam; the
 * ES module seam catches imports inside an ES module package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, isBuiltin, Module } from "node:module";
import { assetStubFor } from "../testRunner/Assets";
import { isRegistryModule, isRunnerModule } from "./Tools";

/** The fields of node's CommonJS `Module` the registry resolves from. */
export interface ILoaderModule {
  id?: string;
  filename?: string;
  path?: string;
  paths?: string[];
}

type Factory = () => unknown;

/** How a registered specifier is to be served. */
interface IMockEntry {
  /** An explicit factory (`jest.mock('x', () => …)`), run once per generation. */
  factory?: Factory;
  /** Serve a manual mock, else a mock derived from the real module's shape. */
  automock?: boolean;
  /** Never mock this one, whatever the automock setting (`jest.unmock`). */
  unmocked?: boolean;
  /** The specifier need not resolve to a real file (`{virtual: true}`). */
  virtual?: boolean;
}

/** What {@link MockRegistry.serve} returns for a module to load normally (a
 * factory may return `undefined`). */
export const NOT_MOCKED: unique symbol = Symbol("not-mocked");

/** The global holding each mock's value by key, which a synthetic module's
 * source reads. */
const ESM_EXPORTS = "__fabrJestMockExports";
const MOCK_SCHEME = "fabr-mock:";

/**
 * The mock registry both seams consult. A specifier is keyed by the absolute
 * path it resolves to from its caller, a core module by its name without
 * `node:`, and a specifier that resolves to nothing (a virtual mock, a module
 * not installed) by {@link unresolvedKey}. So `./x` from two callers and
 * `pkg/x` from a third share one mock where they name one file.
 *
 * A mock's value is made once per generation (bumped by `resetModules`) and
 * served to every require and import of its key.
 */
export class MockRegistry {
  private readonly entries = new Map<string, IMockEntry>();
  /** Each mock's value, by generation and key. */
  private readonly instances = new Map<string, unknown>();
  /** Bumped by `resetModules`, after which every mock and registry module is
   * made afresh. */
  private generation = 0;
  /** What a running `isolateModules` set aside: the registry's modules,
   * restored when it ends, and the mock instances that predate it, which it
   * keeps while dropping those made inside. */
  private isolation: { readonly modules: Map<string, NodeModule>; readonly instances: Set<string> } | undefined;
  /** Bumped by every registration change, for {@link mockStamp}. */
  private mockSerial = 0;
  private automockAll = false;
  /** Keys whose real module is loading now (see {@link loadActual}), which
   * both seams load unmocked. */
  private readonly loadingActual = new Set<string>();
  /** The root `__mocks__` files by the package each mocks, listed once at
   * construction. */
  private readonly rootMocks = new Map<string, string>();
  /** Get `@jest/globals` for a module, which the hoisted `jest.mock` calls
   * require. Set by runTestFile once the jest object can be made. */
  public jestGlobalsFor: (caller: ILoaderModule | undefined) => unknown = () => ({});

  constructor(
    private readonly root: string,
    private readonly moduleMocker: IModuleMocker
  ) {
    this.rootMocks = listRootMocks(root);
  }

  /* ---- registration (the jest object's module operations) ---- */

  public setMock(specifier: string, caller: ILoaderModule | undefined, factory?: Factory, virtual = false): void {
    const key = this.keyFor(specifier, caller, virtual);
    this.entries.set(key, { factory, automock: factory === undefined, virtual });
    this.instances.delete(key);
    this.mockSerial++;
  }

  public unmock(specifier: string, caller: ILoaderModule | undefined): void {
    const key = this.keyFor(specifier, caller, true);
    this.entries.set(key, { unmocked: true });
    this.instances.delete(key);
    this.mockSerial++;
  }

  public setAutomockAll(enabled: boolean): void {
    this.automockAll = enabled;
    this.mockSerial++;
  }

  /** Start a new generation (`jest.resetModules`): every mock, and every
   * registry module (see {@link isRegistryModule}), is made afresh on its next
   * require. The runner's own modules stay loaded. */
  public resetModules(): void {
    this.generation++;
    this.instances.clear();
    this.isolation?.modules.clear();
    this.isolation?.instances.clear();
    this.evictRegistryModules();
  }

  /**
   * Run `fn` with the registry's modules loaded afresh, as jest's isolated module
   * registry does: a module it requires, installed dependencies included, is a
   * new instance, while a mock made before it is the same instance inside. When
   * `fn` returns, the modules it loaded and the mocks it made are dropped and the
   * earlier instances are restored. A promise `fn` returns is not waited for.
   */
  public isolateModules<T>(fn: () => T): T {
    this.beginIsolation("isolateModules");
    try {
      return fn();
    } finally {
      this.endIsolation();
    }
  }

  /** Run `fn` as {@link isolateModules} does, ending the isolation once its promise settles. */
  public async isolateModulesAsync(fn: () => Promise<void>): Promise<void> {
    this.beginIsolation("isolateModulesAsync");
    try {
      await fn();
    } finally {
      this.endIsolation();
    }
  }

  private beginIsolation(name: string): void {
    if (this.isolation !== undefined) {
      throw new Error(`${name} cannot be nested inside another isolateModules or isolateModulesAsync.`);
    }
    const cache = this.moduleCache;
    const modules = new Map<string, NodeModule>();
    for (const [filename, module] of Object.entries(cache)) {
      if (module !== undefined && isRegistryModule(filename)) {
        modules.set(filename, module);
      }
    }
    this.evictRegistryModules();
    this.isolation = { modules, instances: new Set(this.instances.keys()) };
  }

  private endIsolation(): void {
    const { modules, instances } = this.isolation!;
    this.isolation = undefined;
    this.evictRegistryModules();
    const cache = this.moduleCache;
    for (const [filename, module] of modules) {
      cache[filename] = module;
    }
    for (const key of [...this.instances.keys()]) {
      if (!instances.has(key)) {
        this.instances.delete(key);
      }
    }
  }

  private evictRegistryModules(): void {
    const cache = this.moduleCache;
    for (const filename of Object.keys(cache)) {
      if (isRegistryModule(filename)) {
        delete cache[filename];
      }
    }
  }

  /** The module cache of the loader the registry loads through. */
  private get moduleCache(): NodeJS.Dict<NodeModule> {
    return this.requireFrom(undefined).cache;
  }

  /* ---- serving (both seams) ---- */

  /**
   * Get what a require of `request` from `caller` is served, in order:
   * `@jest/globals`; no mock for a caller in the runner's own install; the
   * registered mock (nothing where `jest.unmock`ed); otherwise a root
   * `__mocks__` file for the package, under `enableAutomock` an automock of a
   * module keyed by path, or an asset stub for a stylesheet or binary.
   * @return the module's value, or {@link NOT_MOCKED} for node to load it.
   */
  public serve(request: string, caller: ILoaderModule | undefined): unknown {
    if (request === "@jest/globals") {
      return this.jestGlobalsFor(caller);
    }
    /* Never serve a mock to the runner's own modules (circus, expect, …), as
     * jest serves none to its internals (requireInternalModule). The ESM seam
     * judges the importer by the resolve context's parentURL. */
    if (isRunnerInternal(caller?.filename)) {
      return NOT_MOCKED;
    }
    const key = this.resolve(request, caller) ?? this.unresolvedKey(request, caller);
    if (this.loadingActual.has(key)) {
      return NOT_MOCKED;
    }
    const entry = this.entries.get(key);
    if (entry?.unmocked) {
      return NOT_MOCKED;
    }
    if (entry === undefined) {
      /* Mocks made without a registration: a root `__mocks__` file, and under
       * automock every module keyed by path (not a core module or an
       * unresolved bare name). */
      const rootMock = this.rootMocks.get(request);
      if (rootMock !== undefined) {
        return this.instance(key, () => this.load(rootMock));
      }
      if (this.automockAll && path.isAbsolute(key)) {
        return this.instance(key, () => this.automockOf(key));
      }
      /* A stylesheet or a binary, which node cannot load. An explicit mock
       * takes precedence. One value per generation, as for a mock. */
      const asset = assetStubFor(request);
      if (asset !== undefined) {
        return this.instance(key, () => asset);
      }
      return NOT_MOCKED;
    }
    return this.instance(key, () => (entry.factory ? entry.factory() : this.manualOrAutomock(key, request)));
  }

  /**
   * Make the module a factory-less `jest.mock('./x')` serves, as jest does: a
   * manual mock (`__mocks__/<name>` beside the resolved module, else a root
   * `__mocks__` file for the package), else an automock of the real module.
   */
  private manualOrAutomock(key: string, request: string): unknown {
    const manual = adjacentMock(key) ?? this.rootMocks.get(request);
    return manual !== undefined ? this.load(manual) : this.automockOf(key);
  }

  /** The stamp in the ESM seam's synthetic URLs, which changes on a
   * `resetModules` and on every registration change. Node never evicts an ES
   * module, so only a new URL evaluates a mock's module afresh. */
  public get mockStamp(): string {
    return `${this.generation}-${this.mockSerial}`;
  }

  /**
   * Make the mock for `key` and record its value for the synthetic module of
   * that exact key (for a root `__mocks__` file, the package name, where
   * serve() records it under the resolved path too). Throws where the registry
   * has nothing for `key`, which the resolve hook only asks for where
   * {@link hasMockFor} said it has.
   */
  public publishForEsm(key: string): void {
    const served = this.serve(key, undefined);
    if (served === NOT_MOCKED) {
      throw new Error(`fabr jest runner: '${key}' resolved as mocked, but the registry has nothing to serve for it`);
    }
    esmExports().set(key, served);
  }

  /**
   * @return true if the registry would serve a mock for this exact key,
   * resolving nothing itself, otherwise false. For the resolve hook, which
   * holds node's resolution already.
   */
  public hasMockFor(key: string): boolean {
    if (this.loadingActual.has(key)) {
      return false;
    }
    /* Keep serve()'s order: a registration, `jest.unmock` included, takes
     * precedence over a root mock or an asset stub. */
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      return !entry.unmocked;
    }
    return this.rootMocks.has(key) || assetStubFor(key) !== undefined;
  }

  /**
   * Load the real module behind `request` (`jest.requireActual`). Only that
   * module is loaded unmocked: the modules it requires are served by the
   * registry as usual, as under jest.
   */
  public requireActual(request: string, caller: ILoaderModule | undefined): unknown {
    return this.loadActual(this.resolve(request, caller) ?? request, caller);
  }

  /** Load the real module behind `key`, which both seams load unmocked while it
   * loads; for `requireActual` and for an automock, which reads the real
   * module's shape. */
  private loadActual(key: string, caller?: ILoaderModule): unknown {
    this.loadingActual.add(key);
    try {
      return this.load(key, caller);
    } finally {
      this.loadingActual.delete(key);
    }
  }

  /** Get the mocked module, even where nothing registered one
   * (`jest.requireMock`). */
  public requireMock(request: string, caller: ILoaderModule | undefined): unknown {
    const served = this.serve(request, caller);
    if (served !== NOT_MOCKED) {
      return served;
    }
    const key = this.resolve(request, caller) ?? this.unresolvedKey(request, caller);
    return this.instance(key, () => this.automockOf(key));
  }

  /** Resolve a specifier as `caller` would, to its registry key, bypassing the
   * ESM hooks.
   * @return the key, or undefined where it resolves to nothing (a virtual mock
   *   or a missing module). */
  public resolve(request: string, caller: ILoaderModule | undefined): string | undefined {
    return withoutHooks(() => {
      try {
        return coreModuleKey(this.requireFrom(caller).resolve(request));
      } catch {
        return undefined;
      }
    });
  }

  private requireFrom(caller: ILoaderModule | undefined): NodeRequire {
    return createRequire(caller?.filename ?? path.join(this.root, "index.js"));
  }

  /** Make the registry key for a registration. A specifier that resolves to
   * nothing is keyed by {@link unresolvedKey} where `allowUnresolved` (a
   * virtual mock, an unmock), for an asset request, or for a package with a
   * root `__mocks__` file; otherwise throws jest's "Cannot find module"
   * error. */
  private keyFor(specifier: string, caller: ILoaderModule | undefined, allowUnresolved: boolean): string {
    const resolved = this.resolve(specifier, caller);
    if (resolved !== undefined) {
      return resolved;
    }
    if (allowUnresolved || assetStubFor(specifier) !== undefined || this.rootMocks.has(specifier)) {
      return this.unresolvedKey(specifier, caller);
    }
    throw new Error(`Cannot find module '${specifier}' from '${caller?.filename ?? this.root}'`);
  }

  /** Make the key of a specifier that resolves to nothing: a relative or
   * absolute path is keyed by the absolute path it names, as jest keys it (so a
   * virtual mock of `../config/test.json` answers a require of that absolute
   * path), and a bare name by its text. */
  public unresolvedKey(specifier: string, caller: ILoaderModule | undefined): string {
    const isPath = specifier.startsWith("./") || specifier.startsWith("../") || path.isAbsolute(specifier);
    return isPath ? path.resolve(path.dirname(caller?.filename ?? path.join(this.root, "index.js")), specifier) : specifier;
  }

  private load(request: string, caller?: ILoaderModule): unknown {
    return this.requireFrom(caller)(request);
  }

  /** Get the value `create` makes for `key`, once per generation, and record it
   * for the key's synthetic ES module. */
  private instance(key: string, create: () => unknown): unknown {
    const stamped = `${this.generation}\n${key}`;
    if (!this.instances.has(stamped)) {
      this.instances.set(stamped, create());
    }
    const value = this.instances.get(stamped);
    esmExports().set(key, value);
    return value;
  }

  /**
   * Make an automatic mock of the real module behind `key`, with jest-mock:
   * each function replaced by a mock function, the shape otherwise kept.
   *
   * The real module is loaded in isolation, as jest loads it: every registry
   * module (see {@link isRegistryModule}) the load added to the module cache is
   * evicted once its metadata is read. So a module that requires this one back
   * (a cycle) is loaded afresh when the code under test requires it, bound to
   * the mock.
   */
  private automockOf(key: string): unknown {
    const cache = this.moduleCache;
    const cached = new Set(Object.keys(cache));
    try {
      return this.moduleMocker.generateFromMetadata(this.moduleMocker.getMetadata(this.loadActual(key)));
    } finally {
      for (const filename of Object.keys(cache)) {
        if (!cached.has(filename) && isRegistryModule(filename)) {
          delete cache[filename];
        }
      }
    }
  }
}

/** The slice of jest-mock's ModuleMocker this module uses. */
export interface IModuleMocker {
  getMetadata(component: unknown): unknown;
  generateFromMetadata(metadata: unknown): unknown;
}

function esmExports(): Map<string, unknown> {
  const globals = globalThis as Record<string, unknown>;
  if (!(globals[ESM_EXPORTS] instanceof Map)) {
    globals[ESM_EXPORTS] = new Map<string, unknown>();
  }
  return globals[ESM_EXPORTS] as Map<string, unknown>;
}

/** The directory of the test installation holding the compiled source tree:
 * the js rules' COMPILE_OUT_DIR. Keep the two in step. */
const COMPILED_TREE = "build";

/**
 * List the root `__mocks__` files, each mocking the package it is named for
 * (`__mocks__/@scope/pkg.js` for a scoped one) without a `jest.mock` call.
 * Lists `build/__mocks__` (where the source tree's root `__mocks__` is staged),
 * then `__mocks__` at the installation root, the first file of a name taking
 * precedence.
 * @return the mock file by package name.
 */
function listRootMocks(root: string): Map<string, string> {
  const mocks = new Map<string, string>();
  const add = (entryDir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(entryDir, { withFileTypes: true })) {
      if (entry.isDirectory() && prefix === "" && entry.name.startsWith("@")) {
        add(path.join(entryDir, entry.name), `${entry.name}/`);
      } else if (entry.isFile()) {
        const name = prefix + entry.name.replace(/\.[cm]?[jt]sx?$/, "");
        if (!mocks.has(name)) {
          mocks.set(name, path.join(entryDir, entry.name));
        }
      }
    }
  };
  for (const dir of [path.join(root, COMPILED_TREE, "__mocks__"), path.join(root, "__mocks__")]) {
    try {
      add(dir, "");
    } catch {
      /* No __mocks__ directory here: the ordinary case. */
    }
  }
  return mocks;
}

/**
 * Find the manual mock of a module that is not in `node_modules`:
 * `__mocks__/<name>.js` in the resolved file's directory (compiled, so `.js`
 * whatever its source was).
 * @return the mock's path, or undefined where there is none.
 */
function adjacentMock(key: string): string | undefined {
  if (!path.isAbsolute(key) || key.includes(`${path.sep}node_modules${path.sep}`)) {
    return undefined;
  }
  const candidate = path.join(path.dirname(key), "__mocks__", path.basename(key).replace(/\.[cm]?[jt]sx?$/, "") + ".js");
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * @return the key a resolved module is registered under: a core module by its
 * name without `node:`, as jest keys one (so a mock of `fs` is served for
 * `node:fs`), anything else as it resolved. A builtin that exists only with
 * the prefix (`node:test`) keeps it.
 */
function coreModuleKey(resolved: string): string {
  const name = resolved.startsWith("node:") ? resolved.slice("node:".length) : resolved;
  return isBuiltin(name) && !path.isAbsolute(name) ? name : resolved;
}

/** The member of node's CommonJS loader the seam wraps. */
interface ILoaderModuleClass {
  _load(request: string, parent: ILoaderModule | undefined, isMain: boolean): unknown;
}

/**
 * Install both seams over `registry`. Call once per process: a second call
 * wraps the loader again.
 */
export function installSeams(registry: MockRegistry): void {
  installCommonJsSeam(registry);
  installEsmSeam(registry);
}

/**
 * Install the CommonJS seam: wrap `Module._load` to return what the registry
 * serves, and otherwise call the original.
 */
function installCommonJsSeam(registry: MockRegistry): void {
  const loader = Module as unknown as ILoaderModuleClass;
  const original = loader._load;
  loader._load = function (request: string, parent: ILoaderModule | undefined, isMain: boolean): unknown {
    const served = registry.serve(request, parent);
    return served === NOT_MOCKED ? original.call(this, request, parent, isMain) : served;
  };
}

/**
 * Install the ES module seam with `module.registerHooks`, whose hooks run for
 * every import, a dynamic `import()` and an import inside a package loaded by
 * `require(esm)` included. A mocked specifier resolves to a `fabr-mock:` URL
 * stamped with {@link MockRegistry.mockStamp}, which loads as a synthetic
 * module re-exporting the value the CommonJS seam serves.
 */
function installEsmSeam(registry: MockRegistry): void {
  /* assertSupportedHost has checked that registerHooks exists. */
  const { registerHooks } = Module as unknown as { registerHooks: (hooks: unknown) => void };
  registerHooks({
    resolve: makeResolveHook(registry),
    load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown): unknown {
      if (!url.startsWith(MOCK_SCHEME)) {
        return nextLoad(url, context);
      }
      const key = keyFromMockUrl(url);
      /* Make the mock first: the module's export names, which the importer
       * links against, are read off its value. */
      registry.publishForEsm(key);
      return { format: "module", shortCircuit: true, source: syntheticModule(key) };
    },
  });
}

/**
 * Make the ES module seam's resolve hook. A specifier the registry holds a
 * mock for, keyed as the CommonJS seam keys it (or registered by its bare
 * text, for a root `__mocks__` file), resolves to the mock's synthetic module;
 * anything else resolves as node resolves it, and one that resolves to
 * nothing and has no mock throws node's error.
 */
export function makeResolveHook(
  registry: MockRegistry
): (specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => { url: string }) => unknown {
  return (specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => { url: string }): unknown => {
    /* The hooks run for `require` as well as `import`: pass the registry's own
     * resolutions through, or looking a mock up would resolve to the mock. */
    if (bypassing > 0) {
      return nextResolve(specifier, context);
    }
    /* Never serve a mock to the runner's own modules, as in serve(). */
    const parent = (context as { parentURL?: string }).parentURL;
    if (parent !== undefined && parent.startsWith("file:") && isRunnerInternal(fileURLToPath(parent))) {
      return nextResolve(specifier, context);
    }
    /* Key on node's resolution: the registry resolving it would re-enter this
     * hook. */
    let resolved: { url: string } | undefined;
    let failure: unknown;
    try {
      resolved = nextResolve(specifier, context);
    } catch (err) {
      failure = err;
    }
    const key =
      resolved === undefined
        ? registry.unresolvedKey(specifier, parent?.startsWith("file:") ? { filename: fileURLToPath(parent) } : undefined)
        : resolved.url.startsWith("file:")
          ? fileURLToPath(resolved.url)
          : resolved.url.startsWith("node:")
            ? coreModuleKey(resolved.url)
            : specifier;
    /* The URL carries the key the registry holds the mock under: the key
     * above, or the bare specifier for a root `__mocks__` file. */
    const mockKey = registry.hasMockFor(key) ? key : registry.hasMockFor(specifier) ? specifier : undefined;
    if (mockKey !== undefined) {
      return { url: mockUrl(registry, mockKey), shortCircuit: true };
    }
    if (resolved === undefined) {
      /* Not mocked and not found: node's own error. */
      throw failure;
    }
    return resolved;
  };
}

/**
 * The depth of {@link withoutHooks} calls: while non-zero, the resolve hook
 * passes every specifier through, for the registry's own resolutions.
 */
let bypassing = 0;

function withoutHooks<T>(fn: () => T): T {
  bypassing++;
  try {
    return fn();
  } finally {
    bypassing--;
  }
}

/**
 * Make the source of a mock's synthetic ES module: the value recorded for
 * `key` as the default export (its `default` where it is `__esModule`), and
 * each of its own enumerable keys that is an identifier as a named export.
 */
function syntheticModule(key: string): string {
  const value = esmExports().get(key);
  const names = value && typeof value === "object" ? Object.keys(value as object).filter(isIdentifier) : [];
  const lookup = `globalThis.${ESM_EXPORTS}.get(${JSON.stringify(key)})`;
  return [
    `const __mock = ${lookup};`,
    "export default __mock && __mock.__esModule ? __mock.default : __mock;",
    ...names.filter(name => name !== "default").map(name => `export const ${name} = __mock[${JSON.stringify(name)}];`),
  ].join("\n");
}

/** @return true if `name` can be a named export, otherwise false; any other
 * key is reached through the default export. */
function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Make the synthetic URL for a mocked key, stamped with
 * {@link MockRegistry.mockStamp}. */
function mockUrl(registry: MockRegistry, key: string): string {
  return `${MOCK_SCHEME}${registry.mockStamp}/${encodeURIComponent(key)}`;
}

/** Get the key a synthetic URL carries, without its stamp. */
function keyFromMockUrl(url: string): string {
  return decodeURIComponent(url.slice(MOCK_SCHEME.length).replace(/^[\d-]+\//, ""));
}

/** @return true if `filename` is a module of the runner's own install, to
 * which the registry serves no mock, otherwise false. */
function isRunnerInternal(filename: string | undefined): boolean {
  return filename !== undefined && isRunnerModule(filename);
}
