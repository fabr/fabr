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

/** The commands the command line can request. All except `ls`/`cat` are
 * BUILD_OPERATION values; `ls` and `cat` are driver-side verbs that build under
 * BUILD_OPERATION=build and then list / dump the results. */
const COMMANDS = new Set(["build", "test", "run", "ls", "cat"]);

export interface Options {
  command: string;
  mode: Mode;
  longListing: boolean;
  /** Target names, or (for `ls`/`cat`) whole name references — `pkg:build/*.js`
   * — resolved by the model, not split here. */
  targets: string[];
  /** For `run`: the program's argv — everything after the target, verbatim. */
  runArgs?: string[];
  properties: Constraints;
}

/** Write the usage text to the given sink — stdout for an explicit `-h` or the
 * bare no-target invocation (the de-facto help), stderr for a usage *error*. */
function printUsage(write: (message: string) => void = console.log): void {
  write(
    "Usage: fabr [command] [-w] <targets>\n" +
      "Commands:\n" +
      "  build             Build the given targets (the default)\n" +
      "  test              Run the given targets' tests\n" +
      "  run               Execute the given targets\n" +
      "  ls                Build the given targets and list their contents\n" +
      "  cat               Build a target and write its matching files to stdout\n" +
      "Options:\n" +
      "  -DPROP=VALUE      Force the given property PROP to VALUE\n" +
      "  -l                Long listing (with ls): hash and size per file\n" +
      "  -w                Watch mode\n"
  );
}

/** A malformed invocation: the diagnostic *and* the usage go to stderr (data
 * streams stay clean), and we exit non-zero. */
function usageError(message: string): never {
  console.error(message);
  printUsage(console.error);
  process.exit(1);
}

export function parseCommandLine(args: string[]): Options {
  const options: Options = { command: "build", mode: Mode.Normal, longListing: false, targets: [], properties: {} };
  const opts = args.slice(2);

  let commandGiven = false;
  for (const arg of opts) {
    /* For `run`, once the target is captured everything else — flags included —
     * is passed verbatim to the program (fabr's own options go before it). */
    if (options.runArgs) {
      options.runArgs.push(arg);
    } else if (arg[0] === "-") {
      if (arg === "-w") {
        options.mode = Mode.Watch;
      } else if (arg === "-l") {
        options.longListing = true;
      } else if (arg === "-h") {
        printUsage();
        process.exit(0);
      } else if (arg.startsWith("-D")) {
        /* -DKEY=VALUE: split at the *first* `=` so the value may contain more
         * (e.g. -DTSC=@npm:x:1); no `=` (or an empty key) is malformed. */
        const def = arg.substring(2);
        const eq = def.indexOf("=");
        if (eq <= 0) {
          usageError(`Malformed option '${arg}' (expected -DKEY=VALUE)`);
        }
        options.properties[def.slice(0, eq).trim()] = def.slice(eq + 1).trim();
      } else {
        usageError(`Unrecognized command-line option '${arg}'`);
      }
    } else if (!commandGiven && options.targets.length === 0 && COMMANDS.has(arg)) {
      /* The first positional argument may name the operation; a target with
       * the same name can be reached with an explicit command first */
      options.command = arg;
      commandGiven = true;
    } else {
      options.targets.push(arg);
      if (options.command === "run") {
        /* Target captured — the rest is the program's argv. */
        options.runArgs = [];
      }
    }
  }
  if (options.targets.length === 0) {
    printUsage();
    process.exit(0);
  }
  return options;
}
