/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as fsPromises from "fs/promises";
import { FabrError, HOST, hostTriple, PROJECT_FILENAME } from "@fabr-build/core";

export const BUILD_CACHE_ENV = "FABR_CACHE_DIR";

/**
 * Find the project root: the nearest directory, from the cwd up, holding a
 * readable PROJECT.fabr.
 * @returns its absolute path.
 * @throws FabrError where no directory up to the filesystem root holds one.
 */
export async function getSourceRoot(): Promise<string> {
  let dir = process.cwd();
  for (;;) {
    try {
      await fsPromises.access(path.resolve(dir, PROJECT_FILENAME), fs.constants.R_OK);
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        /* Reached the filesystem root without finding a project marker. */
        throw new FabrError(`No ${PROJECT_FILENAME} found in ${process.cwd()} or any parent directory — is this a fabr project?`);
      } else {
        dir = parent;
      }
    }
  }
}

/**
 * @return the build cache's root directory, which may not exist yet:
 * `FABR_CACHE_DIR` where set, else `fabr` under the platform's cache directory.
 * Always absolute (a relative `FABR_CACHE_DIR` is resolved against the cwd), so
 * it stays valid for a program fabr launches in another directory.
 */
export function getBuildCacheRoot(): string {
  const explicitDir = process.env[BUILD_CACHE_ENV];
  if (explicitDir) {
    return path.resolve(explicitDir);
  } else {
    return path.resolve(getBaseCacheDir(), "fabr");
  }
}

/**
 * @return the platform's directory for application cache data:
 * `~/Library/Caches` on macOS, `LOCALAPPDATA` (or `APPDATA`) on Windows, else `XDG_CACHE_HOME`
 * or `~/.cache`.
 */
function getBaseCacheDir(): string {
  switch (os.platform()) {
    case "darwin":
      return path.resolve(os.homedir(), "Library/Caches");
    case "win32":
      return process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.resolve(os.homedir(), "AppData/Local");
    default:
      /* Assume anything else follows XDG conventions */
      return process.env.XDG_CACHE_HOME ?? path.resolve(os.homedir(), ".cache");
  }
}

/**
 * Get the constraints describing the host machine, which the driver gives every
 * configuration: `HOST`, its platform triple (`arm64-apple-macosx15.0`).
 */
export function getHostProperties(): Record<string, string> {
  return {
    [HOST]: hostTriple(),
  };
}
