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
 * A Playwright test's slots of fabr's process limit: where fabr runs the
 * Playwright run as a build step (`FABR_SOCKET`, the fabr socket and the
 * run's token), every test takes them before it starts, with its `beforeEach`
 * hooks and the fixtures it uses, and gives them back once those are torn
 * down. So a worker holds no slots between tests. `beforeAll` and `afterAll`
 * hooks, and a worker fixture's teardown, run without slots. Each worker
 * connects to the socket once, in a worker fixture. The fixtures are added to
 * `@playwright/test`'s `test`, so a suite's own fixtures, extended from it,
 * carry them too.
 */

import Module from "node:module";
import * as os from "node:os";
import { acquireSlots, connectFabrSocket, FABR_SOCKET_VARIABLE } from "../support/FabrSocket";

/** How many of fabr's process slots a test takes: its worker, and the browser it drives. */
export const SLOTS_PER_WORKER = 2;

/** The most workers a run starts where its tests take fabr's slots: as many as the machine's processors run at {@link SLOTS_PER_WORKER} slots each. */
export const MAX_WORKERS = Math.max(1, Math.floor(os.availableParallelism() / SLOTS_PER_WORKER));

/** Take a test's slots, waiting for them to be granted. @return a function that gives them back, or undefined where the test runs without slots. */
export type TakeSlots = () => Promise<(() => void) | undefined>;

/** The part of `@playwright/test` the slot is added to. */
interface IPlaywrightTest {
  test: { extend(fixtures: Record<string, unknown>): unknown };
  default?: unknown;
}

/**
 * Hold a test's slots, taken with `takeSlots`, while `use` runs the test,
 * and give them back once it ends, however it ends: the test fixture's body.
 */
export async function withTestSlots(takeSlots: TakeSlots, use: () => Promise<void>): Promise<void> {
  const release = await takeSlots();
  try {
    await use();
  } finally {
    release?.();
  }
}

/**
 * @return the fixtures that take each test's slots from the fabr socket
 * `address` names: `fabrSocket`, the worker's connection, as the function
 * taking a test's slots through it (none where the socket cannot be reached
 * or refuses), and `fabrProcessSlot`, the test's slots.
 */
export function processSlotFixtures(address: string): Record<string, unknown> {
  return {
    fabrSocket: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use: (takeSlots: TakeSlots) => Promise<void>) => {
        const client = await connectFabrSocket(address);
        try {
          await use(() => (client === undefined ? Promise.resolve(undefined) : acquireSlots(client, SLOTS_PER_WORKER)));
        } finally {
          client?.close();
        }
      },
      { scope: "worker", box: true },
    ],
    fabrProcessSlot: [
      ({ fabrSocket }: { fabrSocket: TakeSlots }, use: (value: undefined) => Promise<void>) =>
        withTestSlots(fabrSocket, () => use(undefined)),
      /* Waiting for slots is no part of the test's time. */
      { scope: "test", auto: true, timeout: 0, box: true },
    ],
  };
}

/**
 * @return the module `playwright` with its `test` and `default` replaced by
 * `test` extended with {@link processSlotFixtures}; where the module is
 * itself `test`, calling it and reading what `test` carries reach the
 * extended one too.
 */
export function withProcessSlot<T extends IPlaywrightTest>(playwright: T, address: string): T {
  const test = playwright.test.extend(processSlotFixtures(address));
  /* The module may itself be `test` (playwright's is, with the rest of its
   * exports on it): calling it, and what `test` carries (`extend`,
   * `describe`, the hooks), reach the extended one; the module's other
   * exports (`expect`, `devices`) stay its own. */
  return new Proxy(playwright, {
    get: (target, key, receiver) =>
      key === "test" || key === "default"
        ? test
        : key in (test as object)
          ? Reflect.get(test as object, key)
          : Reflect.get(target, key, receiver),
    apply: (_target, thisArg, args) => Reflect.apply(test as (...args: unknown[]) => unknown, thisArg, args),
    construct: (_target, args) => Reflect.construct(test as new (...args: unknown[]) => object, args),
  });
}

/** Make every load of `@playwright/test` in this process the module with the slot fixture, where fabr's socket is offered. */
export function installProcessSlot(): void {
  const address = process.env[FABR_SOCKET_VARIABLE];
  if (address === undefined || address === "") {
    return;
  }
  const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const load = loader._load;
  let extended: unknown;
  loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    const loaded = load.call(this, request, parent, isMain);
    if (request !== "@playwright/test") {
      return loaded;
    }
    extended ??= withProcessSlot(loaded as IPlaywrightTest, address);
    return extended;
  };
}
