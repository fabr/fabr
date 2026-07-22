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

import { IPluginDecl } from "./AST";
import { PluginContribution } from "../rules/Types";

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
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const plugin = require(entry) as IFabrPluginModule;
  if (typeof plugin.activate !== "function") {
    throw new Error(`Plugin '${decl.name}' does not export an activate() function`);
  }
  return plugin.activate() ?? {};
}
