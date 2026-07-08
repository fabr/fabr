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
 * dirs) — it performs no global registration. It receives the host's own
 * @fabr/core module instance as the api. The full plugin contract is documented
 * in PLUGINS.md.
 */
interface IFabrPluginModule {
  activate?: (api: unknown) => PluginContribution | undefined;
}

/**
 * Activate the declared plugins and return their contributions (in declaration
 * order). Plugins resolve by MODULE RESOLUTION only: the package must be
 * installed alongside the host (there is currently no build-the-plugin-from-
 * source option). Activation happens at parse time — before include resolution —
 * so the include directories a plugin contributes take part in resolving the
 * very file that declared it. `activated` (a per-load set) dedupes a plugin
 * declared from several files without double-counting its contribution.
 */
export function activatePlugins(plugins: IPluginDecl[], api: unknown, activated: Set<string>): PluginContribution[] {
  const contributions: PluginContribution[] = [];
  for (const decl of plugins) {
    if (activated.has(decl.name)) {
      continue;
    }
    if (api === undefined) {
      throw new Error(`This host does not support plugins (requested by plugin '${decl.name}')`);
    }
    let entry: string;
    try {
      entry = require.resolve(decl.name);
    } catch {
      throw new Error(`Plugin '${decl.name}' is not installed (plugins are resolved from the fabr installation)`);
    }
    activated.add(decl.name);
    contributions.push(activatePlugin(entry, decl, api));
  }
  return contributions;
}

function activatePlugin(entry: string, decl: IPluginDecl, api: unknown): PluginContribution {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const plugin = require(entry) as IFabrPluginModule;
  if (typeof plugin.activate !== "function") {
    throw new Error(`Plugin '${decl.name}' does not export an activate() function`);
  }
  return plugin.activate(api) ?? {};
}
