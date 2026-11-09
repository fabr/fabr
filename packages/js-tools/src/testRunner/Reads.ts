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
 * What a test process read: the runner contract's `--reads` document
 * ({@link IReadsDocument}), from which the test step decides which test files a
 * change can reach. Every module the process loaded, the `package.json` nearest
 * each, every file it read or probed through `fs` (a probe that found a
 * directory named with a trailing `/`), and every package it looked up by a
 * bare specifier, found or not. A directory listing is not recorded. Where the
 * process did what no record can follow — started another process or a worker
 * thread, whose reads are its own — there is no document, and the step runs
 * the file again on every change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as nodeModule from "node:module";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { splitSpecifier } from "../pnp/PnPResolver";
import { resolveVirtual } from "../pnp/VirtualPath";
import { ILookup, IReadsDocument, toReadsDocument } from "./ReadsDocument";

/* The functions this recorder uses for itself, taken before it wraps them. */
const { existsSync, realpathSync, statSync } = fs;

type AnyFunction = (...args: unknown[]) => unknown;

/** The `fs` functions that read a file, its content or its metadata, or probe
 * for it, by the path given first; `open` is among them only for reading (see
 * {@link opensForReading}). */
const READERS = [
  "readFileSync",
  "readFile",
  "createReadStream",
  "statSync",
  "stat",
  "lstatSync",
  "lstat",
  "existsSync",
  "accessSync",
  "access",
  "realpathSync",
  "realpath",
  "readlinkSync",
  "readlink",
  "copyFileSync",
  "copyFile",
  "cpSync",
  "cp",
  "openAsBlob",
] as const;
const PROMISE_READERS = ["readFile", "stat", "lstat", "access", "realpath", "readlink", "copyFile", "cp"] as const;
const OPENERS = ["openSync", "open"] as const;

/** The `child_process` functions that start a process. */
const SPAWNERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/** What a process has read so far. */
interface IRecording {
  loaded: Set<string>;
  read: Set<string>;
  /** Each lookup by the file that asked and the package name, to the absolute
   *  path that answered, or null where nothing did. */
  lookups: Map<string, string | null>;
  untracked: boolean;
}

/** What a process read, every path absolute. */
export interface IRecordedReads {
  files: string[];
  lookups: ILookup[];
}

/**
 * Start recording what this process reads, and return how to collect it: the
 * absolute paths of every module loaded, from start-up on, of every file read
 * or probed through `fs` since, by its real path, and every package looked up
 * by a bare specifier; or undefined where the process has since started
 * another process or a worker thread.
 */
export function recordReads(): () => IRecordedReads | undefined {
  const current: IRecording = { loaded: new Set(), read: new Set(), lookups: new Map(), untracked: false };
  wrapReaders(current.read);
  wrapStarters(current);
  wrapLoaders(current.loaded);
  wrapLookups(current.lookups);
  const cache = createRequire(__filename).cache;
  /* A module is loaded by its real path already. A file read through `fs` may
   * be named through a link — a `node_modules` one — so its directory is
   * resolved, once per directory. */
  const realDirectories = new Map<string, string>();
  const realPathOf = (file: string): string => {
    const directory = path.dirname(file);
    let real = realDirectories.get(directory);
    if (real === undefined) {
      try {
        real = realpathSync(directory);
      } catch {
        real = directory;
      }
      realDirectories.set(directory, real);
    }
    return path.join(real, path.basename(file));
  };
  /* Node reads a package's `package.json` (`main`, `exports`, `type`) through
   * no `fs` function, so the nearest one above each module is recorded with it. */
  const manifests = new Map<string, string | undefined>();
  const manifestOf = (directory: string): string | undefined => {
    if (manifests.has(directory)) {
      return manifests.get(directory);
    }
    const here = path.join(directory, "package.json");
    const parent = path.dirname(directory);
    const found = existsSync(here) ? here : parent === directory ? undefined : manifestOf(parent);
    manifests.set(directory, found);
    return found;
  };
  return () => {
    if (current.untracked) {
      return undefined;
    }
    const modules = [...current.loaded, ...Object.keys(cache)];
    /* A module at a virtual location is probed for its manifest at the
     * physical one, where the files are; the step names a read either way. */
    const nearest = modules.flatMap(module => manifestOf(path.dirname(resolveVirtual(module))) ?? []);
    const lookups = [...current.lookups].map(([key, to]): ILookup => {
      const [from, name] = key.split("\0");
      return to === null ? { from, name } : { from, name, to };
    });
    return { files: [...modules, ...nearest, ...[...current.read].map(realPathOf).map(markDirectory)], lookups };
  };
}

/** @return `file` with a trailing separator where it is a directory now, else as it is. */
function markDirectory(file: string): string {
  try {
    return statSync(file).isDirectory() ? file + path.sep : file;
  } catch {
    return file;
  }
}

/** A specifier that is a URL (`data:`, `file:`, `node:`), which names no package. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** @return the package a bare specifier names, or undefined where it names none (a path, a URL, a built-in). */
function lookupName(specifier: unknown): string | undefined {
  if (typeof specifier !== "string" || nodeModule.isBuiltin(specifier) || URL_SCHEME.test(specifier)) {
    return undefined;
  }
  return splitSpecifier(specifier)?.name;
}

/**
 * Record into `lookups` each package looked up by a bare specifier, as the
 * CommonJS loader resolves one (`Module._resolveFilename`) and as node's own
 * resolve hooks do for either module system: the file that asked and the
 * package name, to the file that answered, or null where the lookup failed. A
 * failed lookup of a subpath does not unsay an answer the package gave.
 */
function wrapLookups(lookups: Map<string, string | null>): void {
  const note = (from: string | undefined, name: string | undefined, to: string | null): void => {
    if (from === undefined || name === undefined) {
      return;
    }
    const key = `${from}\0${name}`;
    if (to !== null || !lookups.has(key)) {
      lookups.set(key, to === null ? null : path.resolve(to));
    }
  };
  const loader = Module as unknown as { _resolveFilename: AnyFunction };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (this: unknown, request: unknown, parent: unknown, ...rest: unknown[]): unknown {
    const name = lookupName(request);
    const from = (parent as { filename?: unknown } | null | undefined)?.filename;
    const asked = name !== undefined && typeof from === "string" ? from : undefined;
    try {
      const resolved = resolveFilename.call(this, request, parent, ...rest);
      note(asked, name, typeof resolved === "string" ? resolved : null);
      return resolved;
    } catch (err: unknown) {
      note(asked, name, null);
      throw err;
    }
  };
  const registerHooks = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  registerHooks?.({
    resolve(specifier: string, context: { parentURL?: string }, nextResolve: AnyFunction) {
      const name = lookupName(specifier);
      const from = name !== undefined && context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
      try {
        const resolved = nextResolve(specifier, context) as { url?: string };
        note(from, name, typeof resolved.url === "string" && resolved.url.startsWith("file:") ? fileURLToPath(resolved.url) : null);
        return resolved;
      } catch (err: unknown) {
        note(from, name, null);
        throw err;
      }
    },
  });
}

/** @return the path `target` names, where it names one. */
function pathOf(target: unknown): string | undefined {
  return typeof target === "string" ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : undefined;
}

/** Replace `owner[name]` with a function that shows `note` its arguments first,
 *  carrying the original's own members (`realpathSync.native`). */
function wrap(owner: Record<string, unknown>, name: string, note: (args: unknown[]) => void): void {
  const original = owner[name];
  if (typeof original !== "function") {
    return;
  }
  owner[name] = Object.assign(function (this: unknown, ...args: unknown[]): unknown {
    note(args);
    return (original as AnyFunction).apply(this, args);
  }, original);
}

/** @return true if `flags`, as `fs.open` takes them, open a file for reading, otherwise false. */
function opensForReading(flags: unknown): boolean {
  if (typeof flags === "number") {
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== fs.constants.O_WRONLY;
  }
  return typeof flags !== "string" || flags.startsWith("r") || flags.includes("+");
}

/** Record into `read` each file read through `fs`. */
function wrapReaders(read: Set<string>): void {
  const note = (target: unknown): void => {
    const file = pathOf(target);
    if (file !== undefined) {
      read.add(path.resolve(file));
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require("node:fs") as Record<string, unknown> & { promises: Record<string, unknown> };
  for (const name of READERS) {
    wrap(files, name, ([target]) => note(target));
  }
  for (const name of PROMISE_READERS) {
    wrap(files.promises, name, ([target]) => note(target));
  }
  for (const name of OPENERS) {
    wrap(files, name, ([target, flags]) => opensForReading(flags) && note(target));
  }
  wrap(files.promises, "open", ([target, flags]) => opensForReading(flags) && note(target));
}

/** Mark `current` untracked once the process starts another process or a worker thread. */
function wrapStarters(current: IRecording): void {
  const untrack = (): void => {
    current.untracked = true;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const processes = require("node:child_process") as Record<string, unknown>;
  for (const name of SPAWNERS) {
    wrap(processes, name, untrack);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const threads = require("node:worker_threads") as { Worker: new (...args: unknown[]) => unknown };
  const Worker = threads.Worker;
  threads.Worker = class extends (Worker as new (...args: unknown[]) => object) {
    constructor(...args: unknown[]) {
      super(...args);
      untrack();
    }
  } as typeof threads.Worker;
}

/** Record into `loaded` each module as it loads: a CommonJS one may leave the
 * module cache again (`jest.resetModules`) before the cache is read, and an ES
 * module is loaded through node's own loader, which no `fs` wrapper sees. */
function wrapLoaders(loaded: Set<string>): void {
  const note = (target: unknown): void => {
    const file = pathOf(target);
    if (file !== undefined) {
      loaded.add(path.resolve(file));
    }
  };
  const prototype = Module.prototype as unknown as { load: AnyFunction };
  const load = prototype.load;
  prototype.load = function (this: unknown, filename: unknown, ...rest: unknown[]): unknown {
    note(filename);
    return load.call(this, filename, ...rest);
  };
  const registerHooks = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  registerHooks?.({
    load(url: string, context: unknown, nextLoad: AnyFunction) {
      if (url.startsWith("file:")) {
        note(fileURLToPath(url));
      }
      return nextLoad(url, context);
    },
  });
}

/**
 * Record what this process reads into `directory`, as a file named for its
 * pid that is written when it exits: how a runner whose tests run in processes
 * it does not start itself learns what they read (see {@link readsRecordedIn}).
 */
export function recordReadsInto(directory: string): void {
  const reads = recordReads();
  const write = (): void => fs.writeFileSync(path.join(directory, `${process.pid}.json`), JSON.stringify(reads() ?? null));
  process.on("exit", write);
  /* A pool that ends its workers by signal (vitest's) runs no exit handler. */
  process.once("SIGTERM", () => {
    process.off("exit", write);
    write();
    process.exit(128 + 15);
  });
}

/** @return what the processes recording into `directory` read, or undefined
 * where any of them did what no record can follow. */
export function readsRecordedIn(directory: string): IRecordedReads | undefined {
  const each = fs
    .readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .map(name => toRecordedReads(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))));
  return each.some(reads => reads === undefined)
    ? undefined
    : { files: each.flatMap(reads => reads?.files ?? []), lookups: each.flatMap(reads => reads?.lookups ?? []) };
}

/** Convert one process's recorded reads, or `null` for what no record can follow. */
function toRecordedReads(json: unknown): IRecordedReads | undefined {
  if (json === null) {
    return undefined;
  }
  const document = toReadsDocument(json);
  return { files: [...document.files], lookups: [...document.lookups] };
}

/** @return `reads` with the PnP table the processes resolved through, which
 * each loaded before anything could record it. */
export function withPnpTable(reads: IRecordedReads | undefined, table: string | undefined): IRecordedReads | undefined {
  return reads === undefined || table === undefined ? reads : { ...reads, files: [...reads.files, table] };
}

/**
 * Write `reads` as the `--reads` document at `file` ({@link IReadsDocument}):
 * sorted, deduplicated, each path relative to the working directory. Undefined
 * reads — something no record can follow — write no document.
 */
export function writeReads(file: string, reads: IRecordedReads | undefined): void {
  if (reads === undefined) {
    return;
  }
  const cwd = process.cwd();
  const relative = (read: string): string => path.relative(cwd, read).split(path.sep).join("/");
  const files = [...new Set(reads.files.map(relative))].sort();
  const lookups = [...new Map(reads.lookups.map(lookup => [`${lookup.from}\0${lookup.name}`, lookup])).values()]
    .map((lookup): ILookup => ({ from: relative(lookup.from), name: lookup.name, ...(lookup.to === undefined ? {} : { to: relative(lookup.to) }) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const document: IReadsDocument = { files, lookups };
  fs.writeFileSync(file, JSON.stringify(document));
}
