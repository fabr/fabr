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

import { Constraints } from "@fabr/core";

export enum Mode {
  Normal,
  Watch,
}

/** The commands the command line can request. All except `ls` are
 * BUILD_OPERATION values; `ls` is a driver-side verb that builds under
 * BUILD_OPERATION=build and then lists the results. */
const COMMANDS = new Set(["build", "test", "run", "ls"]);

export interface Options {
  command: string;
  mode: Mode;
  longListing: boolean;
  targets: string[];
  properties: Constraints;
}

function printUsage(): void {
  console.log(
    "Usage: fabrjs [command] [-w] <targets>\n" +
      "Commands:\n" +
      "  build             Build the given targets (the default)\n" +
      "  test              Run the given targets' tests\n" +
      "  run               Execute the given targets\n" +
      "  ls                Build the given targets and list their contents\n" +
      "Options:\n" +
      "  -DPROP=VALUE      Force the given property PROP to VALUE\n" +
      "  -l                Long listing (with ls): hash and size per file\n" +
      "  -w                Watch mode\n"
  );
}

function parseDefine(def: string): [string, string] {
  const arr = def.split("=", 2);
  return [arr[0].trim(), arr[1]?.trim()];
}

export function parseCommandLine(args: string[]): Options {
  const options: Options = { command: "build", mode: Mode.Normal, longListing: false, targets: [], properties: {} };
  const opts = args.slice(2);

  let commandGiven = false;
  for (const arg of opts) {
    if (arg[0] === "-") {
      if (arg === "-w") {
        options.mode = Mode.Watch;
      } else if (arg === "-l") {
        options.longListing = true;
      } else if (arg === "-h") {
        printUsage();
        process.exit(0);
      } else if (arg.startsWith("-D")) {
        const [key, value] = parseDefine(arg.substring(2));
        options.properties[key] = value;
      } else {
        console.error(`Unrecognized command-line option '${arg}'`);
        printUsage();
        process.exit(1);
      }
    } else if (!commandGiven && options.targets.length === 0 && COMMANDS.has(arg)) {
      /* The first positional argument may name the operation; a target with
       * the same name can be reached with an explicit command first */
      options.command = arg;
      commandGiven = true;
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
