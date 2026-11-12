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
 * The editor's TypeScript server, wrapped: the `tsdk` directory VS Code is
 * pointed at, and what its `tsserver.js` runs — the registered projects' links
 * laid over the filesystem, the plugin shim added to the server's plugins, then
 * the real server, unmodified.
 */

/* The module object itself, which tsserver calls through: a namespace import's
 * members cannot be replaced. */
import fs = require("fs");
import * as path from "path";
import { installOverlay, notifyRelinked } from "./Overlay";
import { currentLinks, isMaskedConfig, readRegistry, registeredProjects } from "./Registry";
import { SHIM_NAME } from "./Shim";

/** The wrapper's configuration, in the `tsdk` directory. */
export const CONFIG_FILE = "fabr-tsdk.json";

/** How often the registry is checked for changes, in milliseconds. */
const REGISTRY_POLL_MS = 500;

/** The wrapper's configuration, as {@link CONFIG_FILE} holds it. */
interface IWrapperConfig {
  /** The real `tsserver.js`. */
  tsserver: string;
  /** The registry of projects (see Registry). */
  registry: string;
}

/** What a `tsdk` directory is laid out from. */
export interface ITsdkLayout {
  /** The real `tsserver.js` the wrapper runs. */
  tsserver: string;
  /** That compiler's version, which VS Code reads from the `tsdk`. */
  version: string;
  /** The registry of projects. */
  registry: string;
  /** The compiled modules the `tsdk` loads: this one and the shim. */
  modules?: { wrapper: string; shim: string };
}

/**
 * Lay out a `tsdk` directory at `dir`: `lib/tsserver.js`, which starts the
 * wrapper, a `package.json` stating the compiler's version, the wrapper's
 * configuration, and the plugin shim where the wrapper's probe location finds
 * it.
 *
 * @return the path VS Code's `tsdk` setting names (`<dir>/lib`).
 */
export function layOutTsdk(dir: string, layout: ITsdkLayout): string {
  const modules = layout.modules ?? { wrapper: __filename, shim: path.join(__dirname, "Shim.js") };
  const write = (name: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  write("lib/tsserver.js", `require(${JSON.stringify(modules.wrapper)}).start(require("path").resolve(__dirname, ".."));\n`);
  write("package.json", JSON.stringify({ name: "typescript", version: layout.version, private: true }, null, 2) + "\n");
  write(CONFIG_FILE, JSON.stringify({ tsserver: layout.tsserver, registry: layout.registry }, null, 2) + "\n");
  write(`plugins/node_modules/${SHIM_NAME}/package.json`, JSON.stringify({ name: SHIM_NAME, main: "index.js", private: true }) + "\n");
  write(`plugins/node_modules/${SHIM_NAME}/index.js`, `module.exports = require(${JSON.stringify(modules.shim)}).shim;\n`);
  return path.join(dir, "lib");
}

/**
 * Run the TypeScript server for the `tsdk` directory `tsdk`: read its registry
 * and lay the projects' links over the filesystem, re-reading the registry when
 * it changes and telling the watches of a repointed link; add the shim to the
 * server's plugins and, where the registry lists a project, drop
 * `--canUseWatchEvents` (with it the client watches the real disk, where a link
 * is never seen to change); then load the real server. Problems reading the
 * registry are written to stderr.
 */
export function start(tsdk: string): void {
  const config = toWrapperConfig(JSON.parse(fs.readFileSync(path.join(tsdk, CONFIG_FILE), "utf8")));
  const report = (problems: string[]): void => {
    for (const problem of problems) {
      process.stderr.write(`fabr: ${problem}\n`);
    }
  };
  report(readRegistry(config.registry));
  installOverlay(fs, currentLinks, isMaskedConfig);
  fs.watchFile(config.registry, { persistent: false, interval: REGISTRY_POLL_MS }, () => {
    const before = currentLinks();
    report(readRegistry(config.registry));
    notifyRelinked(fs, before, currentLinks());
  });
  process.argv = withPlugin(process.argv, path.join(tsdk, "plugins"), registeredProjects().length > 0);
  require(config.tsserver);
}

/** @return `argv` with the shim added to its plugins, and `--canUseWatchEvents` dropped where `serving`: where a fabr project is registered. */
export function withPlugin(argv: readonly string[], probe: string, serving: boolean): string[] {
  const result = serving ? argv.filter(arg => arg !== "--canUseWatchEvents") : [...argv];
  const extend = (flag: string, value: string): void => {
    const at = result.indexOf(flag);
    if (at < 0 || at + 1 >= result.length) {
      result.push(flag, value);
    } else {
      result[at + 1] = `${result[at + 1]},${value}`;
    }
  };
  extend("--globalPlugins", SHIM_NAME);
  extend("--pluginProbeLocations", probe);
  return result;
}

/** Convert the wrapper's configuration, throwing where it names no tsserver or registry. */
function toWrapperConfig(json: unknown): IWrapperConfig {
  const record = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  if (typeof record.tsserver !== "string" || typeof record.registry !== "string") {
    throw new Error(`${CONFIG_FILE} must name the tsserver and the registry`);
  }
  return { tsserver: record.tsserver, registry: record.registry };
}
