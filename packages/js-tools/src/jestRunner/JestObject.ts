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
 * The `jest` object. Every public method of jest-mock's `ModuleMocker` (`fn`,
 * `spyOn`, `mocked`, the clear/reset/restore family) is copied onto it, bound,
 * and every public method of `@jest/fake-timers`' `ModernFakeTimers` and
 * `LegacyFakeTimers` forwards to the one `useFakeTimers` last chose, so a
 * member the installed jest release lacks is absent here too
 * (`jest.advanceTimersToNextFrame` on jest 29).
 * The module-registry operations (`mock`, `unmock`, `requireActual`,
 * `resetModules`, …) are written out over fabr's registry (Registry.ts).
 *
 * There is one object per calling module, since `jest.mock('./x')` resolves
 * relative to the module that wrote it. The registry hands them out through
 * `@jest/globals`, which the hoisted calls require; the `jest` global resolves
 * relative to the test file.
 */

import { ILoaderModule, MockRegistry } from "./Registry";

/** The members of jest-mock's ModuleMocker called by name; the rest are copied
 * onto the `jest` object unnamed. */
export interface IMocker {
  getMetadata(component: unknown): unknown;
  generateFromMetadata(metadata: unknown): unknown;
}

/** The members of @jest/fake-timers' ModernFakeTimers and LegacyFakeTimers
 * called by name. */
export interface IFakeTimers {
  useFakeTimers(config?: unknown): void;
  useRealTimers(): void;
  /** Restore the real timers and clock. Not on the jest object: the run calls
   * it once circus returns, so a file whose last test leaves fake timers
   * installed does not fake the clock the run's reporting reads. */
  dispose(): void;
}

/** jest's two fake timer implementations, and the one `jest.useFakeTimers`
 * last chose, which the `jest` object's timer methods call. */
export interface ITimers {
  modern: IFakeTimers;
  legacy: IFakeTimers;
  current: IFakeTimers;
}

/** The per-process machinery every `jest` object shares. */
export interface IJestEnvironment {
  registry: MockRegistry;
  mocker: IMocker;
  timers: ITimers;
  /** The run's seed from the normalized jest config (`jest.getSeed`). */
  seed: number | undefined;
  /** The installed jest's major version, for the members only some releases have. */
  jestMajor: number;
}

/*
 * The `Symbol.for` globals jest-runtime sets for `jest.setTimeout` and
 * `jest.retryTimes`, which circus reads off `globalThis` and applies itself. A
 * symbol the installed circus does not read has no effect, as under jest.
 */
const TEST_TIMEOUT = Symbol.for("TEST_TIMEOUT_SYMBOL");
const RETRY_TIMES = Symbol.for("RETRY_TIMES");
const LOG_ERRORS_BEFORE_RETRY = Symbol.for("LOG_ERRORS_BEFORE_RETRY");
const WAIT_BEFORE_RETRY = Symbol.for("WAIT_BEFORE_RETRY");
const RETRY_IMMEDIATELY = Symbol.for("RETRY_IMMEDIATELY");

/** jest.retryTimes' options, as jest 30 declares them; circus 29 reads only the
 * count. */
interface IRetryOptions {
  logErrorsBeforeRetry?: boolean;
  waitBeforeRetry?: number;
  retryImmediately?: boolean;
}

const circusGlobals = globalThis as Record<symbol, unknown>;

/**
 * Public methods of ModuleMocker and the fake timers that are not on jest's
 * `jest` object: the automock metadata pair Registry.ts calls, and lifecycle
 * jest does not expose. Every other public method is copied.
 */
const NOT_JEST_API = new Set(["generateFromMetadata", "getMetadata", "clearMocksOnScope", "dispose", "reset", "runWithRealTimers"]);

/**
 * Make the `jest` object for one module. Module specifiers given to it resolve
 * relative to `caller`, or to the test file where `caller` is undefined.
 */
export function makeJestObject(env: IJestEnvironment, caller: ILoaderModule | undefined): Record<string, unknown> {
  const { registry, timers } = env;
  const jest: Record<string, unknown> = {};

  /* Mock functions and spies, and the timer methods. */
  adopt(jest, env.mocker);
  adoptTimers(jest, timers);

  /* Get the `jest` object, which jest's module operations return for
   * chaining. */
  const chain = (): Record<string, unknown> => jest;

  Object.assign(jest, {
    /* The module registry. `mock` and `doMock` do the same here, as do
     * `unmock` and `dontMock`: the hoist moves only the first of each. */
    mock: (moduleName: string, factory?: () => unknown, options?: { virtual?: boolean }) => (
      registry.setMock(moduleName, caller, factory, options?.virtual ?? false),
      chain()
    ),
    doMock: (moduleName: string, factory?: () => unknown, options?: { virtual?: boolean }) => (
      registry.setMock(moduleName, caller, factory, options?.virtual ?? false),
      chain()
    ),
    unmock: (moduleName: string) => (registry.unmock(moduleName, caller), chain()),
    dontMock: (moduleName: string) => (registry.unmock(moduleName, caller), chain()),
    /* The same as `unmock`: a mock is keyed by the file it resolves to. */
    deepUnmock: (moduleName: string) => (registry.unmock(moduleName, caller), chain()),
    setMock: (moduleName: string, moduleExports: unknown) => (
      registry.setMock(moduleName, caller, () => moduleExports, true),
      chain()
    ),
    enableAutomock: () => (registry.setAutomockAll(true), chain()),
    disableAutomock: () => (registry.setAutomockAll(false), chain()),
    /* jest's aliases for the pair above. */
    autoMockOn: () => (registry.setAutomockAll(true), chain()),
    autoMockOff: () => (registry.setAutomockAll(false), chain()),
    requireActual: (moduleName: string) => registry.requireActual(moduleName, caller),
    requireMock: (moduleName: string) => registry.requireMock(moduleName, caller),
    createMockFromModule: (moduleName: string) => registry.createMockFromModule(moduleName, caller),
    /* jest 29's alias, removed in 30. */
    ...(env.jestMajor < 30 ? { genMockFromModule: (moduleName: string) => registry.createMockFromModule(moduleName, caller) } : {}),
    resetModules: () => (registry.resetModules(), chain()),
    isolateModules: (fn: () => void) => (registry.isolateModules(fn), chain()),
    isolateModulesAsync: (fn: () => Promise<void>) => registry.isolateModulesAsync(fn),

    /* Choose the implementation, as jest-runtime does, restoring the real
     * timers from the other first: under jest they share the test's window
     * alone, here they share the runner's global object, whose timers each
     * would otherwise leave faked or delete. */
    useFakeTimers: (config?: { legacyFakeTimers?: boolean }) => {
      const next = config?.legacyFakeTimers ? timers.legacy : timers.modern;
      if (next !== timers.current) {
        timers.current.useRealTimers();
        timers.current = next;
      }
      next.useFakeTimers(next === timers.modern ? config : undefined);
      return chain();
    },
    useRealTimers: () => (timers.current.useRealTimers(), chain()),

    /* Set the globals circus reads, as jest-runtime does. */
    setTimeout: (ms: number) => ((circusGlobals[TEST_TIMEOUT] = ms), chain()),
    retryTimes: (count: number, options?: IRetryOptions) => {
      circusGlobals[RETRY_TIMES] = count;
      circusGlobals[LOG_ERRORS_BEFORE_RETRY] = options?.logErrorsBeforeRetry;
      circusGlobals[WAIT_BEFORE_RETRY] = options?.waitBeforeRetry;
      circusGlobals[RETRY_IMMEDIATELY] = options?.retryImmediately;
      return chain();
    },

    /* jest-config always generates a seed: throw where there is none. */
    getSeed: () => {
      if (env.seed === undefined) {
        throw new Error("jest.getSeed: the normalized jest config carries no seed");
      }
      return env.seed;
    },

    /* The environment is the process, never torn down while a test runs. */
    isEnvironmentTornDown: () => false,

    /* jest API not implemented here: present, and throws saying so. A member
     * jest does not have is left absent, so feature detection works. */
    onGenerateMock: notSupported("jest.onGenerateMock", "customizing generated automocks"),
    unstable_mockModule: notSupported("jest.unstable_mockModule", "ESM-mode mocking; tests compile to CommonJS here"),
    unstable_unmockModule: notSupported("jest.unstable_unmockModule", "ESM-mode mocking; tests compile to CommonJS here"),
  });
  return jest;
}

/**
 * Copy every public method on `source`'s prototype onto `target`, bound to
 * `source`, skipping the constructor, `_`-prefixed names and the
 * {@link NOT_JEST_API} names.
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
 * Give `target` each public timer method of the modern and legacy fake timers,
 * calling it on the implementation `timers.current` names, or throwing jest's
 * TypeError where that one lacks it (`jest.setSystemTime` under legacy timers,
 * `jest.runAllImmediates` under modern ones).
 */
function adoptTimers(target: Record<string, unknown>, timers: ITimers): void {
  const names = new Set<string>();
  for (const implementation of [timers.modern, timers.legacy]) {
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(implementation) as object)) {
      if (name !== "constructor" && !name.startsWith("_") && !NOT_JEST_API.has(name)) {
        names.add(name);
      }
    }
  }
  for (const name of names) {
    target[name] = (...args: unknown[]): unknown => {
      const current = timers.current as unknown as Record<string, unknown>;
      const method = current[name];
      if (typeof method !== "function") {
        throw new TypeError(
          timers.current === timers.legacy
            ? `\`jest.${name}()\` is not available when using legacy fake timers.`
            : `\`jest.${name}()\` is only available when using legacy fake timers.`
        );
      }
      return (method as (...a: unknown[]) => unknown).apply(current, args);
    };
  }
}

function notSupported(name: string, what: string): () => never {
  return () => {
    throw new Error(
      `${name} is not supported by fabr's jest compatibility layer yet (${what}). ` +
        "If you need it, say so — it is a missing feature, not a deliberate omission."
    );
  };
}
