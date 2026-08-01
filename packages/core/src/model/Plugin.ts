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
import { PluginContribution } from "../rules/Types";

/** The package a plugin must share with its host, never load a second copy of. */
const CORE_PACKAGE = "@fabr-build/core";

/**
 * The shape a plugin package's entry point must export: `activate` is a pure
 * function that RETURNS the plugin's contribution (rules, repositories, include
 * dirs) — it performs no global registration and takes no arguments. It reaches
 * the host's facilities by importing `@fabr-build/core` directly; the single-copy
 * invariant (a plugin shares the host's core instance, never a second copy) is
 * what makes that sound. The full plugin contract is documented in PLUGINS.md.
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

/**
 * @return the error for a plugin whose core is not the host's, or undefined if
 * the two agree. A side that resolved NOTHING is not a conflict — a plugin need
 * not use core at all, and a host that can't find its own copy (its tests run
 * it unpackaged) has no claim to compare against.
 */
export function duplicateCoreError(name: string, hostCore?: string, pluginCore?: string): Error | undefined {
  if (hostCore === undefined || pluginCore === undefined || hostCore === pluginCore) {
    return undefined;
  }
  return new Error(
    `Plugin '${name}' would load its own copy of ${CORE_PACKAGE} (${pluginCore}) instead of ` +
      `the host's (${hostCore}); a plugin must share the host's core. Install the plugin as a ` +
      `dependency of the fabr CLI rather than as a package in its own right (globally, that is ` +
      `\`npm install -g @fabr-build/cli\` alone).`
  );
}

/**
 * Fail unless the plugin at `entry` would load the SAME core as the host. A
 * second copy satisfies every type but shares no state, so the plugin's rules
 * and the host's disagree about the values passing between them — which
 * surfaces far from the cause, as an unpositioned undefined-property error.
 * Checked here because it is only ever an installation fault, never a build
 * one: npm hoists one shared copy when the plugin is a dependency of the host,
 * and nests a private one when it is a top-level install in its own right.
 */
function checkSharesHostCore(name: string, entry: string): void {
  const err = duplicateCoreError(
    name,
    resolvePackageFrom(CORE_PACKAGE, __dirname),
    resolvePackageFrom(CORE_PACKAGE, path.dirname(entry))
  );
  if (err !== undefined) {
    throw err;
  }
}

/**
 * Activate one declared plugin and return its contribution. Plugins resolve by
 * MODULE RESOLUTION only: the package must be installed alongside the host (there
 * is currently no build-the-plugin-from-source option). `activate` is a pure
 * function (returns data, registers nothing), so calling it is side-effect-free
 * beyond the one-time module load — the loader may call it during the walk (to
 * learn a plugin's auto-included files) and dedupes contributions by plugin name.
 */
export function activatePlugin(decl: IPluginDecl): PluginContribution {
  let entry: string;
  try {
    entry = require.resolve(decl.name);
  } catch {
    throw new Error(`Plugin '${decl.name}' is not installed (plugins are resolved from the fabr installation)`);
  }
  checkSharesHostCore(decl.name, entry);
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const plugin = require(entry) as IFabrPluginModule;
  if (typeof plugin.activate !== "function") {
    throw new Error(`Plugin '${decl.name}' does not export an activate() function`);
  }
  return plugin.activate() ?? {};
}
