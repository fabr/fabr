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

/**
 * The shape a plugin package's entry point must export: activate is called
 * once and performs the plugin's registrations, with the host's own
 * @fabr/core module instance as the api. The full plugin contract is
 * documented in PLUGINS.md.
 */
interface IFabrPluginModule {
  activate?: (api: unknown) => void;
}

/** Plugins already activated this process (a plugin activates exactly once) */
const activated = new Set<string>();

/**
 * Activate the declared plugins. Plugins resolve by MODULE RESOLUTION only:
 * the package must be installed alongside the host (there is currently no
 * build-the-plugin-from-source option). Activation happens at parse time —
 * before include resolution — so the include directories a plugin registers
 * take part in resolving the very file that declared it.
 */
export function activatePlugins(plugins: IPluginDecl[], api: unknown): void {
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
    activatePlugin(entry, decl, api);
  }
}

function activatePlugin(entry: string, decl: IPluginDecl, api: unknown): void {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const plugin = require(entry) as IFabrPluginModule;
  if (typeof plugin.activate !== "function") {
    throw new Error(`Plugin '${decl.name}' does not export an activate() function`);
  }
  plugin.activate(api);
}
