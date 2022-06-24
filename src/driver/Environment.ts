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
import * as fsPromises from "fs/promises";

export const PROJECT_FILENAME = "PROJECT.fabr";

/**
 * Walk up the source tree until we find the PROJECT.fabr file
 * that marks the top of the project.
 * @returns The absolute directory name.
 * @thorws Error if the file is not found.
 */
export async function findSourceRoot(): Promise<string> {
  let dir = process.cwd();
  for (;;) {
    try {
      await fsPromises.access(path.resolve(dir, PROJECT_FILENAME), fs.constants.R_OK);
      return dir;
    } catch (err) {
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw err;
      } else {
        dir = parent;
      }
    }
  }
}

export function getBuildCache(): string {
  return process.env.HOME ?? ".";
}
