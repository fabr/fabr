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
 * A Playwright worker's slots of fabr's process limit: where fabr runs the
 * Playwright run as a build step (`FABR_SOCKET`, the fabr socket and the
 * run's token), every worker takes them before its first test and holds them
 * until it exits. They are taken by a worker-scoped auto fixture added to
 * `@playwright/test`'s `test`, so a suite's own fixtures, extended from it,
 * carry it too.
 */

import Module from "node:module";
import { acquireSlots, connectFabrSocket, FABR_SOCKET_VARIABLE, FabrSocketClient } from "../support/FabrSocket";

/** How many of fabr's process slots a worker takes: itself, and the browser it drives. */
export const SLOTS_PER_WORKER = 2;

/** The part of `@playwright/test` the slot is added to. */
interface IPlaywrightTest {
  test: { extend(fixtures: Record<string, unknown>): unknown };
  default?: unknown;
}

/**
 * Take a worker's slots from the fabr socket `variable` names
 * ({@link SLOTS_PER_WORKER} of them), waiting for them to be granted.
 * @return the connection holding them, which gives them back as it closes; or
 *   undefined where the socket cannot be reached or refuses, and the worker
 *   runs without slots of its own.
 */
export function takeProcessSlot(variable: string): Promise<FabrSocketClient | undefined> {
  return connectFabrSocket(variable).then(client =>
    client === undefined
      ? undefined
      : acquireSlots(client, SLOTS_PER_WORKER).then(release => {
          if (release === undefined) {
            client.close();
            return undefined;
          }
          return client;
        })
  );
}

/**
 * @return the module `playwright` with its `test` and `default` replaced by
 * `test` extended with the slot fixture, which takes slots from the fabr
 * socket `address` names; where the module is itself `test`, calling it and
 * reading what `test` carries reach the extended one too.
 */
export function withProcessSlot<T extends IPlaywrightTest>(playwright: T, address: string): T {
  const test = playwright.test.extend({
    fabrProcessSlot: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use: (value: undefined) => Promise<void>) => {
        const slot = await takeProcessSlot(address);
        try {
          await use(undefined);
        } finally {
          slot?.close();
        }
      },
      /* Waiting for a slot is no part of any test's time. */
      { scope: "worker", auto: true, timeout: 0, box: true },
    ],
  });
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
