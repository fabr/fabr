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
 * Loading modules from the two installs a test process has, and the checks on
 * them.
 *
 * - **The runner's install** holds jest's libraries (`jest-mock`, `expect`,
 *   `jest-snapshot`, `@jest/fake-timers`, `jest-each`, …), from the `JEST`
 *   package's closure, and `@swc/core` (`SWC`), resolved from this file, apart
 *   from the test's own dependencies.
 * - **The test installation** (the process's cwd) holds what the target
 *   declared. Only `jsdom` is loaded from it.
 *
 * It also says which a module's file is: the runner's own, the code under
 * test, or a module of the tests' registry.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJson, toJsonObject } from "../support/Json";
import { atLeastNode } from "../testRunner/RunTests";

/** The jest major versions supported, checked by {@link assertSupportedHost}. */
const SUPPORTED_JEST_MAJORS = [29, 30];

/** The lowest node version with `module.registerHooks`, which the ES module
 * seam uses. */
const MINIMUM_NODE = [22, 15] as const;

const fromRunner = createRequire(__filename);

/**
 * Load one of the runner's own declared dependencies, untyped: the caller
 * narrows it to the members it uses.
 */
export function runnerDependency(name: string): unknown {
  return fromRunner(name);
}

let fromJest: NodeJS.Require | undefined;

/**
 * Load one of jest's libraries, untyped, resolved as the runner's `jest`
 * package would resolve it.
 */
export function jestLibrary(name: string): unknown {
  fromJest ??= createRequire(fromRunner.resolve("jest/package.json"));
  return fromJest(name);
}

/**
 * Load a module from the test installation, resolved from the process's cwd.
 * @return the module, or undefined where it is not installed (or fails to
 *   load).
 */
export function userModule(name: string): unknown {
  try {
    return createRequire(path.join(process.cwd(), "index.js"))(name);
  } catch {
    return undefined;
  }
}

/** @return the file {@link userModule} loads for `name`, or undefined if it isn't installed. */
export function userModuleFile(name: string): string | undefined {
  try {
    return createRequire(path.join(process.cwd(), "index.js")).resolve(name);
  } catch {
    return undefined;
  }
}

/**
 * Check the host's node version (at least {@link MINIMUM_NODE}) and the
 * installed jest's major version (one of {@link SUPPORTED_JEST_MAJORS}),
 * throwing an error naming the requirement where either fails.
 */
export function assertSupportedHost(): void {
  if (!atLeastNode(MINIMUM_NODE[0], MINIMUM_NODE[1])) {
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
    const { version } = parseJson(
      fs.readFileSync(fromRunner.resolve("jest/package.json"), "utf8"),
      "jest's package.json",
      toJsonObject
    );
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check that the environment `env` can be provided: `node` always, `jsdom`
 * where the test installation has it. Throws for any other name, and for a
 * missing jsdom an error saying to add it to `test_deps`, worded for where the
 * environment was asked for (`fromDocblock`: the file's `@jest-environment`
 * docblock, else the target's `dom` flag).
 */
export function requireEnvironment(env: string, fromDocblock = false): void {
  if (env === "node") {
    return;
  }
  if (env !== "jsdom") {
    throw new Error(`Unknown test environment '${env}' — this runner provides 'node' and 'jsdom'.`);
  }
  if (userModuleFile("jsdom") === undefined) {
    throw new Error(
      fromDocblock
        ? "This test file asks for a DOM environment (its @jest-environment docblock), but 'jsdom' is not among the target's dependencies.\n" +
            "Add it to the target's test_deps (e.g. test_deps = @npm:jsdom:26.1.0;)."
        : "These tests need a DOM environment (the target declares the `dom` flag), but 'jsdom' is not among its dependencies.\n" +
            "Add it to the target's test_deps (e.g. test_deps = dom @npm:jsdom:26.1.0;), or drop the flag if the tests need no DOM."
    );
  }
}

/**
 * The directory the runner's own modules are compiled into.
 */
export const RUNNER_ROOT = path.dirname(__dirname);

/**
 * @return the install a module directory belongs to: the directory above the
 * first `node_modules` on its path, else `dir` itself.
 */
export function installRootOf(dir: string): string {
  const at = dir.indexOf(`${path.sep}node_modules${path.sep}`);
  return at < 0 ? dir : dir.slice(0, at);
}

/**
 * The runner's install, holding the runner and its dependencies, jest's
 * libraries among them. The hoist does not transform its modules, the registry
 * serves them no mock, and `resetModules` leaves them loaded.
 */
export const RUNNER_INSTALL = installRootOf(RUNNER_ROOT);

/**
 * @return true if a file is in the runner's install (see
 * {@link RUNNER_INSTALL}), otherwise false.
 */
export function isRunnerModule(filename: string, runnerInstall = RUNNER_INSTALL): boolean {
  return filename.startsWith(runnerInstall + path.sep);
}

/**
 * @return true if a file is the code under test (below `root`, outside any
 * `node_modules` and the runner's install), otherwise false: what the hoist
 * transforms.
 */
export function isCodeUnderTest(root: string, filename: string): boolean {
  return filename.startsWith(root + path.sep) && !filename.includes(`${path.sep}node_modules${path.sep}`) && !isRunnerModule(filename);
}

/**
 * @return true if a file is a module of the tests' registry, otherwise false:
 * every module bar the runner's install (`runnerInstall`) and native addons,
 * which node cannot load twice. These are what `resetModules` and
 * `isolateModules` load afresh, as jest's registry does.
 */
export function isRegistryModule(filename: string, runnerInstall = RUNNER_INSTALL): boolean {
  return !isRunnerModule(filename, runnerInstall) && path.extname(filename) !== ".node";
}
