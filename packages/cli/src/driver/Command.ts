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

import { Constraints } from "@fabr-build/core";
import { readFileSync } from "fs";
import { dirname, join } from "path";

/** The fabr version, read from the CLI package's own package.json at runtime.
 * The compiled module's depth below the package root differs between build
 * layouts (`build/driver/` under the yarn/tsc devchain, but `driver/` in the
 * fabr-built package, which strips the outDir), so rather than hardcode a hop
 * count we walk up to the *nearest* package.json — the CLI's own in every
 * layout. That first hit is authoritative: we never climb past it (an ancestor
 * could be an unrelated package). The version is stamped only at release, so a
 * present-but-versionless package.json is an unreleased build. */
function getVersion(): string {
  for (let dir = __dirname; ; ) {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "0.0.0-dev";
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        return "unknown";
      }
      dir = parent;
    }
  }
}

export enum Mode {
  Normal,
  Watch,
}

/** The commands the command line can request. `build`/`test`/`run` are
 * BUILD_OPERATION values; `ls`/`cat`/`cp`/`sync` are driver-side verbs that build
 * under BUILD_OPERATION=build and then list / dump / copy-to-disk / publish the
 * results; `list-targetdefs` is a model-query verb that loads the model and prints
 * without building anything (so it needs no targets). */
const COMMANDS = new Set(["build", "test", "run", "shell", "ls", "cat", "cp", "sync", "list-targets", "list-targetdefs"]);

/** Model-query verbs: they inspect the loaded model rather than building targets,
 * so a bare invocation (no targets) is a valid "list everything" request. */
const QUERY_COMMANDS = new Set(["list-targets", "list-targetdefs"]);

export interface Options {
  command: string;
  mode: Mode;
  longListing: boolean;
  /** For the model-query verbs (`list-targets`/`list-targetdefs`): emit machine-
   * readable JSON instead of the human listing (the docs-generation interface). */
  json: boolean;
  /** Suppress the live subcommand output that is otherwise streamed to stderr as
   * build steps run (`-q`/`--quiet`); failure messages still include it. */
  quiet: boolean;
  /** Target names, or (for `ls`/`cat`/`cp`) whole name references — `pkg:build/*.js`
   * — resolved by the model, not split here. For `cp` the trailing destination
   * path has already been split off into `dest`. */
  targets: string[];
  /** For `run`: the program's argv — everything after the target, verbatim. */
  runArgs?: string[];
  /** For `cp`: the destination directory (the final positional), a plain
   * filesystem path resolved against the invocation cwd — not a model name. */
  dest?: string;
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
      "  shell             Stage a target's build sandbox and open a shell in it (debugging)\n" +
      "  ls                Build the given targets and list their contents\n" +
      "  cat               Build a target and write its matching files to stdout\n" +
      "  cp                Build targets and copy their files to a destination directory\n" +
      "  list-targets      List the targets declared in the project\n" +
      "  list-targetdefs   List the available target types and their properties\n" +
      "Options:\n" +
      "  -DPROP=VALUE      Force the given property PROP to VALUE\n" +
      "  -l                Long listing: hash and size per file (ls), or source location (list-*)\n" +
      "  --json            Emit JSON (list-targets / list-targetdefs)\n" +
      "  -w                Watch mode\n" +
      "  -q, --quiet       Suppress live subcommand output (shown by default as steps run)\n" +
      "  -v, --version     Print the fabr version and exit\n"
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
  const options: Options = {
    command: "build",
    mode: Mode.Normal,
    longListing: false,
    json: false,
    quiet: false,
    targets: [],
    properties: {},
  };
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
      } else if (arg === "--json") {
        options.json = true;
      } else if (arg === "-q" || arg === "--quiet") {
        options.quiet = true;
      } else if (arg === "-h") {
        printUsage();
        process.exit(0);
      } else if (arg === "--version" || arg === "-v") {
        console.log(`fabr ${getVersion()}`);
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
  if (options.command === "cp") {
    /* `cp <source…> <dest>`: the final positional is the destination directory,
     * split off here so `targets` carries only source names (resolved like
     * cat/ls). At least one source plus a dest are required. */
    if (options.targets.length < 2) {
      usageError("cp requires at least one source and a destination directory");
    }
    options.dest = options.targets.pop();
  }
  if (options.targets.length === 0 && !QUERY_COMMANDS.has(options.command)) {
    printUsage();
    process.exit(0);
  }
  return options;
}
