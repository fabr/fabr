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
 * The filesystem tsserver is shown: the real one, with links laid over it. A
 * link names a virtual path that behaves as a symlink to a real one — reads and
 * stats of the link and of everything beneath it answer from its target, while
 * `realpath` keeps the link's own name — and a directory above a link exists
 * and lists the link's name beside its real entries.
 */

import type * as fs from "fs";
import * as path from "path";

/** The links laid over the filesystem: virtual path → real path, both absolute. */
export type Links = ReadonlyMap<string, string>;

/**
 * @return the real path `file` names through `links`, or undefined if it lies
 * under no link.
 */
export function linkedTarget(links: Links, file: string): string | undefined {
  for (let at = file; ; at = path.dirname(at)) {
    const target = links.get(at);
    if (target !== undefined) {
      return at === file ? target : path.join(target, path.relative(at, file));
    }
    if (path.dirname(at) === at) {
      return undefined;
    }
  }
}

/**
 * @return the names `links` add to directory `dir`: the next component of every
 * link beneath it.
 */
export function linkedChildren(links: Links, dir: string): string[] {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const names = new Set<string>();
  for (const link of links.keys()) {
    if (link.startsWith(prefix)) {
      names.add(link.slice(prefix.length).split(path.sep)[0]);
    }
  }
  return [...names].sort();
}

/**
 * Patch `target`'s functions tsserver reads the filesystem through so that they
 * answer through the links `current()` returns, read at each call, and a path
 * `masked` names is missing. Other paths under no link reach the real
 * functions unchanged.
 */
export function installOverlay(target: typeof fs, current: () => Links, masked: (file: string) => boolean = () => false): void {
  const exists = target.existsSync;
  const redirect = (file: unknown): unknown => (typeof file === "string" ? (linkedTarget(current(), file) ?? file) : file);
  for (const name of ["readFileSync", "openSync", "existsSync", "statSync", "lstatSync"] as const) {
    const real = target[name] as (...args: unknown[]) => unknown;
    (target as unknown as Record<string, unknown>)[name] = function (this: unknown, file: unknown, ...rest: unknown[]): unknown {
      if (typeof file === "string" && masked(file)) {
        if (name === "existsSync") {
          return false;
        }
        throw Object.assign(new Error(`ENOENT: no such file or directory, ${name} '${file}'`), {
          code: "ENOENT",
          errno: -2,
          syscall: name,
          path: file,
        });
      }
      const redirected = redirect(file);
      if (redirected === file && typeof file === "string" && impliedDirectory(current(), file)) {
        return implied(name, real, this, file, rest);
      }
      const result = real.call(this, redirected, ...rest);
      return (name === "statSync" || name === "lstatSync") && redirected !== file ? relinkedStats(file as string, result) : result;
    };
  }
  /* A watch of a linked path watches its target, and is told of the link's
   * own changes by {@link notifyRelinked}. */
  for (const name of ["watchFile", "watch"] as const) {
    const real = target[name] as (...args: unknown[]) => unknown;
    (target as unknown as Record<string, unknown>)[name] = function (this: unknown, file: unknown, ...rest: unknown[]): unknown {
      const linked = typeof file === "string" ? linkedTarget(current(), file) : undefined;
      const listener = rest.find(arg => typeof arg === "function") as ((...args: unknown[]) => void) | undefined;
      const result = real.call(this, linked ?? file, ...rest);
      if (linked !== undefined && listener !== undefined) {
        const watch: ILinkWatch = { kind: name, listener, watched: linked };
        const watchers = linkWatchers.get(file as string) ?? new Set();
        watchers.add(watch);
        linkWatchers.set(file as string, watchers);
        /* A watch closed is forgotten. */
        const watcher = result as { close?: () => void } | undefined;
        if (name === "watch" && typeof watcher?.close === "function") {
          const close = watcher.close.bind(watcher);
          watcher.close = (): void => {
            forgetWatch(file as string, watch);
            close();
          };
        }
      }
      return result;
    };
  }
  /* A linked path's file watches are of its target, so are ended there, and forgotten. */
  const unwatchFile = target.unwatchFile as (...args: unknown[]) => unknown;
  (target as unknown as Record<string, unknown>).unwatchFile = function (this: unknown, file: unknown, listener?: unknown): unknown {
    const watches =
      typeof file === "string"
        ? [...(linkWatchers.get(file) ?? [])].filter(
            watch => watch.kind === "watchFile" && (listener === undefined || watch.listener === listener)
          )
        : [];
    if (watches.length === 0) {
      return unwatchFile.call(this, file, listener);
    }
    for (const watch of watches) {
      forgetWatch(file as string, watch);
      unwatchFile.call(this, watch.watched, watch.listener);
    }
    return undefined;
  };
  const readdir = target.readdirSync as (...args: unknown[]) => unknown;
  (target as unknown as Record<string, unknown>).readdirSync = function (this: unknown, dir: unknown, ...rest: unknown[]): unknown {
    const redirected = redirect(dir);
    if (redirected !== dir || typeof dir !== "string") {
      return readdir.call(this, redirected, ...rest);
    }
    const extra = linkedChildren(current(), dir);
    const name = (entry: string | fs.Dirent): string => (typeof entry === "string" ? entry : entry.name);
    const unmasked = (entries: Array<string | fs.Dirent>): Array<string | fs.Dirent> =>
      entries.filter(entry => !masked(path.join(dir, name(entry))));
    if (extra.length === 0) {
      return unmasked(readdir.call(this, dir, ...rest) as Array<string | fs.Dirent>);
    }
    const options = rest[0];
    const withTypes =
      typeof options === "object" && options !== null && (options as { withFileTypes?: boolean }).withFileTypes === true;
    const real = exists(dir) ? unmasked(readdir.call(this, dir, ...rest) as Array<string | fs.Dirent>) : [];
    const have = new Set(real.map(name));
    const added = extra
      .filter(child => !have.has(child))
      .map(child => (withTypes ? direntOf(target, path.join(dir, child), child, current()) : child));
    return [...real, ...added];
  };
  for (const [owner, name] of [
    [target, "realpathSync"],
    [target.realpathSync, "native"],
  ] as const) {
    const real = (owner as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    /* A linked path keeps its own name, so tsserver names a served config, and
     * what lies beneath a link, by the path it is served at. */
    (owner as unknown as Record<string, unknown>)[name] = function (this: unknown, file: unknown, ...rest: unknown[]): unknown {
      if (typeof file === "string" && (linkedTarget(current(), file) !== undefined || impliedDirectory(current(), file))) {
        return file;
      }
      return real.call(this, file, ...rest);
    };
  }
}

/** When each repointed link was repointed, by path. */
const relinkedAt = new Map<string, number>();

/**
 * @return `stats` of a linked path, modified no earlier than the link was last
 * repointed: a link's change is a change of the path, whatever its new
 * target's own time.
 */
function relinkedStats(file: string, stats: unknown): unknown {
  const at = relinkedAt.get(file);
  const real = stats as fs.Stats | undefined;
  if (at === undefined || real === undefined || real.mtimeMs >= at) {
    return stats;
  }
  real.mtimeMs = at;
  real.mtime = new Date(at);
  return real;
}

/** A watch tsserver made of a linked path: how, its listener, and the path watched, the link's target when it was made. */
interface ILinkWatch {
  kind: "watchFile" | "watch";
  listener: (...args: unknown[]) => void;
  watched: string;
}

/** The watches tsserver made of linked paths and has not ended, by path. */
const linkWatchers = new Map<string, Set<ILinkWatch>>();

/** Forget `watch`, a watch of `file`. */
function forgetWatch(file: string, watch: ILinkWatch): void {
  const watchers = linkWatchers.get(file);
  watchers?.delete(watch);
  if (watchers?.size === 0) {
    linkWatchers.delete(file);
  }
}

/**
 * Tell the watches of every linked path whose target differs between
 * `previous` and `next` that the path changed.
 */
export function notifyRelinked(target: typeof fs, previous: Links, next: Links): void {
  const now = Date.now();
  for (const [link, to] of next) {
    if (previous.get(link) !== to) {
      relinkedAt.set(link, now);
    }
  }
  for (const [file, watchers] of linkWatchers) {
    const before = linkedTarget(previous, file);
    const after = linkedTarget(next, file);
    if (before === after) {
      continue;
    }
    for (const { kind, listener } of watchers) {
      if (kind === "watch") {
        listener(after === undefined ? "rename" : "change", path.basename(file));
      } else {
        const stats = (at: string | undefined): fs.Stats | undefined => {
          try {
            return at === undefined ? undefined : target.statSync(at);
          } catch {
            return undefined;
          }
        };
        const zero = { mtime: new Date(0), mtimeMs: 0 };
        listener(stats(after) === undefined ? zero : relinkedStats(file, stats(after)), stats(before) ?? zero);
      }
    }
  }
}

/** @return true if `dir` is a directory only because links lie beneath it, otherwise false. */
function impliedDirectory(links: Links, dir: string): boolean {
  return linkedTarget(links, dir) === undefined && linkedChildren(links, dir).length > 0;
}

/**
 * Answer `name` for `dir`, a directory links imply: it exists, and stats as
 * the nearest real directory above it, where it is not a real one itself.
 */
function implied(name: string, real: (...args: unknown[]) => unknown, self: unknown, dir: string, rest: unknown[]): unknown {
  if (name === "existsSync") {
    return true;
  }
  if (name !== "statSync" && name !== "lstatSync") {
    return real.call(self, dir, ...rest);
  }
  for (let at = dir; ; at = path.dirname(at)) {
    try {
      return real.call(self, at, ...rest);
    } catch (err) {
      if (path.dirname(at) === at) {
        throw err;
      }
    }
  }
}

/** @return a directory entry for `child` of a listing, as a link answers it. */
function direntOf(target: typeof fs, file: string, child: string, links: Links): fs.Dirent {
  const linked = linkedTarget(links, file);
  const stats = target.statSync(linked ?? path.dirname(file));
  const isDirectory = linked === undefined || stats.isDirectory();
  return {
    name: child,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as fs.Dirent;
}
