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
 * The two worlds this layer straddles, and how it reaches each.
 *
 * **The runner's own mount** holds jest's libraries — `jest-mock`, `expect`,
 * `jest-snapshot`, `@jest/fake-timers`, `jest-each` — taken from the pinned
 * `JEST` package's closure (plus `@swc/core`, the hoist's transform, pinned
 * apart as `SWC`). It is a sealed tool
 * install, resolved through a require anchored at this file, so it is
 * collision-free with the user's dependencies by construction: a test's own
 * `expect`, `chalk` or `pretty-format` coexists with jest's copies exactly as a
 * project's `typescript` coexists with `TSC`.
 *
 * **The test installation** (the process's cwd) holds what the target itself
 * declared. Only one thing is read from there — `jsdom`, which supplies the DOM
 * environment — and deliberately so: an environment is the *target's* choice
 * and pin, not the runner's.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

/** jest releases this layer is written against. Checked at startup: the layer
 * uses jest's libraries directly, so an untested major would fail obscurely
 * somewhere deep instead of saying what is wrong. */
const SUPPORTED_JEST_MAJORS = [29, 30];

/** `module.registerHooks` — the seam for intercepting ESM edges — is 22.15/23.5
 * and up, and node 20 is end-of-life. */
const MINIMUM_NODE = [22, 15] as const;

const fromRunner = createRequire(__filename);

/**
 * Load one of jest's libraries from the runner's own mount. Typed as `unknown`
 * on purpose: these are third-party modules fabr has no type information for,
 * and each caller narrows to the small surface it actually uses.
 */
export function jestLibrary(name: string): unknown {
  return fromRunner(name);
}

/**
 * Load a module from the TEST installation (the process's cwd) rather than the
 * runner's mount — how the DOM environment reaches jsdom, which the target
 * declares among its `test_deps`. Returns undefined if it isn't installed, so
 * the caller can say *which* dependency is missing and why it is wanted.
 */
export function userModule(name: string): unknown {
  try {
    return createRequire(path.join(process.cwd(), "index.js"))(name);
  } catch {
    return undefined;
  }
}

/**
 * Fail loudly, at startup, on a host or a jest release this layer does not
 * claim to support — rather than somewhere deep inside a mocked require, where
 * the real cause would be unrecoverable from the symptom.
 */
export function assertSupportedHost(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor < MINIMUM_NODE[1])) {
    throw new Error(
      `The jest compatibility runner needs node ${MINIMUM_NODE.join(".")} or later ` +
        `(this is ${process.versions.node}): it intercepts ES module edges via module.registerHooks.`
    );
  }
  const version = jestVersion();
  const jestMajor = Number(version?.split(".")[0]);
  if (!SUPPORTED_JEST_MAJORS.includes(jestMajor)) {
    throw new Error(
      `The jest compatibility runner supports jest ${SUPPORTED_JEST_MAJORS.join(" and ")}, but JEST is pinned to ` +
        `${version ?? "an unreadable version"}. Set JEST to a supported release.`
    );
  }
}

function jestVersion(): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(fromRunner.resolve("jest/package.json"), "utf8")) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

/**
 * Check that the requested environment can actually be provided, before any
 * test process is spawned. Only `jsdom` can fail: it comes from the target's
 * own dependencies, and saying which dependency is missing (and why it is
 * wanted) is far more use than a test child dying during its preload.
 */
export function requireEnvironment(env: string): void {
  if (env === "node") {
    return;
  }
  if (env !== "jsdom") {
    throw new Error(`Unknown test environment '${env}' — this runner provides 'node' and 'jsdom'.`);
  }
  if (userModule("jsdom") === undefined) {
    throw new Error(
      "These tests need a DOM environment (the target is built for the browser), but 'jsdom' is not among its dependencies.\n" +
        "Add it to the target's test_deps (e.g. test_deps = @npm:jsdom:26.1.0;), or build the target for node."
    );
  }
}

/**
 * Everything under this directory is the runner's own machinery, not the code
 * under test: the load-time hoist skips it (a dependency merely *containing*
 * the token `jest.mock` must never be fed through babel) and `resetModules`
 * leaves it cached (evicting the runner from under itself is not what a test
 * asked for).
 */
export const RUNNER_ROOT = path.dirname(__dirname);

/**
 * Whether a file is the code under test, as opposed to the runner's own
 * machinery or an installed dependency. Defined once because the hoist and
 * `resetModules` must agree on the boundary: the hoist transforms exactly the
 * code under test, and a reset evicts exactly the code under test — the two
 * drifting apart would be a subtle behavioural bug, not a style problem.
 */
export function isCodeUnderTest(root: string, filename: string): boolean {
  return (
    filename.startsWith(root + path.sep) &&
    !filename.includes(`${path.sep}node_modules${path.sep}`) &&
    !filename.startsWith(RUNNER_ROOT + path.sep)
  );
}
