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

import { existsSync, readFileSync } from "fs";
import { COVERAGE, COVERAGE_ON, parseJson, preferredOperation, TEST_EXPECTATIONS, TEST_NAME_PATTERN, toJsonObject, UPDATE_EXPECTATIONS } from "@fabr-build/core";
import { CommandLineSource } from "./CommandLineSource";
import { dirname, join } from "path";

/** @return the directory of the fabr installation this runs from: the CLI
 * package's own, the nearest directory above this module holding a
 * package.json. The compiled module's depth below the package root differs
 * between build layouts (`build/driver/` under the yarn/tsc devchain, but
 * `driver/` in the fabr-built package, which strips the outDir), and that
 * nearest package.json is the CLI's own in every layout: nothing above it is
 * looked at (an ancestor could be an unrelated package). Undefined where there
 * is none. */
export function installationDirectory(): string | undefined {
  for (let dir = __dirname; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

/** @return the fabr version, read from the CLI package's own package.json
 * ({@link installationDirectory}) at runtime. The version is stamped only at
 * release, so a present-but-versionless package.json is an unreleased build. */
export function getVersion(): string {
  const dir = installationDirectory();
  if (dir === undefined) {
    return "unknown";
  }
  try {
    const { version } = parseJson(readFileSync(join(dir, "package.json")), "fabr's package.json", toJsonObject);
    return typeof version === "string" ? version : "0.0.0-dev";
  } catch {
    return "unknown";
  }
}

export enum Mode {
  Normal,
  Watch,
}

/** The heading a command is listed under in the help. */
type CommandGroup = "Building" | "Inspecting" | "Project";

/** One command: its help entry, and the options it accepts. The set of commands
 * the command line accepts is derived from this table.
 *
 * `build`/`test`/`run` are BUILD_OPERATION values; `ls`/`cat`/`cp` are
 * driver-side verbs that materialize their names under the `files` operation and
 * then list / dump / copy-to-disk the results, and `sync` packages under
 * BUILD_OPERATION=build and publishes; the `list-*` verbs are model-query verbs
 * that load the model and print without building anything (so they need no
 * targets). */
interface CommandSpec {
  name: string;
  group: CommandGroup;
  /** The arguments written after `fabr <name>` in the command's usage line. */
  synopsis: string;
  summary: string;
  /** What the command's own help says beyond its summary, if anything. */
  description?: string;
  /** The command-specific option flags this command accepts, by their
   * {@link OptionSpec.flag}, used for its help and to *reject* a flag applied to
   * a command it means nothing for (`fabr cat --json`). The
   * {@link UNIVERSAL_OPTIONS} are always allowed and are not listed here. */
  accepts: string[];
  /** This command acts on exactly one target (`shell` stages a single sandbox),
   * so a second target is a usage error rather than being silently dropped.
   * `run` needs no marker — it captures one target and forwards the rest as the
   * program's argv. */
  singleTarget?: boolean;
  /** This command acts on the targets it is given, so naming none is a usage
   * error. */
  requiresTarget?: boolean;
}

/** One option flag's help entry. */
interface OptionSpec {
  /** The canonical form a command's `accepts` names it by (`--quiet` is `-q`). */
  flag: string;
  /** How the help writes it: its spellings and its argument. */
  usage: string;
  summary: string;
  /** What the option does for a particular command, where that differs from
   * `summary`, by command name. */
  summaries?: Map<string, string>;
  /** Left out of the help (`-f`, see {@link Options.force}). */
  hidden?: boolean;
}

/** The options every command that runs build steps accepts. */
const STEP_OPTIONS = ["-q", "--no-progress", "--refresh"];

const LIST_LONG = "Show where each is declared";

const OPTION_SPECS: OptionSpec[] = [
  { flag: "-w", usage: "-w", summary: "Watch mode: rebuild or re-run as inputs change" },
  { flag: "-u", usage: "-u, --update", summary: "Update recorded test expectations (snapshots) from the run" },
  { flag: "-t", usage: "-t PATTERN", summary: "Run only the tests whose names match the regular expression PATTERN" },
  { flag: "--coverage", usage: "--coverage[=DIR]", summary: "Measure code coverage and write DIR/lcov.info, coverage/ by default" },
  { flag: "--retry-failed", usage: "--retry-failed", summary: "Run again the tests whose last run failed, rather than report it from the cache" },
  { flag: "--report", usage: "--report FILE", summary: "Write the tests' results to FILE, failures included, as CTRF or with --format junit" },
  {
    flag: "--format",
    usage: "--format FORMAT",
    summary: "The report's format",
    summaries: new Map([
      ["audit", "Write the report as sarif instead of text"],
      ["test", "Write --report's file as ctrf (the default) or junit"],
    ]),
  },
  {
    flag: "-l",
    usage: "-l",
    summary: "Long listing",
    summaries: new Map([
      ["ls", "Show each file's hash and size"],
      ["list-targets", LIST_LONG],
      ["list-targetdefs", LIST_LONG],
      ["list-properties", LIST_LONG],
    ]),
  },
  { flag: "--json", usage: "--json", summary: "Write JSON instead of a listing" },
  { flag: "--all", usage: "--all", summary: "Include the targets core and the plugins declare" },
  { flag: "--operation", usage: "--operation OP", summary: "List only targets whose type has a rule for OP; repeatable" },
  { flag: "--include-optional", usage: "--include-optional", summary: "Read every optional lib of the plugins in use" },
  { flag: "-q", usage: "-q, --quiet", summary: "Suppress live output: step output and the progress display" },
  { flag: "--no-progress", usage: "--no-progress", summary: "No progress display; step output streams as it arrives" },
  { flag: "--refresh", usage: "--refresh", summary: "Re-check tags and version lists, however recently fetched" },
  { flag: "--trace", usage: "--trace[=FILE]", summary: "Trace the run's work to FILE, fabr-trace.json by default" },
  { flag: "-f", usage: "-f, --force", summary: "Rebuild the named targets even where cached", hidden: true },
];

/** The options every command accepts. */
const UNIVERSAL_OPTIONS: OptionSpec[] = [
  { flag: "-D", usage: "-DPROP=VALUE", summary: "Set the property PROP to VALUE" },
  { flag: "--", usage: "--", summary: "End of options: what follows are targets, even if they start with '-'" },
  { flag: "-h", usage: "-h, --help", summary: "Print help and exit" },
  { flag: "-v", usage: "-v, --version", summary: "Print the fabr version and exit" },
];

const OPTION_BY_FLAG = new Map(OPTION_SPECS.map((o) => [o.flag, o]));

const COMMAND_SPECS: CommandSpec[] = [
  {
    name: "build",
    group: "Building",
    synopsis: "[-w] <targets>",
    summary: "Build targets (the default command)",
    description:
      "With no command, each target takes the operation its type supports — build, else " +
      "test, else run — and a target that only runs takes the rest of the line as its own " +
      "arguments. A target named like a command is reached by giving the command first, or " +
      "after '--'. A project's rules may declare further operations, each a command of its " +
      "own (`fabr lint app`): 'fabr list-operations' lists them.",
    accepts: ["-w", ...STEP_OPTIONS, "--trace", "-f"],
    requiresTarget: true,
  },
  {
    name: "test",
    group: "Building",
    synopsis: "[-w] [-u] [-t PATTERN] [--coverage[=DIR]] [--retry-failed] [--report FILE [--format ctrf|junit]] <targets>",
    summary: "Build and run targets' tests",
    accepts: ["-w", "-u", "-t", "--coverage", "--retry-failed", "--report", "--format", ...STEP_OPTIONS, "--trace", "-f"],
    requiresTarget: true,
  },
  {
    name: "run",
    group: "Building",
    synopsis: "[-w] <target> [args…]",
    summary: "Run a target, passing it the arguments after it",
    description: "fabr's own options go before the target: everything after it is the program's, verbatim.",
    accepts: ["-w", ...STEP_OPTIONS, "--trace", "-f"],
    requiresTarget: true,
  },
  { name: "sync", group: "Building", synopsis: "<target>", summary: "Build a sync target and publish it to its destination", accepts: STEP_OPTIONS, requiresTarget: true },
  { name: "ls", group: "Inspecting", synopsis: "[-l] <names>", summary: "Build targets and list their files", accepts: ["-l", ...STEP_OPTIONS], requiresTarget: true },
  { name: "cat", group: "Inspecting", synopsis: "<names>", summary: "Build targets and write their files to stdout", accepts: STEP_OPTIONS, requiresTarget: true },
  {
    name: "cp",
    group: "Inspecting",
    synopsis: "<names…> <dest>",
    summary: "Build targets and copy their files into a directory",
    accepts: STEP_OPTIONS,
    requiresTarget: true,
  },
  {
    name: "shell",
    group: "Inspecting",
    synopsis: "<target>",
    summary: "Open a shell in a target's build sandbox",
    accepts: STEP_OPTIONS,
    singleTarget: true,
    requiresTarget: true,
  },
  { name: "deps", group: "Inspecting", synopsis: "<names>", summary: "Print the dependency tree of targets or packages", accepts: STEP_OPTIONS, requiresTarget: true },
  {
    name: "audit",
    group: "Inspecting",
    synopsis: "[--format sarif] <names>",
    summary: "Check dependencies for known security advisories",
    accepts: ["--format", ...STEP_OPTIONS],
    requiresTarget: true,
  },
  {
    name: "sbom",
    group: "Inspecting",
    synopsis: "<target>",
    summary: "Write a target's bill of materials (CycloneDX)",
    accepts: STEP_OPTIONS,
    singleTarget: true,
    requiresTarget: true,
  },
  {
    name: "list-targets",
    group: "Project",
    synopsis: "[-l] [--all] [--operation OP] [--json] [names or patterns]",
    summary: "List the project's targets and their operations",
    accepts: ["-l", "--all", "--operation", "--json"],
  },
  { name: "list-targetdefs", group: "Project", synopsis: "[-l] [--json]", summary: "List the target types and their properties", accepts: ["-l", "--json"] },
  { name: "list-operations", group: "Project", synopsis: "[--json]", summary: "List the operations the project's rules declare", accepts: ["--json"] },
  { name: "list-properties", group: "Project", synopsis: "[-l] [--json]", summary: "List the global properties and flags", accepts: ["-l", "--json"] },
  {
    name: "list-all",
    group: "Project",
    synopsis: "[--include-optional] [--json]",
    summary: "Write the whole vocabulary as JSON, for tooling",
    accepts: ["--include-optional", "--json"],
  },
  { name: "build-server", group: "Project", synopsis: "", summary: "Serve targets to an editor (Build Server Protocol)", accepts: ["-q"] },
];

const COMMAND_BY_NAME = new Map(COMMAND_SPECS.map((c) => [c.name, c]));
/** The command words: every command, and `help`. */
const COMMANDS = new Set([...COMMAND_BY_NAME.keys(), "help"]);

/** The options a command-less line may carry: those every command it can
 * resolve to (build, test, run) accepts. */
const INFERABLE_OPTIONS = new Set(
  ["build", "test", "run"].map((name) => COMMAND_BY_NAME.get(name)?.accepts ?? []).reduce((all, each) => all.filter((flag) => each.includes(flag)))
);

export interface Options {
  command: string;
  mode: Mode;
  longListing: boolean;
  /** For the model-query verbs (`list-*`): emit machine-readable JSON instead
   * of the human listing (the docs-generation interface). */
  json: boolean;
  /** For `list-targets`: include system-contributed targets (declared in core's
   * or a plugin's lib files) alongside the project's own, which are otherwise
   * the only ones listed. */
  all: boolean;
  /** For `list-all`: read every optional lib of each plugin the project uses,
   * as though the project included it. */
  includeOptional: boolean;
  /** Suppress the live subcommand output that is otherwise streamed to stderr as
   * build steps run (`-q`/`--quiet`), as well as the live progress display.
   */
  quiet: boolean;
  /** Show the live progress display when stderr is a terminal; false
   *  (`--no-progress`) logs as without one, streaming step output as it
   *  arrives. */
  progress: boolean;
  /** Revalidate every mutable document fetched this run — a registry's tag or
   * version list — however recently it was fetched (`--refresh`). */
  refresh: boolean;
  /**
   * Rebuild the named targets even when their outputs are already cached
   * (`-f`/`--force`) — a development aid for timing a build step, undocumented
   * for that reason. It reaches only the targets named on the command line and
   * the anonymous sub-targets they decompose into (the work whose time is being
   * measured); their dependencies build from cache as usual. Exclusive with
   * `-w`: a watch cycle would force the same target on every rebuild.
   */
  force: boolean;
  /** Run again the tests whose cached result failed (`--retry-failed`), rather
   * than report the cached failure. Exclusive with `-w`, as `-f` is. */
  retryFailed: boolean;
  /** Target names, or (for `ls`/`cat`/`cp`) whole name references — `pkg:build/*.js`
   * — resolved by the model, not split here. For `cp` the trailing destination
   * path has already been split off into `dest`. */
  targets: string[];
  /** For `run`: the program's argv — everything after the target, verbatim. */
  runArgs?: string[];
  /** For `cp`: the destination directory (the final positional), a plain
   * filesystem path resolved against the invocation cwd — not a model name. */
  dest?: string;
  /** For `audit --format`: the form the report takes instead of text; for
   * `test --format`: the form `--report` writes. */
  format?: ReportFormat;
  /** For `list-targets --operation`: the operations a listed target's type must
   *  have a rule for, any one of them. */
  operations?: string[];
  /** For `test --report <file>`: where the run's test report is written, a plain
   * filesystem path resolved against the invocation cwd. */
  reportFile?: string;
  /** For `test --coverage[=<dir>]`: the directory the coverage report is written
   * to, a plain filesystem path resolved against the invocation cwd. */
  coverageDir?: string;
  /** For `--trace[=<file>]`: where the run's trace is written, a plain
   * filesystem path resolved against the invocation cwd. */
  traceFile?: string;
  /** Raw `-D` overrides, normalized into a Constraints at the driver's getConfig funnel. */
  properties: Map<string, string>;
  /** The invocation as source text — what a name given here is *written in*, so
   * that resolving one reports against the command that gave it. */
  commandLine: CommandLineSource;
  /**
   * No command word was given: the arguments from the first positional onward,
   * verbatim and unparsed. Which verb each names depends on what its target's
   * type supports, and a target that only *runs* takes everything after it as
   * the program's own argv — neither of which is knowable until the model is
   * loaded, so the split is finished by {@link completeCommandLine}.
   */
  deferred?: string[];
}

/**
 * What a command-less invocation resolves to once the model can say what each
 * named target supports: the targets to build and to test (in the order
 * written), and at most one to run — being interactive, it is necessarily last
 * and takes the rest of the command line as its argv. Where the first word is
 * an operation a rule declares (`fabr lint app`), the targets are built under
 * that operation instead.
 */
export interface CommandPlan {
  build: string[];
  test: string[];
  run?: { target: string; args: string[] };
  operation?: { name: string; targets: string[] };
}

/** The widest the help is laid out: the terminal's width, at most 80 columns. */
function helpWidth(): number {
  return Math.min(process.stdout.columns || 80, 80);
}

/** Split `text` into lines of at most `width` columns, breaking between words
 * (a word longer than `width` stands on a line of its own), or between the
 * given `words` where `text` is a list of them. */
function wrap(text: string | string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of (typeof text === "string" ? text.split(" ") : text).filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  return line === "" ? lines : [...lines, line];
}

/** Lay out `rows` as an indented two-column list, each description wrapped
 * beside its term, a term too wide for the column on a line of its own. The
 * term column is `column` wide, or as wide as the widest term up to 18. */
function renderRows(rows: [string, string][], width: number, column = Math.min(Math.max(...rows.map(([term]) => term.length)), 18)): string[] {
  const indent = "  ";
  const pad = " ".repeat(indent.length + column + 2);
  return rows.flatMap(([term, text]) => {
    const lines = wrap(text, width - pad.length);
    if (term.length > column) {
      return [indent + term, ...lines.map((l) => pad + l)];
    }
    return [indent + term.padEnd(column) + "  " + (lines[0] ?? ""), ...lines.slice(1).map((l) => pad + l)];
  });
}

/** Lay out `Usage: fabr <command> <synopsis>`, a synopsis wider than the line
 * continued under its first argument, broken only between bracketed groups. */
function renderUsageLine(command: string, synopsis: string, width: number): string[] {
  const prefix = `Usage: fabr ${command} `;
  const groups: string[] = [];
  let depth = 0;
  let group = "";
  for (const char of synopsis) {
    if (char === " " && depth === 0) {
      groups.push(group);
      group = "";
      continue;
    }
    depth += char === "[" || char === "<" ? 1 : char === "]" || char === ">" ? -1 : 0;
    group += char;
  }
  groups.push(group);
  const lines = wrap(groups, width - prefix.length);
  if (lines.length === 0) {
    return [prefix.trimEnd()];
  }
  return [prefix + lines[0], ...lines.slice(1).map((l) => " ".repeat(prefix.length) + l)];
}

/** @return the option rows for `flags`, each described as it is for `command`. */
function optionRows(flags: Iterable<string>, command?: string): [string, string][] {
  return [...flags]
    .map((flag) => OPTION_BY_FLAG.get(flag))
    .filter((o): o is OptionSpec => o !== undefined && !o.hidden)
    .map((o) => [o.usage, (command !== undefined ? o.summaries?.get(command) : undefined) ?? o.summary]);
}

/** @return the help for fabr as a whole: the commands by group, and the options
 * of the commands a target's operation can select. */
function generalHelp(): string {
  const width = helpWidth();
  const groups = [...new Set(COMMAND_SPECS.map((c) => c.group))];
  const column = Math.max(...COMMAND_SPECS.map((c) => c.name.length));
  const universal: [string, string][] = UNIVERSAL_OPTIONS.map((o) => [o.usage, o.summary]);
  return [
    "Usage: fabr [command] [options] <targets>",
    "",
    ...wrap("With no command, each target is built, tested or run, whichever its type supports.", width),
    ...groups.flatMap((group) => [
      "",
      `${group}:`,
      ...renderRows(
        COMMAND_SPECS.filter((c) => c.group === group).map((c) => [c.name, c.summary]),
        width,
        column
      ),
    ]),
    "",
    "Options for build, test and run:",
    ...renderRows(optionRows(INFERABLE_OPTIONS), width),
    "",
    "Options for every command:",
    ...renderRows(universal, width),
    "",
    ...wrap(
      "Run 'fabr help <command>' for a command's options. A project's rules may declare further commands: 'fabr list-operations' lists them.",
      width
    ),
  ].join("\n");
}

/** @return the help for one command: its usage, what it does, and its options. */
function commandHelp(spec: CommandSpec): string {
  const width = helpWidth();
  const universal = UNIVERSAL_OPTIONS.filter((o) => o.flag !== "-v").map((o): [string, string] => [o.usage, o.summary]);
  return [
    ...renderUsageLine(spec.name, spec.synopsis, width),
    "",
    ...wrap(`${spec.summary}.`, width),
    ...(spec.description !== undefined ? ["", ...wrap(spec.description, width)] : []),
    "",
    "Options:",
    ...renderRows([...optionRows(spec.accepts, spec.name), ...universal], width),
  ].join("\n");
}

/** Print the help for `command` to stdout, or for fabr as a whole where none is
 * given, and exit. A name that is no command of fabr's is a usage error. */
function printHelp(command?: string): never {
  if (command === undefined || command === "help") {
    console.log(generalHelp());
  } else {
    const spec = COMMAND_BY_NAME.get(command);
    if (spec === undefined) {
      usageError(`Unknown command '${command}' (a project's own commands are listed by 'fabr list-operations')`);
    }
    console.log(commandHelp(spec));
  }
  process.exit(0);
}

/** Report a malformed invocation to stderr, followed by the help for `command`
 * where one is known and for fabr as a whole otherwise, and exit non-zero. */
function usageError(message: string, command?: string): never {
  const spec = command !== undefined ? COMMAND_BY_NAME.get(command) : undefined;
  console.error(`${message}\n`);
  console.error(spec !== undefined ? commandHelp(spec) : generalHelp());
  process.exit(1);
}

/** One option flag as written, with the canonical form it is validated as. */
type SeenFlag = { raw: string; flag: string };

/** The forms a report is written in: `audit`'s besides text, and `test --report`'s. */
export type ReportFormat = "sarif" | "ctrf" | "junit";
/** The formats each command's `--format` takes. */
const FORMATS = new Map<string, ReadonlyArray<ReportFormat>>([
  ["audit", ["sarif"]],
  ["test", ["ctrf", "junit"]],
]);
const ALL_FORMATS: ReadonlyArray<ReportFormat> = ["sarif", "ctrf", "junit"];

/** Where `--trace` writes the run's trace when not given a file. */
const DEFAULT_TRACE_FILE = "fabr-trace.json";

/** Where `--coverage` writes its report when not given a directory: jest's and
 * c8's convention. */
const DEFAULT_COVERAGE_DIR = "coverage";

/**
 * Apply one `-`-leading argument to the options being built, recording the
 * flags that are only meaningful to some commands for validation against the
 * command once it is known. Shared by the two parsing passes: the whole line
 * when a command was given, and (via {@link completeCommandLine}) the tail
 * deferred when one was not. `next` is the argument after `arg`, for an option
 * taking a value of its own; `command` is the command, where it was given before
 * `arg`, whose help a usage error shows.
 *
 * @return the number of arguments after `arg` the option consumed.
 */
function applyOption(arg: string, next: string | undefined, options: Options, seenFlags: SeenFlag[], command?: string): number {
  if (arg === "-t") {
    /* Sugar for the -D pathway, as -u is: which tests run is a build input. */
    if (next === undefined) {
      usageError(`Option '${arg}' requires a pattern`, command);
    }
    options.properties.set(TEST_NAME_PATTERN, next);
    seenFlags.push({ raw: arg, flag: "-t" });
    return 1;
  } else if (arg === "-w") {
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
  } else if (arg === "--include-optional") {
    options.includeOptional = true;
    seenFlags.push({ raw: arg, flag: arg });
  } else if (arg === "-u" || arg === "--update") {
    /* Sugar for the -D pathway: update mode IS a build input (a check run and
     * an update run are different builds and must not share a cache entry), so
     * it rides the ordinary constraint. */
    options.properties.set(TEST_EXPECTATIONS, UPDATE_EXPECTATIONS);
    seenFlags.push({ raw: arg, flag: "-u" });
  } else if (arg === "--format" || arg.startsWith("--format=")) {
    const given = arg === "--format" ? next : arg.slice("--format=".length);
    if (given === undefined) {
      usageError(`Option '--format' requires a format: ${ALL_FORMATS.join(", ")}`, command);
    }
    const format = ALL_FORMATS.find(each => each === given);
    if (format === undefined) {
      usageError(`Option '--format' takes ${ALL_FORMATS.join(", ")}, not '${given}'`, command);
    }
    options.format = format;
    seenFlags.push({ raw: arg, flag: "--format" });
    return arg === "--format" ? 1 : 0;
  } else if (arg === "--report" || arg.startsWith("--report=")) {
    const file = arg === "--report" ? next : arg.slice("--report=".length);
    if (!file) {
      usageError("Option '--report' requires a file", command);
    }
    options.reportFile = file;
    seenFlags.push({ raw: arg, flag: "--report" });
    return arg === "--report" ? 1 : 0;
  } else if (arg === "--operation" || arg.startsWith("--operation=")) {
    const operation = arg === "--operation" ? next : arg.slice("--operation=".length);
    if (!operation) {
      usageError("Option '--operation' requires an operation", command);
    }
    options.operations = [...(options.operations ?? []), operation];
    seenFlags.push({ raw: arg, flag: "--operation" });
    return arg === "--operation" ? 1 : 0;
  } else if (arg === "--coverage" || arg.startsWith("--coverage=")) {
    /* Sugar for the -D pathway, as -u is: a measured build is a build input. */
    options.properties.set(COVERAGE, COVERAGE_ON);
    options.coverageDir = arg === "--coverage" ? DEFAULT_COVERAGE_DIR : arg.slice("--coverage=".length);
    seenFlags.push({ raw: arg, flag: "--coverage" });
  } else if (arg === "--trace" || arg.startsWith("--trace=")) {
    options.traceFile = arg === "--trace" ? DEFAULT_TRACE_FILE : arg.slice("--trace=".length);
    seenFlags.push({ raw: arg, flag: "--trace" });
  } else if (arg === "-q" || arg === "--quiet") {
    options.quiet = true;
    seenFlags.push({ raw: arg, flag: "-q" });
  } else if (arg === "--no-progress") {
    options.progress = false;
    seenFlags.push({ raw: arg, flag: arg });
  } else if (arg === "--refresh") {
    options.refresh = true;
    seenFlags.push({ raw: arg, flag: arg });
  } else if (arg === "--retry-failed") {
    options.retryFailed = true;
    seenFlags.push({ raw: arg, flag: arg });
  } else if (arg === "-f" || arg === "--force") {
    options.force = true;
    seenFlags.push({ raw: arg, flag: "-f" });
  } else if (arg === "-h" || arg === "--help") {
    /* Printed once the command is known: the help is that command's. */
    seenFlags.push({ raw: arg, flag: "-h" });
  } else if (arg === "--version" || arg === "-v") {
    console.log(`fabr ${getVersion()}`);
    process.exit(0);
  } else if (arg.startsWith("-D")) {
    /* -DKEY=VALUE: split at the *first* `=` so the value may contain more
     * (e.g. -DTSC=@npm:x:1); no `=` (or an empty key) is malformed. */
    const def = arg.substring(2);
    const eq = def.indexOf("=");
    if (eq <= 0) {
      usageError(`Malformed option '${arg}' (expected -DKEY=VALUE)`, command);
    }
    options.properties.set(def.slice(0, eq).trim(), def.slice(eq + 1).trim());
  } else {
    usageError(`Unrecognized command-line option '${arg}'`, command);
  }
  return 0;
}

/** Refuse `-f` combined with `-w`. `-f` forces a rebuild of what was named
 * *this* invocation; under `-w` there
 * is no such thing — every cycle would rebuild it, so the two together are more
 * likely a mistake than a request. Checked after each parsing pass, since the
 * two flags can land in different ones (`fabr -f x -w`). The error shows the
 * help for `command`, where one was given. */
function checkFlagsCoherent(options: Options, command?: string): void {
  if (options.force && options.mode === Mode.Watch) {
    usageError("Options '-f' and '-w' cannot be combined", command);
  }
  if (options.retryFailed && options.mode === Mode.Watch) {
    usageError("Options '--retry-failed' and '-w' cannot be combined", command);
  }
}

export function parseCommandLine(args: string[]): Options {
  const options: Options = {
    command: "build",
    mode: Mode.Normal,
    longListing: false,
    json: false,
    all: false,
    includeOptional: false,
    quiet: false,
    progress: true,
    refresh: false,
    force: false,
    retryFailed: false,
    targets: [],
    properties: new Map(),
    commandLine: new CommandLineSource(args.slice(2)),
  };
  const opts = args.slice(2);

  /* Command-specific flags seen, paired with their canonical form, validated
   * against the resolved command once the whole line is parsed — an option may
   * precede its command (`fabr -w test x`), so the command isn't yet known here. */
  const seenFlags: SeenFlag[] = [];

  let commandGiven = false;
  let noMoreOptions = false;
  let consumed = 0;
  for (const [index, arg] of opts.entries()) {
    /* For `run`, once the target is captured everything else — flags included —
     * is passed verbatim to the program (fabr's own options go before it). */
    if (consumed > 0) {
      consumed--;
    } else if (options.runArgs) {
      options.runArgs.push(arg);
    } else if (!noMoreOptions && arg === "--") {
      /* A bare `--` ends fabr's option parsing: every following argument is a
       * positional (a target/name), so a name that begins with `-` can be given.
       * Only the first `--` is special — a later one is an ordinary positional. */
      noMoreOptions = true;
    } else if (!noMoreOptions && arg[0] === "-") {
      consumed = applyOption(arg, opts[index + 1], options, seenFlags, commandGiven ? options.command : undefined);
    } else if (!noMoreOptions && !commandGiven && options.targets.length === 0 && COMMANDS.has(arg)) {
      /* The first positional argument may name the operation; a target with the
       * same name is reached with an explicit command first (`fabr build test`)
       * or after `--`, which shields command words as it does `-`-leading names. */
      options.command = arg;
      commandGiven = true;
    } else if (!commandGiven) {
      /* No command word: this positional's verb depends on what its target
       * supports, and a run-only one takes everything after it as the program's
       * argv — so the rest of the line waits for the model (completeCommandLine).
       * A `--` already seen rides along at the head, since the deferred pass
       * re-reads the remainder under the same rules. */
      options.deferred = noMoreOptions ? ["--", ...opts.slice(index)] : opts.slice(index);
      break;
    } else {
      options.targets.push(arg);
      if (options.command === "run") {
        /* Target captured — the rest is the program's argv. */
        options.runArgs = [];
      }
    }
  }
  if (options.command === "help") {
    printHelp(options.targets[0]);
  }
  if (seenFlags.some(({ flag }) => flag === "-h")) {
    printHelp(commandGiven ? options.command : undefined);
  }
  const spec = COMMAND_BY_NAME.get(options.command);
  /* Reject a flag applied to a command it means nothing for (`fabr cat --json`,
   * `fabr build -l`) rather than silently ignoring it. */
  const accepts = new Set(spec?.accepts);
  for (const { raw, flag } of seenFlags) {
    if (!accepts.has(flag)) {
      usageError(`Option '${raw}' is not valid for the '${options.command}' command`, options.command);
    }
  }
  const formats = FORMATS.get(options.command) ?? [];
  if (options.format !== undefined && !formats.includes(options.format)) {
    usageError(`Option '--format' takes ${formats.join(" or ")} for the '${options.command}' command, not '${options.format}'`, options.command);
  }
  if (options.command === "test" && options.format !== undefined && options.reportFile === undefined) {
    usageError("Option '--format' needs '--report FILE' for the 'test' command", "test");
  }
  /* A single-target command (`shell`) errors on a second target rather than
   * silently building only the first. */
  if (spec?.singleTarget && options.targets.length > 1) {
    usageError(`The '${options.command}' command takes a single target`, options.command);
  }
  if (options.command === "cp") {
    /* `cp <source…> <dest>`: the final positional is the destination directory,
     * split off here so `targets` carries only source names (resolved like
     * cat/ls). At least one source plus a dest are required. */
    if (options.targets.length < 2) {
      usageError("cp requires at least one source and a destination directory", "cp");
    }
    options.dest = options.targets.pop();
  }
  if (options.targets.length === 0 && !options.deferred) {
    if (!commandGiven) {
      printHelp();
    }
    if (spec?.requiresTarget) {
      usageError(`The '${options.command}' command requires a target`, options.command);
    }
  }
  checkFlagsCoherent(options, commandGiven ? options.command : undefined);
  return options;
}

/**
 * Finish parsing a command-less invocation, now that the model can say what
 * each named target's type supports: each positional takes the operation it
 * supports (build, else test, else run — see core's {@link preferredOperation}),
 * defaulting to `build` for a name that supports none, which then reports as
 * the ordinary "no rule matches" failure. A target that *runs* ends the line:
 * everything after it is the program's own argv, so an inferred run cannot be
 * followed by more fabr arguments. Options found in the tail apply as they
 * would anywhere else; only those every inferable command accepts are allowed.
 * Where the first word is one of `operations`, the operations a rule declares,
 * it is the command, and every positional after it a target built under it.
 *
 * Mutates `options` (it is the same parse, resumed) and returns the plan.
 */
export function completeCommandLine(
  options: Options,
  operationsOf: (target: string) => string[],
  operations: ReadonlySet<string> = new Set()
): CommandPlan {
  const deferred = options.deferred ?? [];
  const plan: CommandPlan = { build: [], test: [] };
  const seenFlags: SeenFlag[] = [];
  let noMoreOptions = false;
  let consumed = 0;
  /* An operation a rule declares is a command, as `build` is, over a target of the same name. */
  const operation = deferred.length > 0 && operations.has(deferred[0]) ? { name: deferred[0], targets: [] as string[] } : undefined;
  for (const [index, arg] of deferred.entries()) {
    if (consumed > 0) {
      consumed--;
    } else if (operation !== undefined && index === 0) {
      plan.operation = operation;
    } else if (!noMoreOptions && arg === "--") {
      noMoreOptions = true;
    } else if (!noMoreOptions && arg[0] === "-") {
      consumed = applyOption(arg, deferred[index + 1], options, seenFlags);
    } else if (operation !== undefined) {
      operation.targets.push(arg);
    } else {
      const operation = preferredOperation(operationsOf(arg)) ?? "build";
      if (operation === "run") {
        plan.run = { target: arg, args: deferred.slice(index + 1) };
        break;
      }
      (operation === "test" ? plan.test : plan.build).push(arg);
    }
  }
  if (seenFlags.some(({ flag }) => flag === "-h")) {
    printHelp();
  }
  /* A flag meaningful only to some command a target cannot select needs that
   * command written out. */
  for (const { raw, flag } of seenFlags) {
    if (!INFERABLE_OPTIONS.has(flag)) {
      usageError(`Option '${raw}' is not valid without a command`);
    }
  }
  if (operation !== undefined && operation.targets.length === 0) {
    usageError(`The '${operation.name}' command requires a target`);
  }
  checkFlagsCoherent(options);
  options.targets = [...plan.build, ...plan.test, ...(plan.run ? [plan.run.target] : []), ...(operation?.targets ?? [])];
  options.runArgs = plan.run?.args;
  return plan;
}
