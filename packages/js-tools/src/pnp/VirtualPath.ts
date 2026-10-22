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
 */

/**
 * PnP virtual paths (https://yarnpkg.com/advanced/pnp-spec, "Virtual
 * Packages"): `<base>/__virtual__/<hash>/<n>/<subpath>` names the file at
 * `dirname(<base>)`, stepped up `n` more times, then `<subpath>`. One real
 * directory can so be reached under several distinct paths, and a PnP table
 * tells its packages apart by path — which is how one content wired several
 * ways gets one row per wiring.
 *
 * The rule for every consumer: the virtual path IS the file's name (it is what
 * says which row a file belongs to); map it to the physical path only to touch
 * bytes.
 *
 * Runs inside the drivers, so it depends on nothing but node.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The path segment marking a virtual path. */
export const VIRTUAL_SEGMENT = "__virtual__";

/** Yarn's own pattern (VirtualFS): the base up to the first virtual segment,
 * then an optional hash (hex, optionally `<name>-` prefixed) and depth, then the
 * rest. */
const VIRTUAL_PATTERN = /^(\/(?:[^/]+\/)*?(?:\$\$virtual|__virtual__))((?:\/((?:[^/]+-)?[a-f0-9]+)(?:\/([^/]+))?)?((?:\/.*)?))$/;

/**
 * The physical path a (possibly) virtual path names — the path itself when it
 * has no virtual segment, or when the segment is malformed (as Yarn does).
 * Nested virtual segments resolve in turn.
 */
export function resolveVirtual(file: string): string {
  const match = VIRTUAL_PATTERN.exec(file);
  if (match === null || (!match[3] && match[5])) {
    return file;
  }
  const target = path.posix.dirname(match[1]);
  if (!match[3] || !match[4]) {
    return target;
  }
  if (!/^[0-9]+$/.test(match[4])) {
    return file;
  }
  const resolved = path.posix.join(target, "../".repeat(Number(match[4])), match[5] || ".");
  return resolved === file ? file : resolveVirtual(resolved);
}

/** Whether `file` is written through a virtual location. */
export function isVirtual(file: string): boolean {
  return resolveVirtual(file) !== file;
}

/** A virtual location over `physical`: `<pool>/__virtual__/<hash>/0/<name>`
 * for the directory `<pool>/<name>`. `hash` must be hex, which is what the
 * spec's readers accept. */
export function virtualLocation(physical: string, hash: string): string {
  return path.posix.join(path.posix.dirname(physical), VIRTUAL_SEGMENT, hash, "0", path.posix.basename(physical));
}

/**
 * `realpath` that keeps a virtual path virtual: the part before the virtual
 * segment is resolved, the rest kept as written — so a file reached through a
 * virtual location stays attributable to its row. A path with no virtual
 * segment is an ordinary realpath.
 */
export function realpathKeepingVirtual(file: string, realpath: (file: string) => string = fs.realpathSync): string {
  const at = file.indexOf(`/${VIRTUAL_SEGMENT}/`);
  if (at < 0) {
    return realpath(file);
  }
  return realpath(file.slice(0, at)) + file.slice(at);
}
