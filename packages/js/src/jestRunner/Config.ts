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
 * The jest configuration fabr synthesises for jest-circus.
 *
 * jest-circus reads a `ProjectConfig`/`GlobalConfig` — the normalized records
 * `jest-config` produces — for things like the test timeout, snapshot format
 * and `injectGlobals`. Those records are jest's internals and change shape every
 * release, so fabr does not build them: it states the handful of *documented*
 * config options it actually has an opinion about and lets `readConfig`
 * normalize them. That keeps fabr on jest's public schema (`InitialOptions`,
 * deprecation-cycled) rather than its private one.
 *
 * Note what is NOT set, and why: `transform` is empty because fabr already
 * compiled (the hoist is a load-time concern, see Hoist.ts), and `roots`/
 * `moduleDirectories` describe the staged installation fabr assembled. Nothing
 * here asks jest to resolve or transform anything — that is the boundary this
 * runner exists to hold.
 */

import * as path from "node:path";
import { jestLibrary } from "./Tools";

/** The shape `readConfig` returns; both records are opaque to fabr — they are
 * built here and handed to jest-circus unread. */
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
  /** `node` or `jsdom`; only the former is jest's own, so see Environment.ts. */
  env: string;
  /** Rewrite recorded snapshots rather than failing on a mismatch. */
  updateSnapshots: boolean;
  /** Per-test timeout in milliseconds. Circus enforces this itself, per test,
   * and honours a test's own override — which is why the runner no longer needs
   * a timeout of its own. */
  timeoutMs: number;
  /** What to preload, in order: a bare module name, or a `./`-prefixed path
   * within the installation. */
  setup: string[];
}

/**
 * Build the normalized jest config for a run. Fails loudly rather than falling
 * back on defaults: a config fabr cannot produce means the two sides disagree
 * about the installation, which is not something to paper over.
 */
export async function makeJestConfig(options: IConfigOptions): Promise<IJestConfig> {
  const { readConfig } = jestLibrary("jest-config") as IConfigModule;
  const initialOptions = {
    rootDir: options.root,
    roots: [options.root],
    /* Circus needs a testEnvironment to name; fabr installs its own globals
     * (see Environment.ts) and hands circus a facade, so this only has to be a
     * value jest-config accepts. */
    testEnvironment: "node",
    /* fabr compiled the tree already — there is nothing for jest to transform,
     * and asking it to would re-parse every module fabr just emitted. */
    transform: {},
    automock: false,
    injectGlobals: true,
    cache: false,
    moduleDirectories: ["node_modules"],
    /* Haste is Meta's module-naming scheme; fabr resolves by path. */
    haste: { enableSymlinks: false },
    /* A test file's records sit beside it, matched by stem — see
     * SnapshotResolver, which is jest's supported hook for exactly this. */
    snapshotResolver: path.join(__dirname, "SnapshotResolver.js"),
    testTimeout: options.timeoutMs,
    /* `setupFilesAfterEnv`, not `setupFiles`, for every entry: circus's adapter
     * loads these itself (through the runtime facade, so they see the mock
     * registry and the hoist like any other module), and jest's earlier
     * `setupFiles` phase has no counterpart here — the globals are installed
     * before circus is even entered, so there is nothing to run before them.
     * Local entries are absolute: jest-config resolves a non-absolute value as
     * a MODULE name, which is how a package entry passes through untouched. */
    setupFilesAfterEnv: options.setup.map(entry => (entry.startsWith("./") ? path.resolve(options.root, entry) : entry)),
  };
  const config = await readConfig({ _: [], $0: "" }, initialOptions, false, options.root);
  /* `updateSnapshot` lives on the GLOBAL config, which is jest's own normalized
   * record — set through the same channel jest's CLI uses rather than by
   * mutating a field name we would then have to track. */
  return {
    globalConfig: { ...config.globalConfig, updateSnapshot: options.updateSnapshots ? "all" : "none" },
    projectConfig: config.projectConfig,
  };
}
