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

import { IPluginDecl } from "./AST";
import { CORE_PACKAGE } from "../Constants";
import { INSTALLED_FROM } from "../rules/FabrHome";
import { PluginContribution } from "../rules/Types";
import { FabrError } from "../core/Errors";
import Module from "module";
import { parseConstraint, parseVersion, SEMVER } from "../resolver/Semver";
import { parseJson, toJsonObject } from "../support/Json";

/**
 * The shape a plugin package's entry point must export: `activate` is a pure
 * function that RETURNS the plugin's contribution (rules, repositories, included
 * `.fabr` files) — it performs no global registration and takes no arguments. It
 * reaches the host's facilities by importing `@fabr-build/core` directly, which
 * loads the host's own core (see {@link bindHostCore}). The full plugin
 * contract is documented in docs/src/content/docs/developer/plugins.md.
 */
interface IFabrPluginModule {
  activate?: () => PluginContribution | undefined;
}

/**
 * @return the copy of `pkg` that code in directory `from` would load, as a
 * realpath — so the workspace symlinks of a devchain install, and the two names
 * of a hoisted package, all read as the one copy they are. Undefined if `from`
 * resolves none.
 */
export function resolvePackageFrom(pkg: string, from: string): string | undefined {
  try {
    return fs.realpathSync(require.resolve(pkg, { paths: [from] }));
  } catch {
    return undefined;
  }
}

/** The resolver `require` uses, which {@link hostCoreResolver} wraps. */
type ResolveFilename = (request: string, ...rest: unknown[]) => string;

/**
 * @return `resolve` with every request for core answered with `hostCore`, and
 * every other request passed on: so code loaded into fabr's process (a plugin,
 * or what it loads) shares fabr's core, whatever copy its own install holds.
 */
export function hostCoreResolver(resolve: ResolveFilename, hostCore: string): ResolveFilename {
  return function (this: unknown, request: string, ...rest: unknown[]): string {
    return request === CORE_PACKAGE ? hostCore : resolve.call(this, request, ...rest);
  };
}

let hostCoreBound = false;

/** Make every `require` of core in this process load the host's copy (see
 *  {@link hostCoreResolver}). Done once, when the first plugin is activated. */
function bindHostCore(): void {
  const hostCore = resolvePackageFrom(CORE_PACKAGE, __dirname);
  if (hostCoreBound || hostCore === undefined) {
    return;
  }
  hostCoreBound = true;
  const loader = Module as unknown as { _resolveFilename: ResolveFilename };
  loader._resolveFilename = hostCoreResolver(loader._resolveFilename, hostCore);
}

/** @return the nearest `package.json` at or above `dir`, read, or undefined where there is none. */
function nearestManifest(dir: string, matches: (manifest: Record<string, unknown>) => boolean = () => true): Record<string, unknown> | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const file = path.join(at, "package.json");
    if (fs.existsSync(file)) {
      const manifest = parseJson(fs.readFileSync(file), file, toJsonObject);
      if (matches(manifest)) {
        return manifest;
      }
    }
    if (path.dirname(at) === at) {
      return undefined;
    }
  }
}

/**
 * @return the error for a plugin whose declared range for core (`range`, its
 * `peerDependencies`) does not include the host's `version`, or undefined
 * where it does, or either is unstated or unreadable.
 */
export function coreVersionError(name: string, range?: string, version?: string): Error | undefined {
  if (range === undefined || version === undefined) {
    return undefined;
  }
  try {
    if (SEMVER.satisfies(parseVersion(version), parseConstraint(range))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return new FabrError(`Plugin '${name}' requires ${CORE_PACKAGE} ${range}, but this fabr's is ${version}`).withHelp(
    "install a version of the plugin made for this fabr"
  );
}

/** Fail unless the plugin at `entry` declares a range for core that includes the host's version. */
function checkCoreVersion(name: string, entry: string): void {
  const plugin = nearestManifest(path.dirname(entry));
  const host = nearestManifest(__dirname, manifest => manifest.name === CORE_PACKAGE);
  const peers = plugin?.peerDependencies;
  const range = typeof peers === "object" && peers !== null ? (peers as Record<string, unknown>)[CORE_PACKAGE] : undefined;
  const err = coreVersionError(name, typeof range === "string" ? range : undefined, typeof host?.version === "string" ? host.version : undefined);
  if (err !== undefined) {
    throw err;
  }
}

/**
 * Activate one declared plugin and return its contribution. Plugins resolve by
 * MODULE RESOLUTION only: the package must be installed alongside the host (there
 * is currently no build-the-plugin-from-source option). The plugin loads the
 * host's core whatever copy its own install holds ({@link bindHostCore}), so its
 * declared range for core must include the host's version. `activate` is a pure
 * function (returns data, registers nothing), so calling it is side-effect-free
 * beyond the one-time module load — the loader may call it during the walk (to
 * learn a plugin's auto-included files) and dedupes contributions by plugin name.
 */
export function activatePlugin(decl: IPluginDecl): PluginContribution {
  let entry: string;
  try {
    entry = require.resolve(decl.name, { paths: [INSTALLED_FROM] });
  } catch {
    throw new FabrError(`Plugin '${decl.name}' is not installed (plugins are resolved from the fabr installation)`);
  }
  checkCoreVersion(decl.name, entry);
  bindHostCore();
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const plugin = require(entry) as IFabrPluginModule;
  if (typeof plugin.activate !== "function") {
    throw new FabrError(`Plugin '${decl.name}' does not export an activate() function`);
  }
  return plugin.activate() ?? {};
}
