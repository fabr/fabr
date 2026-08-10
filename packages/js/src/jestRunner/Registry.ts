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
 * Module interception: the mocking semantics a jest test observes, implemented
 * over NODE'S OWN module system rather than a replacement for it.
 *
 * This is the deliberate boundary of the compatibility layer. jest's
 * `jest-runtime` is a substitute module system — resolver, transformer,
 * registry, sandbox — and reimplementing the module system is the price of
 * owning resolution. Fabr owns compilation and import resolution already, so
 * what is wanted here is only jest-runtime's *interface obligations*: the
 * observable behaviour of `jest.mock` and friends. Those are one registry and
 * two seams:
 *
 * - **CommonJS**: a `Module._load` wrap that consults the registry and
 *   otherwise **delegates to the original**. Delegation is the whole point: an
 *   ESM-only dependency loads through node's `require(esm)`, and every
 *   capability node gains later arrives for free.
 * - **ES modules**: `module.registerHooks` resolve/load hooks over the *same*
 *   registry, so an edge inside an ESM subgraph is interceptable too, and both
 *   seams hand out the same mock instance (a call-count assertion holds
 *   whichever edge delivered it).
 *
 * Compiled tests are CommonJS (see TestPipeline), so the CJS seam carries
 * essentially all of the traffic; the ESM seam exists so that mocking a module
 * an ESM-only package imports internally is not a hole.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, Module } from "node:module";
import { assetStubFor } from "./Assets";
import { isCodeUnderTest, RUNNER_ROOT } from "./Tools";

/** What a caller module is, for resolution purposes: node's CJS Module. */
export interface ILoaderModule {
  id?: string;
  filename?: string;
  path?: string;
  paths?: string[];
}

type Factory = () => unknown;

/** How a registered specifier is to be served. */
interface IMockEntry {
  /** An explicit factory (`jest.mock('x', () => …)`), memoized per generation. */
  factory?: Factory;
  /** Automock: derive a mock from the real module's shape. */
  automock?: boolean;
  /** Never mock this one, whatever the automock setting (`jest.unmock`). */
  unmocked?: boolean;
  /** The specifier need not resolve to a real file (`{virtual: true}`). */
  virtual?: boolean;
}

/** Sentinel for "the registry has nothing to say — load it normally". Distinct
 * from `undefined`, which is a perfectly good thing for a factory to return. */
export const NOT_MOCKED: unique symbol = Symbol("not-mocked");

/** The mocked-module namespaces the ESM seam serves, reachable from generated
 * synthetic module source (which can only see globals). */
const ESM_EXPORTS = "__fabrJestMockExports";
const MOCK_SCHEME = "fabr-mock:";

/**
 * The one registry both seams consult. Keys are **resolved absolute paths**
 * where the specifier resolves to a file, and the bare specifier otherwise (a
 * virtual mock, or a package that isn't installed) — so `./x` from two
 * different callers and `pkg/x` from a third all agree when they name the same
 * file, which is what makes a mock registered in one module visible at every
 * edge that reaches it.
 */
export class MockRegistry {
  private readonly entries = new Map<string, IMockEntry>();
  /** Memoized factory results, cleared wholesale on a generation bump. */
  private readonly instances = new Map<string, unknown>();
  /** Bumped by `resetModules`/`isolateModules`: a mock instance and a module
   * registry entry are only valid within one generation. */
  private generation = 0;
  /** Bumped by every registration change, for {@link mockStamp}. */
  private mockSerial = 0;
  private automockAll = false;
  /** Keys whose REAL module is being loaded right now (`jest.requireActual`),
   * for which both seams stand aside — see requireActual. */
  private readonly loadingActual = new Set<string>();
  /** Root-level `__mocks__/<package>` files, listed once — the convention is
   * automatic (no `jest.mock` call), so it is consulted on every bare require
   * and must not cost a stat each time. */
  private readonly rootMocks = new Map<string, string>();
  /** Serves `@jest/globals`, which the hoisted `jest.mock` calls require. Set
   * by the preload once the globals exist. */
  public jestGlobalsFor: (caller: ILoaderModule | undefined) => unknown = () => ({});

  constructor(private readonly root: string, private readonly moduleMocker: IModuleMocker) {
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

  /** A new generation: memoized mock instances and the code under test are both
   * reloaded on next require. The runner's own machinery and everything in the
   * sealed tool mount stay cached — evicting those would tear the layer out
   * from under the very test that asked for a reset. */
  public resetModules(): void {
    this.generation++;
    this.instances.clear();
    for (const filename of Object.keys(require.cache)) {
      if (isCodeUnderTest(this.root, filename)) {
        delete require.cache[filename];
      }
    }
  }

  public isolateModules<T>(fn: () => T): T {
    this.resetModules();
    try {
      return fn();
    } finally {
      this.resetModules();
    }
  }

  /* ---- serving (both seams) ---- */

  /**
   * What to hand back for `request` loaded from `caller`, or {@link NOT_MOCKED}
   * to let node load it normally.
   */
  public serve(request: string, caller: ILoaderModule | undefined): unknown {
    if (request === "@jest/globals") {
      return this.jestGlobalsFor(caller);
    }
    /* The layer's own machinery is exempt from mocking, as jest's internals are
     * under jest (requireInternalModule): a root `__mocks__/chalk.js`, an
     * enableAutomock, or an explicit jest.mock must never be served to circus,
     * expect or jest-message-util — the framework would be corrupted far from
     * the cause. Judged on the REQUIRING side; the ESM seam applies the same
     * rule via its resolve context's parentURL. */
    if (isRunnerInternal(caller?.filename)) {
      return NOT_MOCKED;
    }
    const key = this.resolve(request, caller) ?? request;
    if (this.loadingActual.has(key)) {
      return NOT_MOCKED;
    }
    const entry = this.entries.get(key);
    if (entry?.unmocked) {
      return NOT_MOCKED;
    }
    if (entry === undefined) {
      /* The two conventions that mock without being asked to: a root-level
       * `__mocks__/<package>` beside the tests, and (only under automock) every
       * module that isn't the code's own. Served through instance() like every
       * other mock, so it is published for the ESM seam and generation-scoped
       * like the rest. */
      const rootMock = this.rootMocks.get(request);
      if (rootMock !== undefined) {
        return this.instance(key, () => this.load(rootMock));
      }
      if (this.automockAll && key !== request) {
        return this.instance(key, () => this.automockOf(key));
      }
      /* A stylesheet or a binary: there is no bundler under test, and handing
       * one to node is a syntax error. Consulted AFTER an explicit mock, so a
       * project that wants its own stub still wins. Memoized like any other
       * served module, so `styles` is the same object at every import. */
      const asset = assetStubFor(request);
      if (asset !== undefined) {
        return this.instance(key, () => asset);
      }
      return NOT_MOCKED;
    }
    return this.instance(key, () => (entry.factory ? entry.factory() : this.automockOf(key)));
  }

  /** The stamp for the ESM seam's synthetic URLs: node's ESM module map is not
   * evictable, so a fresh URL is the only way to get a freshly evaluated
   * module — needed on a `resetModules` (the generation) AND on any
   * re-registration within a generation (the serial; a `doMock` after an ESM
   * edge already imported the mock must not keep serving the old factory's
   * instance while the CJS seam hands out the new one). */
  public get mockStamp(): string {
    return `${this.generation}-${this.mockSerial}`;
  }

  /**
   * Serve `key` for the ESM seam, publishing the instance under that EXACT key
   * — the synthetic module's source looks it up by the name its URL carried,
   * which for a root `__mocks__` entry is the package name while serve()
   * memoizes under the resolved path. Loud when there is nothing to serve: the
   * resolve hook only mints a mock URL for a key it vouched for, so a miss here
   * is a bug in this layer, and a module of undefined exports would surface as
   * an unrelated TypeError far from the cause.
   */
  public publishForEsm(key: string): void {
    const served = this.serve(key, undefined);
    if (served === NOT_MOCKED) {
      throw new Error(`fabr jest runner: '${key}' resolved as mocked, but the registry has nothing to serve for it`);
    }
    esmExports().set(key, served);
  }

  /**
   * Whether something is registered under this exact key — no resolution of its
   * own. The ESM seam asks in these terms because it has already been handed
   * node's resolution of the specifier, and asking again from inside a resolve
   * hook is how you get an infinite regress.
   */
  public hasMockFor(key: string): boolean {
    if (this.loadingActual.has(key)) {
      return false;
    }
    if (assetStubFor(key) !== undefined) {
      return true;
    }
    const entry = this.entries.get(key);
    return (entry !== undefined && !entry.unmocked) || this.rootMocks.has(key);
  }

  /**
   * The real module, mock registrations bypassed (`jest.requireActual`). The
   * bypass is for THIS module only, and only while it is loading: its own
   * dependencies keep going through the registry, which is jest's semantics and
   * the point of the call — a factory that mocks part of a module and takes the
   * rest from the real one.
   */
  public requireActual(request: string, caller: ILoaderModule | undefined): unknown {
    return this.loadActual(this.resolve(request, caller) ?? request, caller);
  }

  /** Load the real module behind a key with both seams standing aside for it —
   * the shared mechanism behind `requireActual` and automocking (which must see
   * the real module's shape to derive a mock of it, and would otherwise ask for
   * the very mock it is deriving). The bypass covers this module only, and only
   * while it loads. */
  private loadActual(key: string, caller?: ILoaderModule): unknown {
    this.loadingActual.add(key);
    try {
      return this.load(key, caller);
    } finally {
      this.loadingActual.delete(key);
    }
  }

  /** The mocked module, even where nothing registered one (`jest.requireMock`). */
  public requireMock(request: string, caller: ILoaderModule | undefined): unknown {
    const served = this.serve(request, caller);
    if (served !== NOT_MOCKED) {
      return served;
    }
    const key = this.resolve(request, caller) ?? request;
    return this.instance(key, () => this.automockOf(key));
  }

  /** Resolve a specifier the way the calling module would, or undefined if it
   * names nothing on disk (a virtual mock, or a genuinely missing module —
   * indistinguishable here, and both legitimately keyed by their text). */
  public resolve(request: string, caller: ILoaderModule | undefined): string | undefined {
    return withoutHooks(() => {
      try {
        return this.requireFrom(caller).resolve(request);
      } catch {
        return undefined;
      }
    });
  }

  private requireFrom(caller: ILoaderModule | undefined): NodeRequire {
    return createRequire(caller?.filename ?? path.join(this.root, "index.js"));
  }

  private keyFor(specifier: string, caller: ILoaderModule | undefined, allowUnresolved: boolean): string {
    const resolved = this.resolve(specifier, caller);
    if (resolved === undefined && !allowUnresolved) {
      return specifier;
    }
    return resolved ?? specifier;
  }

  private load(request: string, caller?: ILoaderModule): unknown {
    return this.requireFrom(caller)(request);
  }

  /** Memoize per (key, generation): repeated requires of a factory mock see one
   * instance, so a call recorded through one edge is visible through another. */
  private instance(key: string, create: () => unknown): unknown {
    const stamped = `${this.generation}\n${key}`;
    if (!this.instances.has(stamped)) {
      this.instances.set(stamped, create());
    }
    const value = this.instances.get(stamped);
    /* Publish for the ESM seam, whose synthetic module source can reach only globals. */
    esmExports().set(key, value);
    return value;
  }

  /**
   * An automatic mock of the real module: every function replaced by a mock
   * function, the shape otherwise preserved. This is the one algorithm not
   * worth reinventing — it is jest-mock's, driven off the real module's
   * metadata.
   */
  private automockOf(key: string): unknown {
    const actual = this.loadActual(key);
    return this.moduleMocker.generateFromMetadata(this.moduleMocker.getMetadata(actual));
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

/**
 * The root-level `__mocks__` convention: a file named for an installed package
 * mocks it *without* any `jest.mock` call. Listed once at startup — it is
 * consulted on every bare require, and the directory cannot change under a
 * hermetic run. (Adjacent `__mocks__` directories, which mock user modules only
 * when asked, are found through ordinary resolution instead.)
 */
function listRootMocks(root: string): Map<string, string> {
  const mocks = new Map<string, string>();
  const dir = path.join(root, "__mocks__");
  const add = (entryDir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(entryDir, { withFileTypes: true })) {
      if (entry.isDirectory() && prefix === "" && entry.name.startsWith("@")) {
        /* A scoped package's mock is one level down: __mocks__/@scope/pkg.js */
        add(path.join(entryDir, entry.name), `${entry.name}/`);
      } else if (entry.isFile()) {
        mocks.set(prefix + entry.name.replace(/\.[cm]?[jt]sx?$/, ""), path.join(entryDir, entry.name));
      }
    }
  };
  try {
    add(dir, "");
  } catch {
    /* No root __mocks__ directory: the ordinary case. */
  }
  return mocks;
}

/** node's CJS loader internals, as far as we reach into them. */
interface ILoaderModuleClass {
  _load(request: string, parent: ILoaderModule | undefined, isMain: boolean): unknown;
}

/**
 * Install both seams. Idempotent per process (each test file is its own
 * process, so this runs exactly once in practice).
 */
export function installSeams(registry: MockRegistry): void {
  installCommonJsSeam(registry);
  installEsmSeam(registry);
}

/**
 * The CommonJS seam. Consult the registry, then **delegate** — `_load` is
 * wrapped, not replaced, so everything node's loader does (ESM-only packages
 * via `require(esm)`, conditional exports, the cache) keeps working.
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
 * The ES-module seam. `module.registerHooks` is synchronous and in-thread, so
 * it fires for every ESM edge — including edges *inside* a package loaded via
 * `require(esm)`, and dynamic `import()`. A mocked specifier resolves to a
 * synthetic module whose source reads the same instance the CJS seam serves.
 *
 * The synthetic URL is stamped with the registry generation because node's ESM
 * module map is not evictable: a `resetModules` must yield a fresh module, and
 * a fresh URL is the only way to ask for one.
 */
function installEsmSeam(registry: MockRegistry): void {
  /* Reached dynamically: registerHooks postdates the @types/node fabr builds
   * against, and the host check has already established that it is there. */
  const { registerHooks } = Module as unknown as { registerHooks: (hooks: unknown) => void };
  registerHooks({
    resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => { url: string }): unknown {
      /* These hooks fire for `require` as well as `import`, so the registry's
       * OWN resolutions (keying a mock, finding the actual module behind one)
       * must pass straight through — otherwise looking a mock up would resolve
       * to the mock, without end. */
      if (bypassing > 0) {
        return nextResolve(specifier, context);
      }
      /* The runner's machinery is exempt from mocking on this seam too — the
       * same rule serve() applies to a CJS caller, judged here on the
       * importing module's URL. */
      const parent = (context as { parentURL?: string }).parentURL;
      if (parent !== undefined && parent.startsWith("file:") && isRunnerInternal(fileFromUrl(parent))) {
        return nextResolve(specifier, context);
      }
      /* Resolve FIRST and key on the answer. Asking the registry to resolve the
       * specifier here would re-enter this very hook; node has already done the
       * work, so use it. */
      let resolved: { url: string } | undefined;
      let failure: unknown;
      try {
        resolved = nextResolve(specifier, context);
      } catch (err) {
        failure = err;
      }
      const key = resolved?.url.startsWith("file:") ? fileFromUrl(resolved.url) : specifier;
      /* The URL carries whichever name the registry actually knows the mock
       * under: the resolved path normally, the bare specifier for a root
       * `__mocks__` entry or a virtual mock (both registered by name, which the
       * load hook's serve must be able to find again). */
      const mockKey = registry.hasMockFor(key) ? key : registry.hasMockFor(specifier) ? specifier : undefined;
      if (mockKey !== undefined) {
        return { url: mockUrl(registry, mockKey), shortCircuit: true };
      }
      if (resolved === undefined) {
        /* Nothing mocked it and it doesn't exist: node's own error, unaltered. */
        throw failure;
      }
      return resolved;
    },
    load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown): unknown {
      if (!url.startsWith(MOCK_SCHEME)) {
        return nextLoad(url, context);
      }
      const key = keyFromMockUrl(url);
      /* Force the instance into existence — published under this URL's own key
       * — before generating the module's face: its export names are what the
       * importing module links against, and an ESM edge may well be the first
       * thing to reach this mock. */
      registry.publishForEsm(key);
      return { format: "module", shortCircuit: true, source: syntheticModule(key) };
    },
  });
}

/**
 * Depth of "this resolution is the layer's own, not the program's". The hooks
 * are process-wide and fire for every edge, so the layer has to be able to step
 * outside them to ask questions about modules — which is what {@link
 * withoutHooks} marks.
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
 * Source for a mocked module's ESM face. The registration is hoisted above
 * every require, so the instance already exists here and its export names are
 * enumerable — which is what lets named imports link.
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

/** Export names must be valid identifiers to be re-exported by name; anything
 * else is still reachable through the default export. */
function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** The synthetic URL for a mocked key, stamped with the registration state —
 * see {@link MockRegistry.mockStamp}. */
function mockUrl(registry: MockRegistry, key: string): string {
  return `${MOCK_SCHEME}${registry.mockStamp}/${encodeURIComponent(key)}`;
}

/** The key a synthetic URL carries, the stamp dropped (it exists only to
 * defeat the ESM module map's caching, never to be read back). */
function keyFromMockUrl(url: string): string {
  return decodeURIComponent(url.slice(MOCK_SCHEME.length).replace(/^[\d-]+\//, ""));
}

/** Whether a module (by filename) is the runner's own machinery, which the
 * registry never mocks for — see the exemption in {@link MockRegistry.serve}. */
function isRunnerInternal(filename: string | undefined): boolean {
  return filename !== undefined && filename.startsWith(RUNNER_ROOT + path.sep);
}

function fileFromUrl(url: string): string {
  return path.normalize(decodeURIComponent(new URL(url).pathname));
}
