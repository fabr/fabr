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
 * Resolve a node process's modules through a PnP table rather than a
 * `node_modules` tree: a resolve hook, and for CommonJS a wrap of
 * `Module._resolveFilename` (which `require.resolve` calls without the hooks
 * on node 22), ask {@link PnpResolver} what a request names, and a load hook
 * reads a virtual location's bytes from the physical file beneath it, so each
 * wiring of a package is a module instance of its own. `fs` reads a virtual
 * path from the file beneath it ({@link installVirtualFs}). `pnpapi` is the
 * table's {@link PnpResolver}, and `process.versions.pnp` is set, as Yarn's
 * runtime does.
 *
 * A process is given the runtime by a preload beside the table
 * ({@link PNP_PRELOAD}) that node is given with `--require`, which loads this
 * module from its tree in the pool and calls {@link installFromPreload}.
 */

import * as fs from "node:fs";
import * as nodeModule from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNP_DATA_FILE, PNP_PRELOAD, PnpResolver } from "./PnPResolver";
import { installVirtualFs } from "./VirtualFs";
import { isVirtual, realpathKeepingVirtual, resolveVirtual, TREE_LINK } from "./VirtualPath";

interface IResolveContext {
  conditions?: string[];
  parentURL?: string;
}

interface IResolved {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}

interface ILoaded {
  format?: string | null;
  source?: string | Buffer | Uint8Array | null;
  shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context: IResolveContext) => IResolved;
type NextLoad = (url: string, context: unknown) => ILoaded;

/** As much of `Module` as the runtime wraps. */
interface IModuleInternals {
  _resolveFilename(
    request: string,
    parent: { filename?: string | null } | null | undefined,
    isMain: boolean,
    options?: unknown
  ): string;
}

/** The conditions a CommonJS `require` resolves `exports` under. */
const REQUIRE_CONDITIONS = ["require", "node", "node-addons", "module-sync"];

/** Where this process keeps its tables ({@link IInstalledTables}). */
const PNP_TABLES = Symbol.for("fabr.pnp.tables");

/** The tables this process has installed the runtime for. */
interface IInstalledTables {
  /** Each table's resolver, by the table's root: what `pnpApi` is, read by the
   *  module {@link apiModuleOf} serves. */
  readonly resolvers: Map<string, PnpResolver>;
  /** The root of the table installed most recently, the one that answers; the
   *  hooks of the others pass every request on. */
  current?: string;
}

/** @return this process's {@link IInstalledTables}, made on first use. */
function installedTables(): IInstalledTables {
  const held = globalThis as unknown as Record<symbol, IInstalledTables | undefined>;
  return (held[PNP_TABLES] ??= { resolvers: new Map() });
}

/** @return the path of the module `pnpapi` resolves to for the table at `root`;
 * no file is there, the load hook serves its source. */
function apiModuleOf(root: string): string {
  return path.join(root, ".fabr-pnpapi.cjs");
}

/** Yarn's version of the PnP runtime standard, as `process.versions.pnp` states it. */
const PNP_STANDARD = "3";

/**
 * Resolve this process's modules through the table beside `preload`, and
 * every node process it starts through the same table: `--require <preload>`
 * is added to `NODE_OPTIONS`, which they inherit.
 */
export function installFromPreload(preload: string): void {
  installPnpRuntime(path.join(path.dirname(preload), PNP_DATA_FILE));
  /* Another table's preload, inherited from the process that started this
   * one, is dropped: this table answers here and in what this process starts. */
  const option = `--require ${JSON.stringify(preload)}`;
  const others = (process.env.NODE_OPTIONS ?? "").replace(OTHER_PRELOAD, held => (held === option ? held : ""));
  const kept = others.replace(/\s+/g, " ").trim();
  process.env.NODE_OPTIONS = kept.includes(option) ? kept : [kept, option].filter(Boolean).join(" ");
}

/** Matches a `NODE_OPTIONS` entry that loads a table's preload ({@link PNP_PRELOAD}), as {@link installFromPreload} writes one. */
const OTHER_PRELOAD = new RegExp(`--require "(?:[^"\\\\]|\\\\.)*[\\\\/]${PNP_PRELOAD.replace(/\./g, "\\.")}"`, "g");

/**
 * Resolve this process's module requests through the PnP table `table`, from
 * here on: a request made from a file the table locates, and every request a
 * file at a virtual location makes, is answered by the table; anything else
 * (the runner's own install, a built-in) as node would answer it. The table
 * installed most recently answers: the hooks of a table installed before it
 * pass every request on, and installing a table again makes it the one that
 * answers.
 */
export function installPnpRuntime(table: string): void {
  const registerHooks = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  if (registerHooks === undefined) {
    throw new Error(`Resolving through a PnP table needs node 22.15 or later (this is ${process.versions.node})`);
  }
  const root = path.dirname(path.resolve(table));
  const tables = installedTables();
  tables.current = root;
  if (tables.resolvers.has(root)) {
    return;
  }
  const first = tables.resolvers.size === 0;
  const resolver = PnpResolver.load(root, []);
  if (resolver === undefined) {
    throw new Error(`No PnP table at ${table}`);
  }
  /* Every package location is reached through the tree pool's link beside the
   * install, so a file's real path is a change of prefix. */
  const link = path.resolve(root, TREE_LINK) + path.sep;
  let pool: string;
  try {
    pool = fs.realpathSync(link) + path.sep;
  } catch {
    pool = link;
  }
  const realpath = (file: string): string => (file.startsWith(link) ? pool + file.slice(link.length) : file);
  const apiModule = apiModuleOf(root);
  tables.resolvers.set(root, resolver);
  /* The table's answers, memoized by specifier, the issuer's directory and the
   * conditions, which are all an answer depends on: the file it names (the
   * real path, virtual part kept, as node names every module it resolves, so a
   * file reached through the pool's link and directly is one module), or
   * undefined where the table does not answer and node is asked instead. */
  const answered = new Map<string, string | undefined>();
  const answer = (specifier: string, parent: string, conditions: readonly string[], next: () => string): string => {
    const key = `${specifier}\0${path.dirname(parent)}\0${conditions.join(",")}`;
    if (answered.has(key)) {
      return answered.get(key) ?? next();
    }
    if (!answers(resolver, specifier, parent)) {
      return next();
    }
    let resolved: string | null;
    try {
      resolved = resolver.resolveRequest(specifier, parent, { conditions: new Set(conditions) });
    } catch (err: unknown) {
      /* Where the table refuses, ask node; where node fails too, report the
       * table's error. */
      try {
        return next();
      } catch {
        throw err;
      }
    }
    const file = resolved === null ? undefined : realpathKeepingVirtual(resolved, realpath);
    answered.set(key, file);
    return file ?? next();
  };
  if (first) {
    installVirtualFs();
  }
  (process.versions as Record<string, string>).pnp = PNP_STANDARD;
  const internals = nodeModule.Module as unknown as IModuleInternals;
  const resolveFilename = internals._resolveFilename;
  internals._resolveFilename = function (request, parent, isMain, options): string {
    const next = (): string => resolveFilename.call(this, request, parent, isMain, options);
    if (tables.current !== root) {
      return next();
    }
    if (request === "pnpapi") {
      return apiModule;
    }
    const issuer = parent?.filename ?? undefined;
    /* A lookup given its own search paths (`require.resolve(x, {paths})`) is node's. */
    const searched = typeof options === "object" && options !== null && "paths" in options;
    if (issuer === undefined || searched || nodeModule.isBuiltin(request)) {
      /* The entry itself may be at a virtual location, which node cannot stat. */
      return issuer === undefined && path.isAbsolute(request) && isVirtual(request)
        ? realpathKeepingVirtual(request, realpath)
        : next();
    }
    return answer(request, issuer, REQUIRE_CONDITIONS, next);
  };
  registerHooks({
    resolve(specifier: string, context: IResolveContext, nextResolve: NextResolve): IResolved {
      if (tables.current !== root) {
        return nextResolve(specifier, context);
      }
      if (specifier === "pnpapi") {
        return { url: pathToFileURL(apiModule).href, format: "commonjs", shortCircuit: true };
      }
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
      if (parent === undefined || nodeModule.isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      let deferred: IResolved | undefined;
      const file = answer(specifier, parent, context.conditions ?? [], () => {
        deferred = nextResolve(specifier, context);
        return "";
      });
      return deferred ?? { url: pathToFileURL(file).href, shortCircuit: true };
    },
    load(url: string, context: unknown, nextLoad: NextLoad): ILoaded {
      const file = url.startsWith("file:") ? fileURLToPath(url) : undefined;
      if (file === apiModule) {
        return {
          format: "commonjs",
          source: `module.exports = globalThis[Symbol.for(${JSON.stringify(PNP_TABLES.description)})].resolvers.get(${JSON.stringify(root)});\n`,
          shortCircuit: true,
        };
      }
      if (file === undefined || !isVirtual(file)) {
        return nextLoad(url, context);
      }
      const physical = resolveVirtual(file);
      const loaded = nextLoad(pathToFileURL(physical).href, context);
      return { ...loaded, source: loaded.source ?? fs.readFileSync(physical), shortCircuit: true };
    },
  });
}

/**
 * @return true if the table answers `specifier` asked from `parent`, otherwise
 * false: a package name or `#` import from a file of one of the table's
 * packages — a path its ignore pattern names (the runner's own install) is of
 * none — or any path from (or to) a virtual location, which nothing but the
 * table can find.
 */
function answers(resolver: PnpResolver, specifier: string, parent: string): boolean {
  const isPath = specifier.startsWith(".") || path.isAbsolute(specifier) || specifier.startsWith("file:");
  if (isPath) {
    return isVirtual(parent) || isVirtual(specifier);
  }
  return resolver.findPackageLocator(parent) !== null;
}
