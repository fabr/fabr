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
 * The `jest` object.
 *
 * Half of it is **adopted wholesale** from the libraries that implement it —
 * every public method of jest-mock's `ModuleMocker` (`fn`, `spyOn`, `mocked`,
 * the clear/reset/restore family) and of `@jest/fake-timers`' `ModernFakeTimers`
 * — bound and copied across rather than forwarded one by one. Copying is not
 * merely less code than 24 hand-written wrappers: it is more *faithful*.
 * Signatures cannot drift, and a member that a given jest release does not have
 * is simply absent here too, which is exactly what a test would see running
 * under that release of real jest (`jest.advanceTimersToNextFrame` on jest 29,
 * say). Hand-forwarding has to model those differences; adopting reproduces
 * them.
 *
 * The other half cannot be adopted, because no library implements it: the
 * module-registry operations (`mock`, `unmock`, `requireActual`,
 * `resetModules`, …) ARE the interface to the registry, and fabr owns the
 * registry — that is the whole point of the layer (see Registry.ts). Those are
 * written out below, along with the few members that need fabr behaviour.
 *
 * There is one object per *caller*, because `jest.mock('./x')` resolves
 * relative to the module that wrote it. The per-caller objects are handed out
 * through the `@jest/globals` interception (which is also what the hoisted
 * calls require); the plain `jest` global shares everything except that
 * resolution base, which is the test file's.
 */

import { ILoaderModule, MockRegistry } from "./Registry";

/** What this module needs of jest-mock's ModuleMocker by NAME; the rest of its
 * surface is adopted generically and needs no declaration here. */
export interface IMocker {
  getMetadata(component: unknown): unknown;
  generateFromMetadata(metadata: unknown): unknown;
}

/** Likewise @jest/fake-timers' ModernFakeTimers: only the member fabr overrides
 * and the teardown it drives are named. */
export interface IFakeTimers {
  useFakeTimers(config?: unknown): void;
  /** Restore the real timers/clock (uninstall). Not on the jest object (see
   * NOT_JEST_API) — the RUN calls it after the framework returns, because a
   * file whose last test leaves fake timers active would otherwise fake the
   * clock the run's own reporting reads (the fork used to absorb this by
   * exiting; the in-process path has no such luck). */
  dispose(): void;
}

/** The per-process machinery every `jest` object shares. */
export interface IJestEnvironment {
  registry: MockRegistry;
  mocker: IMocker;
  timers: IFakeTimers;
  /** The run's seed from the normalized jest config (`jest.getSeed`). */
  seed: number | undefined;
}

/*
 * Circus's own control channel. Real jest's runtime hands these values to
 * circus as `Symbol.for` globals (see jest-runtime's `retryTimes`/`setTimeout`)
 * and circus reads them off `globalThis` — which is the SAME global object
 * here, so assigning them is jest's real mechanism, not an imitation of it:
 * when a member is applied (per test, at describe entry) is circus's business
 * and identical by construction. A symbol a given circus release does not read
 * is simply inert, exactly as under that release of real jest.
 */
const TEST_TIMEOUT = Symbol.for("TEST_TIMEOUT_SYMBOL");
const RETRY_TIMES = Symbol.for("RETRY_TIMES");
const LOG_ERRORS_BEFORE_RETRY = Symbol.for("LOG_ERRORS_BEFORE_RETRY");
const WAIT_BEFORE_RETRY = Symbol.for("WAIT_BEFORE_RETRY");
const RETRY_IMMEDIATELY = Symbol.for("RETRY_IMMEDIATELY");

/** jest.retryTimes' options bag, as jest 30 declares it; circus 29 reads only
 * the count and the extra symbols sit inert, per the note above. */
interface IRetryOptions {
  logErrorsBeforeRetry?: boolean;
  waitBeforeRetry?: number;
  retryImmediately?: boolean;
}

const circusGlobals = globalThis as Record<symbol, unknown>;

/**
 * Public methods of the backing libraries that are NOT part of jest's `jest`
 * object: machinery fabr drives itself (the automock metadata pair, which
 * Registry.ts uses), and lifecycle jest never exposes. Everything else a
 * library declares is assumed to be API — the safer default, since a member
 * wrongly copied is an unused extra, while one wrongly withheld breaks a test
 * that works under jest.
 */
const NOT_JEST_API = new Set(["generateFromMetadata", "getMetadata", "clearMocksOnScope", "dispose", "reset"]);

/**
 * Build the `jest` object as seen by one module. `caller` is the module the
 * object was handed to, and is what module specifiers resolve against.
 */
export function makeJestObject(env: IJestEnvironment, caller: ILoaderModule | undefined): Record<string, unknown> {
  const { registry, timers } = env;
  const jest: Record<string, unknown> = {};

  /* Adopted: mock functions and spies, and the whole timer surface. */
  adopt(jest, env.mocker);
  adopt(jest, timers);

  /* jest's module operations return the `jest` object for chaining; each is
   * void here, so this discards the result and hands the object back. */
  const chain = (): Record<string, unknown> => jest;

  Object.assign(jest, {
    /* The module registry — fabr's own, so written out. `mock`/`unmock`/
     * `deepUnmock` are the hoisted forms (by the time they run, nothing they
     * affect has been required yet); `doMock`/`dontMock` are the un-hoisted
     * duals, taking effect for requires that follow. Both land in the same
     * registry: the difference is purely *when* they run, which is the hoist's
     * business, not this object's. */
    mock: (moduleName: string, factory?: () => unknown, options?: { virtual?: boolean }) =>
      (registry.setMock(moduleName, caller, factory, options?.virtual ?? false), chain()),
    doMock: (moduleName: string, factory?: () => unknown, options?: { virtual?: boolean }) =>
      (registry.setMock(moduleName, caller, factory, options?.virtual ?? false), chain()),
    unmock: (moduleName: string) => (registry.unmock(moduleName, caller), chain()),
    dontMock: (moduleName: string) => (registry.unmock(moduleName, caller), chain()),
    /* fabr has no module *tree* of its own to walk: a mock is keyed by the file
     * it resolves to, so unmocking one is already deep in the only sense that
     * matters here. */
    deepUnmock: (moduleName: string) => (registry.unmock(moduleName, caller), chain()),
    setMock: (moduleName: string, moduleExports: unknown) =>
      (registry.setMock(moduleName, caller, () => moduleExports, true), chain()),
    enableAutomock: () => (registry.setAutomockAll(true), chain()),
    disableAutomock: () => (registry.setAutomockAll(false), chain()),
    /* jest's own long-standing aliases for the pair above. */
    autoMockOn: () => (registry.setAutomockAll(true), chain()),
    autoMockOff: () => (registry.setAutomockAll(false), chain()),
    requireActual: (moduleName: string) => registry.requireActual(moduleName, caller),
    requireMock: (moduleName: string) => registry.requireMock(moduleName, caller),
    createMockFromModule: (moduleName: string) => registry.requireMock(moduleName, caller),
    /* Dropped by jest 30; still declared by the supported 29. */
    genMockFromModule: (moduleName: string) => registry.requireMock(moduleName, caller),
    resetModules: () => (registry.resetModules(), chain()),
    isolateModules: (fn: () => void) => (registry.isolateModules(fn), chain()),
    isolateModulesAsync: async (fn: () => Promise<void>) => {
      registry.resetModules();
      try {
        await fn();
      } finally {
        registry.resetModules();
      }
    },

    /* Overrides the adopted one: see withTimerDefaults for the one deliberate
     * divergence from jest's defaults. */
    useFakeTimers: (config?: unknown) => (timers.useFakeTimers(withTimerDefaults(config)), chain()),

    /* Circus applies these; the object only posts them on the control channel
     * above, exactly as jest-runtime does. */
    setTimeout: (ms: number) => ((circusGlobals[TEST_TIMEOUT] = ms), chain()),
    retryTimes: (count: number, options?: IRetryOptions) => {
      circusGlobals[RETRY_TIMES] = count;
      circusGlobals[LOG_ERRORS_BEFORE_RETRY] = options?.logErrorsBeforeRetry;
      circusGlobals[WAIT_BEFORE_RETRY] = options?.waitBeforeRetry;
      circusGlobals[RETRY_IMMEDIATELY] = options?.retryImmediately;
      return chain();
    },

    /* jest-config always generates one; its absence means the config path
     * changed under us, which must not read as a working seed of undefined. */
    getSeed: () => {
      if (env.seed === undefined) {
        throw new Error("jest.getSeed: the normalized jest config carries no seed");
      }
      return env.seed;
    },

    /* The process IS the environment here — there is no vm context to tear
     * down — so it is never torn down while a test is running. */
    isEnvironmentTornDown: () => false,

    /* Not implemented. Each is a real jest API, so each is present and THROWS:
     * left undefined they would surface as "is not a function", which reads
     * like a bug in the layer rather than a feature it does not have yet.
     * (Members a FUTURE jest may add are deliberately absent, so
     * `if (jest.newThing)` feature detection still behaves.) */
    onGenerateMock: notSupported("jest.onGenerateMock", "customizing generated automocks"),
    runAllImmediates: notSupported("jest.runAllImmediates", "it exists only for jest's legacy fake timers"),
    unstable_mockModule: notSupported("jest.unstable_mockModule", "ESM-mode mocking; tests compile to CommonJS here"),
    unstable_unmockModule: notSupported("jest.unstable_unmockModule", "ESM-mode mocking; tests compile to CommonJS here"),
  });
  return jest;
}

/**
 * Copy every public method of `source` onto `target`, bound to `source`. Walks
 * the prototype (these are class instances), skipping the constructor,
 * `_`-prefixed internals, and the {@link NOT_JEST_API} names.
 */
function adopt(target: Record<string, unknown>, source: object): void {
  const prototype = Object.getPrototypeOf(source) as object;
  const owner = source as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor" || name.startsWith("_") || NOT_JEST_API.has(name) || typeof owner[name] !== "function") {
      continue;
    }
    target[name] = (owner[name] as (...args: unknown[]) => unknown).bind(source);
  }
}

/**
 * Fake-timer defaults, with ONE deliberate divergence from jest's:
 * `setImmediate` and `process.nextTick` are not faked.
 *
 * This is a runner-correctness matter rather than a preference. There is no vm
 * sandbox here, so circus and the child's own IPC report back to the parent
 * run in the SAME realm as the test and schedule through the same
 * `setImmediate`/`nextTick` a test fakes; with the two faked, a test that
 * times out under fake timers fails *silently* — the timeout is never reported
 * and the run appears to stop. Excluding them restores the ordinary report
 * ("test timed out after Nms") and lets the following tests run. A test that
 * really wants them faked says so — `useFakeTimers({doNotFake: []})` — and
 * accepts the flush risk, which is documented.
 */
function withTimerDefaults(config: unknown): unknown {
  const given = (config ?? {}) as { doNotFake?: string[] };
  return { doNotFake: ["setImmediate", "nextTick"], ...given };
}

function notSupported(name: string, what: string): () => never {
  return () => {
    throw new Error(
      `${name} is not supported by fabr's jest compatibility layer yet (${what}). ` +
        "If you need it, say so — it is a missing feature, not a deliberate omission."
    );
  };
}
