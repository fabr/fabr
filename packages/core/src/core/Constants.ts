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

import * as fs from "fs";
import * as path from "path";
import { parseJson, toJsonObject } from "../support/Json";

/** The build file naming a project's root. */
export const PROJECT_FILENAME = "PROJECT.fabr";

/** The virtual build file a name given on fabr's command line is written in,
 *  in the invocation's directory. */
export const COMMAND_LINE_FILE = "<command-line>";

/** Fabr's own engine package: the one every plugin must share with the host. */
export const CORE_PACKAGE = "@fabr-build/core";

/**
 * @return the version of the fabr running: the one the `package.json` nearest
 * above this module (core's own) states, or undefined where it states none (a
 * build not yet published) or cannot be read.
 */
export function getVersion(): string | undefined {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      try {
        const { version } = parseJson(fs.readFileSync(file), file, toJsonObject);
        return typeof version === "string" ? version : undefined;
      } catch {
        return undefined;
      }
    }
    if (path.dirname(dir) === dir) {
      return undefined;
    }
  }
}

/** @return the version of the fabr running as output shows it: {@link getVersion}'s, else `0.0.0-dev`. */
export function getVersionString(): string {
  return getVersion() ?? "0.0.0-dev";
}
