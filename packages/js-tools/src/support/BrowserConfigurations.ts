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
 * The browser configuration a browser test's runner is given: declared as
 * `--browser=<configuration>=<browser>`, its name the target's and its
 * browser by the framework's name for it, with `--browser-executable`,
 * `--browser-viewport`, `--browser-user-agent` and `--browser-device` options
 * of the same `<configuration>=<value>` form.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The browser configuration, as given. */
export interface IBrowserConfiguration {
  name: string;
  /** The framework's name for the browser (`chromium`, `webkit`, `chrome`). */
  browser: string;
  /** The browser's executable, by its real path, where fabr fetched it. */
  executable?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  /** The device to emulate, by the framework's name for it. */
  device?: string;
}

/** The option prefix every configuration option has. */
const PREFIX = "--browser";

/** @return true if `arg` is a browser configuration option, otherwise false. */
export function isConfigurationOption(arg: string): boolean {
  return arg.startsWith(`${PREFIX}=`) || arg.startsWith(`${PREFIX}-`);
}

/**
 * Read the browser configuration among `argv`, its executable by its real
 * path, which its content fixes, so a browser keeps one location from run to
 * run (a firewall's permission for it holds); undefined where none is
 * declared. Throws for a second configuration, an option naming one not
 * declared, or a malformed option.
 */
export function configurationOf(argv: ReadonlyArray<string>): IBrowserConfiguration | undefined {
  const configurations = new Map<string, IBrowserConfiguration>();
  const options = argv.filter(isConfigurationOption).map(arg => {
    const equals = arg.indexOf("=");
    const option = arg.substring(0, equals);
    const written = arg.substring(equals + 1);
    const separator = written.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Expected '${option}=<configuration>=<value>', got '${arg}'`);
    }
    return { option, name: written.substring(0, separator), value: written.substring(separator + 1) };
  });
  for (const { name, value } of options.filter(({ option }) => option === PREFIX)) {
    if (configurations.size > 0) {
      throw new Error(`'${PREFIX}=${name}=${value}' declares a second browser configuration; a run has one`);
    }
    configurations.set(name, { name, browser: value });
  }
  for (const { option, name, value } of options.filter(({ option }) => option !== PREFIX)) {
    const configuration = configurations.get(name);
    if (configuration === undefined) {
      throw new Error(`'${option}' names '${name}', which no '${PREFIX}=' option declares`);
    }
    switch (option) {
      case `${PREFIX}-executable`:
        configuration.executable = fs.realpathSync(path.resolve(value));
        break;
      case `${PREFIX}-viewport`: {
        const [width, height] = value.split("x").map(Number);
        configuration.viewport = { width, height };
        break;
      }
      case `${PREFIX}-user-agent`:
        configuration.userAgent = value;
        break;
      case `${PREFIX}-device`:
        configuration.device = value;
        break;
      default:
        throw new Error(`Unknown browser configuration option '${option}'`);
    }
  }
  return [...configurations.values()][0];
}
