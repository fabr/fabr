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
 * `node_modules` tree: a resolve hook asks {@link PnpResolver} what a request
 * names, and a load hook reads a virtual location's bytes from the physical
 * file beneath it, so each wiring of a package is a module instance of its
 * own. What reads a file through `fs` by a virtual path finds nothing there.
 */

import * as fs from "node:fs";
import * as nodeModule from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PnpResolver } from "./PnPResolver";
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

/**
 * Resolve this process's module requests through the PnP table `table`, from
 * here on: a request made from a file the table locates, and every request a
 * file at a virtual location makes, is answered by the table; anything else
 * (the runner's own install, a built-in) as node would answer it.
 */
export function installPnpRuntime(table: string): void {
  const registerHooks = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  if (registerHooks === undefined) {
    throw new Error(`Resolving through a PnP table needs node 22.15 or later (this is ${process.versions.node})`);
  }
  const root = path.dirname(path.resolve(table));
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
  const answered = new Map<string, IResolved>();
  registerHooks({
    resolve(specifier: string, context: IResolveContext, nextResolve: NextResolve): IResolved {
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
      if (parent === undefined || nodeModule.isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      /* Answers are memoized by specifier, the issuer's directory and the
       * conditions: the table's answer depends on nothing else. */
      const key = `${specifier}\0${path.dirname(parent)}\0${(context.conditions ?? []).join(",")}`;
      const known = answered.get(key);
      if (known !== undefined) {
        return known;
      }
      if (!answers(resolver, specifier, parent)) {
        return nextResolve(specifier, context);
      }
      let resolved: string | null;
      try {
        resolved = resolver.resolveRequest(specifier, parent, { conditions: new Set(context.conditions ?? []) });
      } catch (err: unknown) {
        /* Where the table refuses, ask node; where node fails too, report the
         * table's error. */
        try {
          return nextResolve(specifier, context);
        } catch {
          throw err;
        }
      }
      if (resolved === null) {
        return nextResolve(specifier, context);
      }
      /* Answer with the real path (virtual part kept), as node names every
       * module it resolves, so a file reached through the pool's link and
       * directly loads as one module. */
      const answer = { url: pathToFileURL(realpathKeepingVirtual(resolved, realpath)).href, shortCircuit: true };
      answered.set(key, answer);
      return answer;
    },
    load(url: string, context: unknown, nextLoad: NextLoad): ILoaded {
      const file = url.startsWith("file:") ? fileURLToPath(url) : undefined;
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
