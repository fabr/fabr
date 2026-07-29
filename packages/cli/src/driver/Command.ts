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

/** One command's help entry: its own argument synopsis (options that apply to it,
 * shown inline — `fabr <name> <synopsis>`) and a one-line summary. The set of
 * commands the command line accepts is derived from this table, so a new command
 * is added in exactly one place and is self-documenting.
 *
 * `build`/`test`/`run` are BUILD_OPERATION values; `ls`/`cat`/`cp`/`sync` are
 * driver-side verbs that build under BUILD_OPERATION=build and then list / dump /
 * copy-to-disk / publish the results; the `list-*` verbs are model-query verbs
 * that load the model and print without building anything (so they need no
 * targets). */
interface CommandSpec {
  name: string;
  synopsis: string;
  summary: string;
  /** The command-specific option flags this command accepts (canonical form —
   * `--quiet` is recorded as `-q`), used both for the synopsis and to *reject* a
   * flag applied to a command it means nothing for (`fabr cat --json`). The
   * universal options (`-D`, `-h`/`--help`, `-v`/`--version`) are always allowed
   * and are not listed here. `-q` is accepted by every command that runs build
   * steps but omitted from the synopses (like `-D`) to keep them focused. */
  accepts: string[];
  /** This command acts on exactly one target (`shell` stages a single sandbox),
   * so a second target is a usage error rather than being silently dropped.
   * `run` needs no marker — it captures one target and forwards the rest as the
   * program's argv. */
  singleTarget?: boolean;
}

const COMMAND_SPECS: CommandSpec[] = [
  { name: "build", synopsis: "[-w] <targets>", summary: "Build the given targets (the default command)", accepts: ["-w", "-q"] },
  { name: "test", synopsis: "[-w] <targets>", summary: "Build and run the given targets' tests", accepts: ["-w", "-q"] },
  { name: "run", synopsis: "[-w] <target> [args…]", summary: "Execute a target, forwarding trailing args to it", accepts: ["-w", "-q"] },
  { name: "shell", synopsis: "<target>", summary: "Stage a target's build sandbox and open a shell in it (debugging)", accepts: ["-q"], singleTarget: true },
  { name: "ls", synopsis: "[-l] <names>", summary: "Build the given targets and list their contents", accepts: ["-l", "-q"] },
  { name: "cat", synopsis: "<names>", summary: "Build a target and write its matching files to stdout", accepts: ["-q"] },
  { name: "cp", synopsis: "<sources…> <dest>", summary: "Build targets and copy their files to a destination directory", accepts: ["-q"] },
  { name: "sync", synopsis: "<target>", summary: "Build and publish a sync target to its destination coordinates", accepts: ["-q"] },
  {
    name: "list-targets",
    synopsis: "[-l] [--all] [--json] [names]",
    summary: "List the targets declared in the project",
    accepts: ["-l", "--all", "--json"],
  },
  {
    name: "list-targetdefs",
    synopsis: "[-l] [--json]",
    summary: "List the available target types and their properties",
    accepts: ["-l", "--json"],
  },
  {
    name: "list-properties",
    synopsis: "[-l] [--json]",
    summary: "List the global configuration properties and flags",
    accepts: ["-l", "--json"],
  },
  {
    name: "list-all",
    synopsis: "[--json]",
    summary: "Emit the whole vocabulary (types, properties, flags) as JSON, for tooling",
    accepts: ["--json"],
  },
];

const COMMANDS = new Set(COMMAND_SPECS.map((c) => c.name));
const COMMAND_BY_NAME = new Map(COMMAND_SPECS.map((c) => [c.name, c]));

/** Model-query verbs: they inspect the loaded model rather than building targets,
 * so a bare invocation (no targets) is a valid "list everything" request. */
const QUERY_COMMANDS = new Set(["list-targets", "list-targetdefs", "list-properties", "list-all"]);

export interface Options {
  command: string;
  mode: Mode;
  longListing: boolean;
  /** For the model-query verbs (`list-targets`/`list-targetdefs`): emit machine-
   * readable JSON instead of the human listing (the docs-generation interface). */
  json: boolean;
  /** For `list-targets`: include system-contributed targets (declared in core's
   * or a plugin's lib files) alongside the project's own, which are otherwise
   * the only ones listed. */
  all: boolean;
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
  /** Raw `-D` overrides, normalized into a Constraints at the driver's getConfig funnel. */
  properties: Map<string, string>;
}

/** Write the usage text to the given sink — stdout for an explicit `-h`/`--help`
 * or the bare no-target invocation (the de-facto help), stderr for a usage
 * *error*. Each command is listed with its own `fabr <name> <synopsis>` line so
 * the options that apply to it are visible in place; the Options section then
 * explains each flag once. */
function printUsage(write: (message: string) => void = console.log): void {
  /* Pad each `fabr <name> <synopsis>` to a common width so the summaries align. */
  const synopses = COMMAND_SPECS.map((c) => `fabr ${c.name} ${c.synopsis}`);
  const width = Math.max(...synopses.map((s) => s.length));
  const commandLines = COMMAND_SPECS.map(
    (c, i) => `  ${synopses[i].padEnd(width)}  ${c.summary}`
  ).join("\n");
  write(
    "Usage: fabr [command] [options] <targets>\n" +
      "The command defaults to 'build'; a target named like a command is reached by\n" +
      "giving the command explicitly first.\n\n" +
      "Commands:\n" +
      commandLines +
      "\n\nOptions:\n" +
      "  -DPROP=VALUE      Force the given property PROP to VALUE (before the target for run)\n" +
      "  -w                Watch mode: rebuild / re-run as inputs change (build/test/run)\n" +
      "  -l                Long listing: hash and size per file (ls), or source location (list-*)\n" +
      "  --json            Emit JSON (the list-* verbs)\n" +
      "  --all             Include system-contributed targets (list-targets)\n" +
      "  -q, --quiet       Suppress live subcommand output (shown by default as steps run)\n" +
      "  --                End of options: following arguments are targets, even if they start with '-'\n" +
      "  -h, --help        Print this help and exit\n" +
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
    all: false,
    quiet: false,
    targets: [],
    properties: new Map(),
  };
  const opts = args.slice(2);

  /* Command-specific flags seen, paired with their canonical form, validated
   * against the resolved command once the whole line is parsed — an option may
   * precede its command (`fabr -w test x`), so the command isn't yet known here. */
  const seenFlags: { raw: string; flag: string }[] = [];

  let commandGiven = false;
  let noMoreOptions = false;
  for (const arg of opts) {
    /* For `run`, once the target is captured everything else — flags included —
     * is passed verbatim to the program (fabr's own options go before it). */
    if (options.runArgs) {
      options.runArgs.push(arg);
    } else if (!noMoreOptions && arg === "--") {
      /* A bare `--` ends fabr's option parsing: every following argument is a
       * positional (a target/name), so a name that begins with `-` can be given.
       * Only the first `--` is special — a later one is an ordinary positional. */
      noMoreOptions = true;
    } else if (!noMoreOptions && arg[0] === "-") {
      if (arg === "-w") {
        options.mode = Mode.Watch;
        seenFlags.push({ raw: arg, flag: "-w" });
      } else if (arg === "-l") {
        options.longListing = true;
        seenFlags.push({ raw: arg, flag: "-l" });
      } else if (arg === "--json") {
        options.json = true;
        seenFlags.push({ raw: arg, flag: "--json" });
      } else if (arg === "--all") {
        options.all = true;
        seenFlags.push({ raw: arg, flag: "--all" });
      } else if (arg === "-q" || arg === "--quiet") {
        options.quiet = true;
        seenFlags.push({ raw: arg, flag: "-q" });
      } else if (arg === "-h" || arg === "--help") {
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
        options.properties.set(def.slice(0, eq).trim(), def.slice(eq + 1).trim());
      } else {
        usageError(`Unrecognized command-line option '${arg}'`);
      }
    } else if (!noMoreOptions && !commandGiven && options.targets.length === 0 && COMMANDS.has(arg)) {
      /* The first positional argument may name the operation; a target with the
       * same name is reached with an explicit command first (`fabr build test`)
       * or after `--`, which shields command words as it does `-`-leading names. */
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
  const spec = COMMAND_BY_NAME.get(options.command);
  /* Reject a flag applied to a command it means nothing for (`fabr cat --json`,
   * `fabr build -l`) rather than silently ignoring it. */
  const accepts = new Set(spec?.accepts);
  for (const { raw, flag } of seenFlags) {
    if (!accepts.has(flag)) {
      usageError(`Option '${raw}' is not valid for the '${options.command}' command`);
    }
  }
  /* A single-target command (`shell`) errors on a second target rather than
   * silently building only the first. */
  if (spec?.singleTarget && options.targets.length > 1) {
    usageError(`The '${options.command}' command takes a single target`);
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
