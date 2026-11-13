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
 * `<base>`, stepped up `n` times, then `<subpath>`. One real directory can be
 * reached under several paths, so a package's content wired several ways has a
 * PnP row per wiring, each at its own virtual location.
 *
 * Treat the virtual path as the file's name, since it says which row the file
 * belongs to; map it to the physical path only to read or stat the file.
 *
 * Each function takes a path as the host or a tool spells it (on Windows
 * `C:\x\__virtual__\…`, TypeScript's `C:/x/__virtual__/…`, a share
 * `\\server\share\…`) and answers in the spelling it was given; the optional
 * `host` is the host's path functions, which a test passes as `path.win32`.
 *
 * Runs inside the drivers, so it depends on nothing but node.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The path segment marking a virtual path. */
export const VIRTUAL_SEGMENT = "__virtual__";

/** The tree pool's link, relative to the working directory of a staged step;
 * must equal core's TREE_MOUNT. */
export const TREE_LINK = "../.fabr-tree";

/** Yarn's pattern (VirtualFS): the base up to the first virtual segment, then
 * an optional hash (hex, optionally `<name>-` prefixed) and depth, then the
 * rest. */
const VIRTUAL_PATTERN = /^(\/(?:[^/]+\/)*?(?:\$\$virtual|__virtual__))((?:\/((?:[^/]+-)?[a-f0-9]+)(?:\/([^/]+))?)?((?:\/.*)?))$/;

/**
 * @return the physical path a (possibly) virtual path names — the path itself
 * when it has no virtual segment, or when the segment is malformed (as Yarn
 * does). Nested virtual segments resolve in turn.
 */
export function resolveVirtual(file: string, host: path.PlatformPath = path): string {
  return inPosixForm(file, resolvePosixVirtual, host);
}

/** Resolve `file`, `/`-separated and absolute with no Windows root, as {@link resolveVirtual} does. */
function resolvePosixVirtual(file: string): string {
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
  return resolved === file ? file : resolvePosixVirtual(resolved);
}

/** @return true if `file` is written through a virtual location, otherwise
 * false. */
export function isVirtual(file: string, host: path.PlatformPath = path): boolean {
  return resolveVirtual(file, host) !== file;
}

/** @return a virtual location over `physical`:
 * `<pool>/__virtual__/<hash>/0/<name>` for the directory `<pool>/<name>`.
 * `hash` must be hex, as Yarn's pattern requires. */
export function virtualLocation(physical: string, hash: string, host: path.PlatformPath = path): string {
  return inPosixForm(
    physical,
    posix => path.posix.join(path.posix.dirname(posix), VIRTUAL_SEGMENT, hash, "0", path.posix.basename(posix)),
    host
  );
}

/**
 * Resolve `file` as `realpath` does, keeping a virtual path virtual: the part
 * before the virtual segment is resolved and the rest kept as written. A path
 * with no virtual segment gets an ordinary realpath.
 */
export function realpathKeepingVirtual(
  file: string,
  realpath: (file: string) => string = fs.realpathSync,
  host: path.PlatformPath = path
): string {
  const { root, rest } = splitRoot(file, host);
  const at = rest.indexOf(`/${VIRTUAL_SEGMENT}/`);
  if (at < 0) {
    return realpath(file);
  }
  /* `rest` is as long as the part of `file` after its root; a drive alone
   * (`C:`) names its current directory, so its root keeps its separator. */
  const base = at === 0 ? file.slice(0, root.length + 1) : file.slice(0, root.length + at);
  return realpath(base) + file.slice(base.length);
}

/** A path's root as Windows spells it: a drive (`C:`) or a share (`\\server\share`), with either separator. */
const WINDOWS_ROOT = /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

/** Split `file` into its Windows root, where `host` is Windows and it has one, and the rest, `/`-separated. */
function splitRoot(file: string, host: path.PlatformPath): { root: string; rest: string } {
  if (host.sep === "/") {
    return { root: "", rest: file };
  }
  const root = WINDOWS_ROOT.exec(file)?.[0] ?? "";
  return { root, rest: file.slice(root.length).split("\\").join("/") };
}

/**
 * @return `compute` of `file` without its Windows root and `/`-separated, put
 * back into the spelling `file` was written in: its root, and `\` where it
 * used that. `file` itself where `compute` changes nothing.
 */
function inPosixForm(file: string, compute: (posix: string) => string, host: path.PlatformPath): string {
  const { root, rest } = splitRoot(file, host);
  const computed = compute(rest);
  if (computed === rest) {
    return file;
  }
  return root + (host.sep !== "/" && file.includes("\\") ? computed.split("/").join("\\") : computed);
}
