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
 * Spelling the host's paths with `/`, as names are: on Windows `C:\Users\x` is
 * `C:/Users/x`. The same conversion as `@fabr-build/core`'s, which the tools
 * must not load.
 */

import * as path from "node:path";

/**
 * Make `hostPath`, a path as the host spells it, `/`-separated: unchanged on
 * POSIX, each `\` a `/` on Windows.
 *
 * @param host the host's path functions; a test passes `path.win32`.
 */
export function toPosix(hostPath: string, host: path.PlatformPath = path): string {
  return host.sep === "/" ? hostPath : hostPath.split(host.sep).join("/");
}

/** @return the path from `from` to `to`, both host paths, `/`-separated. */
export function posixRelative(from: string, to: string): string {
  return toPosix(path.relative(from, to));
}
