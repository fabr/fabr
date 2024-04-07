/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { Constraints } from "../model/BuildContext";
import { Property } from "../model/Property";

export enum Mode {
  Normal,
  Watch,
}

export interface Options {
  mode: Mode;
  targets: string[];
  properties: Constraints;
}

function printUsage(): void {
  console.log(
    "Usage: fabrjs [-nw] <targets>\n" +
      "Options:\n" +
      "  -DPROP=VALUE      Force the given property PROP to VALUE\n" +
      "  -w                Watch mode\n"
  );
}

function parseDefine(def: string): [string, string] {
  const arr = def.split("=", 2);
  return [arr[0].trim(), arr[1]?.trim()];
}

export function parseCommandLine(args: string[]): Options {
  const options: Options = { mode: Mode.Normal, targets: [], properties: {} };
  const [node, script, ...opts] = args;

  for (const arg of opts) {
    if (arg[0] === "-") {
      if (arg === "-w") {
        options.mode = Mode.Watch;
      } else if (arg === "-h") {
        printUsage();
        process.exit(0);
      } else if (arg.startsWith("-D")) {
        const [key, value] = parseDefine(arg.substring(2));
        options.properties[key] = new Property([value]);
      } else {
        console.error(`Unrecognized command-line option '${arg}'`);
        printUsage();
        process.exit(1);
      }
    } else {
      options.targets.push(arg);
    }
  }
  if (options.targets.length === 0) {
    printUsage();
    process.exit(0);
  }
  return options;
}
