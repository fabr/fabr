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
import { HOST, hostTriple } from "@fabr/core";

export const PROJECT_FILENAME = "PROJECT.fabr";
export const BUILD_CACHE_ENV = "FABR_CACHE_DIR";

/**
 * Walk up the source tree until we find the PROJECT.fabr file
 * that marks the top of the project.
 * @returns The absolute directory name.
 * @thorws Error if the file is not found.
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
        /* Reached the filesystem root without finding a project marker: report
         * the actual situation, not the raw `access` ENOENT on `/PROJECT.fabr`. */
        throw new Error(
          `No ${PROJECT_FILENAME} found in ${process.cwd()} or any parent directory — is this a fabr project?`
        );
      } else {
        dir = parent;
      }
    }
  }
}


/**
 * @return the root of our build cache (which may or may not exist at this point).
 */
export function getBuildCacheRoot(): string {
  const explicitDir = process.env[BUILD_CACHE_ENV];
  if (explicitDir) {
    return explicitDir;
  } else {
    return path.resolve(getBaseCacheDir(), "fabr");
  }
}

/**
 * @return the location in which we should stored 'cache' application data,
 * following platform conventions where possible.
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
 * The host machine facts injected as ambient constraints at every getConfig site.
 * A single HOST platform triple (`arm64-apple-macosx15.0`, …) — TARGET defaults to
 * it (STD.fabr) and consumers gate on TARGET; the npm/native mapping lives in
 * core's Platform helper. See DESIGN-target-triple.md.
 */
export function getHostProperties(): Record<string, string> {
  return {
    [HOST]: hostTriple(),
  };
}
