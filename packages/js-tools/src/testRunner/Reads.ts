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
 * Recording what a test process reads, for the runner contract's `--reads`
 * document ({@link IReadsDocument}): every module the process loaded, the
 * `package.json` nearest each, every file it read or probed through `fs` (a
 * probe that found a directory named with a trailing `/`), and every package
 * it looked up by a bare specifier, found or not. A directory listing is not
 * recorded. A node process it starts records too, into the same directory
 * ({@link recordReadsInto}); where it started any other process or a worker
 * thread, whose reads are not recorded, its reads are unknown, and the test
 * step runs the file again on every change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as nodeModule from "node:module";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { splitSpecifier } from "../pnp/PnPResolver";
import { resolveVirtual } from "../pnp/VirtualPath";
import { installRootOf } from "../support/Paths";
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

/** The environment variable naming the document a recording child writes
 *  ({@link recordReadsInto}), which the process that started it lists. */
const READS_TOKEN = "FABR_READS_TOKEN";

/** What a process has read so far. */
interface IRecording {
  /** The absolute path of each module loaded. */
  loaded: Set<string>;
  /** The absolute path of each file read or probed through `fs`. */
  read: Set<string>;
  /** Each lookup by the file that asked and the package name, to the absolute
   *  path that answered, or null where nothing did. */
  lookups: Map<string, string | null>;
  /** The token of each node process it started that records too ({@link READS_TOKEN}). */
  children: string[];
  /** True once the process has started a process that does not record, or a worker thread. */
  untracked: boolean;
}

/** What a process read, every path absolute. */
export interface IRecordedReads {
  files: string[];
  lookups: ILookup[];
  /** The token of each node process it started, whose reads are recorded apart. */
  children: string[];
}

/**
 * Start recording what this process reads, and return how to collect it: the
 * absolute paths of every module loaded, from start-up on, of every file read
 * or probed through `fs` since, by its real path, every package looked up by a
 * bare specifier, and the node processes it started; or undefined where the
 * process has since started any other process or a worker thread. A file
 * within the install this module lies in ({@link ownInstall}), and a lookup
 * made from one, is left out.
 *
 * A node process it starts (by `fork`, or by running `process.execPath` or
 * `node` with no shell) records too where its environment's `NODE_OPTIONS`
 * loads `recorder` (a preload calling {@link recordReadsInto}), as an
 * inherited environment does: it is given a {@link READS_TOKEN} its document
 * is named by. Any other process leaves the reads unknown, as every process
 * does where there is no `recorder`.
 *
 * Must be called before any module imports `node:fs`, `node:fs/promises`,
 * `node:child_process` or `node:worker_threads` as an ES module: such an
 * import's named bindings are copied when it is first made, so one made
 * earlier keeps the unwrapped functions and its reads go unrecorded.
 */
export function recordReads(recorder?: string): () => IRecordedReads | undefined {
  const current: IRecording = { loaded: new Set(), read: new Set(), lookups: new Map(), children: [], untracked: false };
  wrapReaders(current.read);
  wrapStarters(current, recorder);
  wrapLoaders(current.loaded);
  wrapLookups(current.lookups);
  const cache = createRequire(__filename).cache;
  /* A module is loaded by its real path already. A file read through `fs` may
   * be named through a link (a `node_modules` one), so resolve its directory,
   * once per directory. */
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
  /* The install this recorder lies in (the runner's) is linked into the run
   * whole, so nothing within it is an input the reads name. */
  const install = ownInstall();
  const outside = (file: string): boolean => install === undefined || !file.startsWith(install);
  return () => {
    if (current.untracked) {
      return undefined;
    }
    const modules = new Set([...current.loaded, ...Object.keys(cache)].filter(outside));
    /* A module at a virtual location is probed for its manifest at the
     * physical one, where the files are; the step names a read either way. */
    const nearest = [...modules].flatMap(module => manifestOf(path.dirname(resolveVirtual(module))) ?? []);
    /* A module loaded is a file, so needs no probe for a directory. */
    const read = [...current.read].map(realPathOf).filter(file => outside(file) && !modules.has(file));
    const lookups = [...current.lookups].flatMap(([key, to]): ILookup[] => {
      const [from, name] = key.split("\0");
      return !outside(from) ? [] : to === null ? [{ from, name }] : [{ from, name, to }];
    });
    return {
      files: [...modules, ...nearest.filter(outside), ...read.map(markDirectory)],
      lookups,
      children: [...current.children],
    };
  };
}

/**
 * @return the install this module lies in, with a trailing separator: the
 * directory above the first `node_modules` on its path. Undefined where there
 * is none, or where the working directory lies within it.
 */
function ownInstall(): string | undefined {
  const here = path.dirname(__filename);
  const root = installRootOf(here);
  if (root === here) {
    return undefined;
  }
  const install = root + path.sep;
  return (process.cwd() + path.sep).startsWith(install) ? undefined : install;
}

/** @return `file` with a trailing separator where it is a directory now, otherwise `file`. */
function markDirectory(file: string): string {
  try {
    return statSync(file).isDirectory() ? file + path.sep : file;
  } catch {
    return file;
  }
}

/** Matches a specifier that is a URL (`data:`, `file:`, `node:`), which names no package. */
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
 * failed lookup of a subpath does not replace an answer the package gave.
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

/** @return the path `target` names (a string, a `file:` URL or a Buffer), or
 * undefined where it names none. */
function pathOf(target: unknown): string | undefined {
  return typeof target === "string"
    ? target
    : target instanceof URL
      ? fileURLToPath(target)
      : Buffer.isBuffer(target)
        ? target.toString()
        : undefined;
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

/**
 * Wrap the functions that start a process: a node process whose environment
 * loads `recorder` is started with a token of its own, listed in
 * `current.children`; any other process, and a worker thread, marks `current`
 * untracked.
 */
function wrapStarters(current: IRecording, recorder: string | undefined): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const processes = require("node:child_process") as Record<string, unknown>;
  for (const name of SPAWNERS) {
    const start = processes[name];
    if (typeof start !== "function") {
      continue;
    }
    processes[name] = Object.assign(function (this: unknown, ...args: unknown[]): unknown {
      const env = environmentOf(name, args);
      if (recorder === undefined || !startsNode(name, args) || !(env.NODE_OPTIONS ?? "").includes(JSON.stringify(recorder))) {
        current.untracked = true;
        return (start as AnyFunction).apply(this, args);
      }
      const token = `${process.pid}-${current.children.length}`;
      current.children.push(token);
      return (start as AnyFunction).apply(this, withEnvironment(name, args, { ...env, [READS_TOKEN]: token }));
    }, start);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const threads = require("node:worker_threads") as { Worker: new (...args: unknown[]) => unknown };
  const Worker = threads.Worker;
  threads.Worker = class extends (Worker as new (...args: unknown[]) => object) {
    constructor(...args: unknown[]) {
      super(...args);
      current.untracked = true;
    }
  } as typeof threads.Worker;
}

/** @return the index of the options among a starter's `args`: after the
 *  argument list where one is given, else after the command. */
function optionsIndex(name: string, args: unknown[]): number {
  if (name === "exec" || name === "execSync") {
    return 1;
  }
  /* A missing argument list (`undefined` or `null`) still takes its place. */
  return Array.isArray(args[1]) || (args[1] == null && args.length > 2) ? 2 : 1;
}

/** @return true if the starter `name` called with `args` starts node itself,
 *  with no shell between, otherwise false. */
function startsNode(name: string, args: unknown[]): boolean {
  if (name === "fork") {
    return true;
  }
  if (name === "exec" || name === "execSync") {
    return false;
  }
  const options = args[optionsIndex(name, args)];
  if (options !== null && typeof options === "object" && (options as { shell?: unknown }).shell) {
    return false;
  }
  const command = args[0];
  return (
    typeof command === "string" &&
    (command === process.execPath || path.basename(command) === "node" || path.basename(command) === "node.exe")
  );
}

/** @return the options among a starter's `args`, where there is an object of them. */
function optionsOf(name: string, args: unknown[]): { env?: NodeJS.ProcessEnv } | undefined {
  const given = args[optionsIndex(name, args)];
  return given !== null && typeof given === "object" ? (given as { env?: NodeJS.ProcessEnv }) : undefined;
}

/** @return the environment a starter called with `args` gives its process: its
 *  options' `env`, else this process's own. */
function environmentOf(name: string, args: unknown[]): NodeJS.ProcessEnv {
  return optionsOf(name, args)?.env ?? process.env;
}

/** @return `args` with the process given `env`, in its options where it has
 *  some, else in options of its own, placed before any callback. A missing
 *  argument list is given an empty one. */
function withEnvironment(name: string, args: unknown[], env: NodeJS.ProcessEnv): unknown[] {
  const options = optionsOf(name, args);
  const changed = [...args];
  if (options !== undefined) {
    changed[optionsIndex(name, args)] = { ...options, env };
    return changed;
  }
  if (!Array.isArray(changed[1])) {
    changed.splice(1, changed[1] == null && changed.length > 1 ? 1 : 0, []);
  }
  changed.splice(2, changed[2] == null && changed.length > 2 ? 1 : 0, { env });
  return changed;
}

/** Record into `loaded` each module as it loads, CommonJS or ES. The module
 * cache alone misses a CommonJS module that left it again (`jest.resetModules`),
 * and the `fs` wrappers miss every ES module, which node's loader reads. */
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
 * Record what this process reads into `directory`, as a file named for the
 * token it was started with ({@link READS_TOKEN}), or else its pid, written
 * when it exits or receives SIGTERM, for {@link readsRecordedIn} to collect.
 * Call it from a `--require` preload, so that it runs before anything the
 * process imports (see {@link recordReads}); `recorder` is that preload, which
 * the node processes it starts record through too.
 */
export function recordReadsInto(directory: string, recorder?: string): void {
  const name = process.env[READS_TOKEN] ?? String(process.pid);
  delete process.env[READS_TOKEN];
  const reads = recordReads(recorder);
  /* A process that outlives the run finds the directory gone: its reads are
   * unknown already, as the document it was listed under never appears. */
  const write = (): void => {
    try {
      fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(reads() ?? null));
    } catch {
      /* The run has ended. */
    }
  };
  process.on("exit", write);
  /* A signal runs no exit handler, and a pool may end its workers by one
   * (vitest's). Where nothing else handles it, the signal is raised again
   * once written, so the process ends as it would have; otherwise that
   * handler decides, and the document is written again at exit. */
  process.once("SIGTERM", () => {
    write();
    if (process.listenerCount("SIGTERM") === 0) {
      process.off("exit", write);
      process.kill(process.pid, "SIGTERM");
    }
  });
}

/**
 * @return what `here` read (this process's own recording, where it has one:
 * undefined where it is unknown) and what the processes recording into
 * `directory` read, or undefined where
 * any of them started a process that does not record or a worker thread, or
 * a node process one of them started wrote nothing (it outlived the run, or
 * was stopped before it could).
 */
export function readsRecordedIn(directory: string, here: ReadonlyArray<IRecordedReads | undefined> = []): IRecordedReads | undefined {
  const documents = new Map(
    fs
      .readdirSync(directory)
      .filter(name => name.endsWith(".json"))
      .map((name): [string, IRecordedReads | undefined] => [
        name.slice(0, -".json".length),
        toRecordedReads(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))),
      ])
  );
  const each = [...here, ...documents.values()];
  const complete = (reads: IRecordedReads | undefined): reads is IRecordedReads =>
    reads !== undefined && reads.children.every(child => documents.get(child) !== undefined);
  if (!each.every(complete)) {
    return undefined;
  }
  const all = each as IRecordedReads[];
  return { files: all.flatMap(reads => reads.files), lookups: all.flatMap(reads => reads.lookups), children: [] };
}

/** Convert one process's recorded reads: a reads document with the tokens
 * of the node processes it started (`children`), or `null` where it started a
 * process that does not record or a worker thread (converted to undefined).
 * Throws where it is neither. */
function toRecordedReads(json: unknown): IRecordedReads | undefined {
  if (json === null) {
    return undefined;
  }
  const document = toReadsDocument(json);
  const children = (json as { children?: unknown }).children;
  if (!Array.isArray(children) || children.some(child => typeof child !== "string")) {
    throw new Error("expected 'children' to be a list of tokens");
  }
  return { files: [...document.files], lookups: [...document.lookups], children: children as string[] };
}

/** @return `reads` with the PnP table the processes resolved through added,
 * since each loaded it before recording began. */
export function withPnpTable(reads: IRecordedReads | undefined, table: string | undefined): IRecordedReads | undefined {
  return reads === undefined || table === undefined ? reads : { ...reads, files: [...reads.files, table] };
}

/**
 * Write `reads` as the `--reads` document at `file` ({@link IReadsDocument}):
 * sorted, deduplicated, each path relative to the working directory. Writes
 * nothing where `reads` is undefined.
 */
export function writeReads(file: string, reads: IRecordedReads | undefined): void {
  if (reads === undefined) {
    return;
  }
  const cwd = process.cwd();
  /* Each directory's path from the working directory, `/`-separated, with a
   * trailing `/` unless it is the working directory itself. */
  const directories = new Map<string, string>();
  const directoryName = (directory: string): string => {
    let name = directories.get(directory);
    if (name === undefined) {
      name = path.relative(cwd, directory).split(path.sep).join("/");
      name = name === "" ? "" : `${name}/`;
      directories.set(directory, name);
    }
    return name;
  };
  /* A trailing separator marks a directory, and is kept (the directory of
   * `<directory>/_` is the directory, a root included). */
  const relative = (read: string): string =>
    read.endsWith(path.sep)
      ? directoryName(path.dirname(read + "_"))
      : read === cwd
        ? ""
        : directoryName(path.dirname(read)) + path.basename(read);
  const files = [...new Set(reads.files.map(relative))].sort();
  const lookups = [...new Map(reads.lookups.map(lookup => [`${lookup.from}\0${lookup.name}`, lookup])).values()]
    .map((lookup): ILookup => ({
      from: relative(lookup.from),
      name: lookup.name,
      ...(lookup.to === undefined ? {} : { to: relative(lookup.to) }),
    }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const document: IReadsDocument = { files, lookups };
  fs.writeFileSync(file, JSON.stringify(document));
}
