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
 * The jest configuration handed to jest-circus: jest's documented options
 * (`InitialOptions`), normalized by `jest-config`'s `readConfig` into the
 * `GlobalConfig`/`ProjectConfig` records circus reads. Nothing in it asks jest
 * to resolve or transform a module: `transform` is empty, and `roots` and
 * `moduleDirectories` describe the staged installation.
 */

import * as path from "node:path";
import { jestLibrary } from "./Tools";

/** The normalized config, handed to jest-circus; `jest.getSeed` reads the
 * run's `seed` from `globalConfig`. */
export interface IJestConfig {
  globalConfig: Record<string, unknown>;
  projectConfig: Record<string, unknown>;
}

interface IConfigModule {
  readConfig(
    argv: unknown,
    packageRootOrConfig: unknown,
    skipArgvConfigOption?: boolean,
    parentConfigDirname?: string | null
  ): Promise<IJestConfig>;
}

export interface IConfigOptions {
  /** The staged test installation — jest's `rootDir`. */
  root: string;
  /** The test environment, `node` or `jsdom`. */
  env: string;
  /** Rewrite recorded snapshots rather than failing on a mismatch. */
  updateSnapshots: boolean;
  /** The regular expression selecting the tests run by full name, if any —
   * jest's `testNamePattern`, which circus matches case-insensitively. */
  namePattern?: string;
  /** The per-test timeout in milliseconds, which a test's own timeout
   * overrides. */
  timeoutMs: number;
  /** What to preload, in order: a bare module name, or a `./`-prefixed path
   * within the installation. */
  setup: string[];
}

/**
 * Make the normalized jest config for a run. The setup entries become
 * `setupFilesAfterEnv`, and `updateSnapshot` (`all` or `none`) and
 * `testNamePattern` are set on the global config, where jest's CLI sets them.
 * Rejects where jest-config refuses the options.
 */
export async function makeJestConfig(options: IConfigOptions): Promise<IJestConfig> {
  const { readConfig } = jestLibrary("jest-config") as IConfigModule;
  const initialOptions = {
    rootDir: options.root,
    roots: [options.root],
    /* Any value jest-config accepts: the environment is installed by
     * Environment.ts, not by jest. */
    testEnvironment: "node",
    transform: {},
    automock: false,
    injectGlobals: true,
    cache: false,
    moduleDirectories: ["node_modules"],
    haste: { enableSymlinks: false },
    /* Names a compiled test file's snapshots after its source. */
    snapshotResolver: path.join(__dirname, "SnapshotResolver.js"),
    testTimeout: options.timeoutMs,
    /* Circus loads these through the runtime facade, so they see the mock
     * registry and the hoist. Make a local entry absolute: jest-config resolves
     * any other value as a module name. */
    setupFilesAfterEnv: options.setup.map(entry => (entry.startsWith("./") ? path.resolve(options.root, entry) : entry)),
  };
  const config = await readConfig({ _: [], $0: "" }, initialOptions, false, options.root);
  return {
    globalConfig: {
      ...config.globalConfig,
      updateSnapshot: options.updateSnapshots ? "all" : "none",
      ...(options.namePattern === undefined ? {} : { testNamePattern: options.namePattern }),
    },
    projectConfig: config.projectConfig,
  };
}
