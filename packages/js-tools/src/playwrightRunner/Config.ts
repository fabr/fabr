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
 * The config an invocation of the Playwright runner runs with, made where
 * Playwright loads it, in the runner's process and in each worker: the
 * project's own config, compiled, wrapped for the invocation
 * ({@link wrapConfig}). The module generated for the invocation calls
 * {@link wrappedConfig} with its settings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { INSTALL_MOUNTS, sourcePathOf } from "../testRunner/Report";
import { FilePattern, IInvocation, IPlaywrightConfig, wrapConfig } from "./PlaywrightRun";

/** The settings the runner writes into the invocation's config module. */
export interface IConfigSettings extends Omit<IInvocation, "sourceOf" | "matcher" | "exists"> {
  /** The project's compiled config, if it has one. */
  config?: string;
  /** Playwright's `lib/util` module, from the test installation. */
  util: string;
}

/** Make the invocation's config from `settings`. */
export function wrappedConfig(settings: IConfigSettings): IPlaywrightConfig {
  const { config, util, ...invocation } = settings;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const user = config === undefined ? {} : defaultExport(require(config) as unknown);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFileMatcher } = require(util) as { createFileMatcher(patterns: FilePattern): (file: string) => boolean };
  const srcRoot = path.join(path.dirname(invocation.configDir), INSTALL_MOUNTS[0]);
  return wrapConfig(user, {
    ...invocation,
    sourceOf: compiled => {
      const source = sourcePathOf(compiled);
      const relative = source === undefined ? undefined : path.relative(srcRoot, source);
      return relative === undefined || relative.startsWith("..") || path.isAbsolute(relative)
        ? compiled
        : path.join(invocation.configDir, relative);
    },
    matcher: createFileMatcher,
    exists: file => fs.existsSync(file),
  });
}

/** @return a module's default export, where it has one, else the module. */
function defaultExport(loaded: unknown): IPlaywrightConfig {
  const module = loaded as { default?: unknown; __esModule?: boolean };
  return ((module !== null && typeof module === "object" && "default" in module ? module.default : module) ?? {}) as IPlaywrightConfig;
}
