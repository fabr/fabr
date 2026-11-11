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

import { expect } from "chai";
import { completeCommandLine, Mode, Options, parseCommandLine } from "./Command";

/** The parse result minus the invocation's source text: that is the command
 * line carried along for the driver to report names against, not an outcome of
 * parsing it — so the exhaustive comparisons below stay about the outcome. */
function parsed(args: string[]): Omit<Options, "commandLine"> {
  const { commandLine, ...outcome } = parseCommandLine(args);
  void commandLine;
  return outcome;
}

/** Thrown by the stubbed process.exit to unwind parseCommandLine. */
class ExitSignal extends Error {}

/** Run parseCommandLine capturing an exit code and the stdout/stderr writes, so
 * the error/usage paths (which call process.exit) are testable in-process.
 * `operationsOf` additionally finishes a command-less line ({@link
 * completeCommandLine}), whose own usage errors exit the same way. */
function capture(
  args: string[],
  operationsOf?: (target: string) => string[],
  declared?: ReadonlySet<string>
): { exit?: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exit: number | undefined;
  process.exit = ((code?: number) => {
    exit = code ?? 0;
    throw new ExitSignal();
  }) as unknown as typeof process.exit;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  try {
    const options = parseCommandLine(["node", "fabr", ...args]);
    if (operationsOf) {
      completeCommandLine(options, operationsOf, declared);
    }
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { exit, out, err };
}

describe("Command", () => {
  it("defers the targets when no command is given", () => {
    /* What each names can only be decided against the model, so parsing stops
     * at the first positional and the rest is kept verbatim. */
    expect(parsed(["node", "fabr", "foo"])).to.deep.equal({
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
      deferred: ["foo"],
      properties: new Map(),
    });
  });

  it("parses an explicit command", () => {
    expect(parsed(["node", "fabr", "test", "foo", "bar"])).to.deep.equal({
      command: "test",
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
      targets: ["foo", "bar"],
      properties: new Map(),
    });
  });

  it("treats later command-words as targets", () => {
    expect(parseCommandLine(["node", "fabr", "build", "test"]).targets).to.deep.equal(["test"]);
  });

  it("parses flags and defines alongside a command", () => {
    /* Not `run`: for `run`, options after the target pass through to the program */
    expect(parsed(["node", "fabr", "-w", "test", "foo", "-Dx=1"])).to.deep.equal({
      command: "test",
      mode: Mode.Watch,
      longListing: false,
      json: false,
      all: false,
      includeOptional: false,
      quiet: false,
      progress: true,
      refresh: false,
      force: false,
      retryFailed: false,
      targets: ["foo"],
      properties: new Map([["x", "1"]]),
    });
  });

  it("parses the ls command with the long-listing flag", () => {
    expect(parsed(["node", "fabr", "ls", "-l", "foo", "bar"])).to.deep.equal({
      command: "ls",
      mode: Mode.Normal,
      longListing: true,
      json: false,
      all: false,
      includeOptional: false,
      quiet: false,
      progress: true,
      refresh: false,
      force: false,
      retryFailed: false,
      targets: ["foo", "bar"],
      properties: new Map(),
    });
  });

  it("treats ls after another command as a target", () => {
    expect(parseCommandLine(["node", "fabr", "build", "ls"]).targets).to.deep.equal(["ls"]);
  });

  it("parses --include-optional for list-all, and refuses it elsewhere", () => {
    expect(parseCommandLine(["node", "fabr", "list-all", "--include-optional", "--json"]).includeOptional).to.equal(true);
    const { exit, err } = capture(["list-targets", "--include-optional"]);
    expect(exit).to.equal(1);
    expect(err.join("\n")).to.match(/Option '--include-optional' is not valid for the 'list-targets' command/);
  });

  it("parses the --json flag for a query command", () => {
    const options = parseCommandLine(["node", "fabr", "list-targetdefs", "--json"]);
    expect(options.command).to.equal("list-targetdefs");
    expect(options.json).to.be.true;
    expect(options.targets).to.deep.equal([]);
  });

  it("keeps cat name references whole (the model resolves the projection)", () => {
    const options = parseCommandLine(["node", "fabr", "cat", "mypkg:build/out.js", "b:src/*.ts"]);
    expect(options.command).to.equal("cat");
    expect(options.targets).to.deep.equal(["mypkg:build/out.js", "b:src/*.ts"]);
  });

  it("passes everything after a run target through as program args, flags included", () => {
    const options = parseCommandLine(["node", "fabr", "run", "mytool", "--flag", "x", "-y"]);
    expect(options.command).to.equal("run");
    expect(options.targets).to.deep.equal(["mytool"]);
    expect(options.runArgs).to.deep.equal(["--flag", "x", "-y"]);
  });

  it("takes fabr options before the run target, program args after", () => {
    const options = parseCommandLine(["node", "fabr", "-Dx=1", "run", "mytool", "-Dy=2"]);
    expect(options.properties).to.deep.equal(new Map([["x", "1"]]));
    expect(options.targets).to.deep.equal(["mytool"]);
    expect(options.runArgs).to.deep.equal(["-Dy=2"]);
  });

  it("splits -D at the first '=', so the value may itself contain '='/':'", () => {
    expect(parseCommandLine(["node", "fabr", "-DTSC=@npm:typescript:5.4.5", "foo"]).properties).to.deep.equal(
      new Map([["TSC", "@npm:typescript:5.4.5"]])
    );
  });

  it("rejects a -D with no '=' — error + usage to stderr, exit 1, nothing on stdout", () => {
    const { exit, out, err } = capture(["-DFOO"]);
    expect(exit).to.equal(1);
    expect(err.join("\n")).to.match(/Malformed option '-DFOO'/);
    expect(out).to.deep.equal([]);
  });

  it("sends an unrecognized-option error and the help to stderr, not stdout", () => {
    const { exit, out, err } = capture(["--bogus"]);
    expect(exit).to.equal(1);
    expect(err[0]).to.equal("Unrecognized command-line option '--bogus'\n");
    expect(err[1]).to.equal(capture(["-h"]).out.join("\n"));
    expect(out).to.deep.equal([]);
  });

  it("prints usage to stdout and exits 0 with no target (the de-facto help)", () => {
    const { exit, out, err } = capture([]);
    expect(exit).to.equal(0);
    expect(out.join("\n")).to.match(/Usage: fabr/);
    expect(err).to.deep.equal([]);
  });

  for (const command of ["build", "test", "run", "shell", "ls", "cat", "sync"]) {
    it(`rejects '${command}' with no target — error + the command's help on stderr, exit 1`, () => {
      const { exit, out, err } = capture([command]);
      expect(exit).to.equal(1);
      expect(err).to.deep.equal([`The '${command}' command requires a target\n`, ...capture(["help", command]).out]);
      expect(out).to.deep.equal([]);
    });
  }

  it("still lists with no names for a query command", () => {
    expect(capture(["list-targets"]).exit).to.equal(undefined);
  });

  it("rejects a flag that doesn't apply to the command (cat --json)", () => {
    const { exit, out, err } = capture(["cat", "foo", "--json"]);
    expect(exit).to.equal(1);
    expect(err.join("\n")).to.match(/Option '--json' is not valid for the 'cat' command/);
    expect(out).to.deep.equal([]);
  });

  it("rejects -l on build and -w on ls", () => {
    expect(capture(["build", "-l", "foo"]).err.join("\n")).to.match(/'-l' is not valid for the 'build'/);
    expect(capture(["ls", "-w", "foo"]).err.join("\n")).to.match(/'-w' is not valid for the 'ls'/);
  });

  it("turns coverage on with --coverage, writing to coverage/ or the directory given", () => {
    const plain = parseCommandLine(["node", "fabr", "test", "--coverage", "foo"]);
    expect(plain.properties.get("COVERAGE")).to.equal("on");
    expect(plain.coverageDir).to.equal("coverage");
    expect(parseCommandLine(["node", "fabr", "test", "--coverage=out/cov", "foo"]).coverageDir).to.equal("out/cov");
    expect(parseCommandLine(["node", "fabr", "test", "foo"]).coverageDir).to.equal(undefined);
    expect(capture(["build", "--coverage", "foo"]).err.join("\n")).to.match(/'--coverage' is not valid for the 'build'/);
  });

  it("refuses an empty --coverage= or --trace=", () => {
    expect(capture(["test", "--coverage=", "foo"]).err.join("\n")).to.match(/'--coverage=' requires a directory/);
    expect(capture(["build", "--trace=", "foo"]).err.join("\n")).to.match(/'--trace=' requires a file/);
  });

  it("selects tests by name with -t, its pattern the next argument and not a target", () => {
    const parsed = parseCommandLine(["node", "fabr", "test", "-t", "dates parse", "foo"]);
    expect(parsed.properties.get("TEST_NAME_PATTERN")).to.equal("dates parse");
    expect(parsed.targets).to.deep.equal(["foo"]);
    expect(parseCommandLine(["node", "fabr", "test", "foo", "-t", "-x"]).properties.get("TEST_NAME_PATTERN")).to.equal("-x");
    expect(capture(["test", "foo", "-t"]).err.join("\n")).to.match(/'-t' requires a pattern/);
    expect(capture(["build", "-t", "x", "foo"]).err.join("\n")).to.match(/'-t' is not valid for the 'build'/);
  });

  it("parses the (undocumented) force flag in both spellings", () => {
    expect(parseCommandLine(["node", "fabr", "build", "-f", "foo"]).force).to.be.true;
    expect(parseCommandLine(["node", "fabr", "test", "--force", "foo"]).force).to.be.true;
    expect(parseCommandLine(["node", "fabr", "build", "foo"]).force).to.be.false;
  });

  it("keeps -f out of the help text (it is a development aid, not an interface)", () => {
    const { out } = capture(["-h"]);
    expect(out.join("\n")).to.not.match(/-f\b|--force/);
  });

  it("rejects -f for a command that builds nothing (ls)", () => {
    expect(capture(["ls", "-f", "foo"]).err.join("\n")).to.match(/'-f' is not valid for the 'ls'/);
  });

  it("rejects -f together with -w, whichever order they are written in", () => {
    /* Forcing names this invocation's work; a watch cycle would force the same
     * target on every rebuild, so the pair is a mistake rather than a request. */
    expect(capture(["build", "-f", "-w", "foo"]).err.join("\n")).to.match(/'-f' and '-w' cannot be combined/);
    expect(capture(["-w", "build", "--force", "foo"]).err.join("\n")).to.match(/'-f' and '-w' cannot be combined/);
  });

  it("parses --retry-failed for test only, and refuses it with -w", () => {
    expect(parseCommandLine(["node", "fabr", "test", "--retry-failed", "foo"]).retryFailed).to.be.true;
    expect(parseCommandLine(["node", "fabr", "test", "foo"]).retryFailed).to.be.false;
    expect(capture(["build", "--retry-failed", "foo"]).err.join("\n")).to.match(/'--retry-failed' is not valid for the 'build'/);
    expect(capture(["test", "--retry-failed", "-w", "foo"]).err.join("\n")).to.match(/'--retry-failed' and '-w' cannot be combined/);
  });

  it("reports the flag as the user typed it (--quiet vs -q)", () => {
    expect(capture(["list-targets", "--quiet"]).err.join("\n")).to.match(
      /Option '--quiet' is not valid for the 'list-targets' command/
    );
  });

  it("turns the progress display off with --no-progress, for any command that runs build steps", () => {
    expect(parseCommandLine(["node", "fabr", "build", "--no-progress", "foo"]).progress).to.equal(false);
    expect(parseCommandLine(["node", "fabr", "cat", "--no-progress", "foo"]).progress).to.equal(false);
    expect(capture(["list-targets", "--no-progress"]).err.join("\n")).to.match(/Option '--no-progress' is not valid/);
  });

  it("parses sbom as a query over one target", () => {
    const options = parseCommandLine(["node", "fabr", "sbom", "app"]);
    expect(options.command).to.equal("sbom");
    expect(options.targets).to.deep.equal(["app"]);
    expect(capture(["sbom", "app", "lib"]).err.join("\n")).to.match(/takes a single target/);
    expect(capture(["sbom"]).err.join("\n")).to.match(/requires/);
  });

  it("parses test --report with the format it is written in", () => {
    const options = parseCommandLine(["node", "fabr", "test", "--report", "out/junit.xml", "--format", "junit", "app"]);
    expect(options.reportFile).to.equal("out/junit.xml");
    expect(options.format).to.equal("junit");
    expect(options.targets).to.deep.equal(["app"]);
    expect(parseCommandLine(["node", "fabr", "test", "--report=out/report.json", "app"]).format).to.equal(undefined);
    expect(capture(["test", "--report", "x", "--format", "sarif", "app"]).err.join("\n")).to.match(
      /takes ctrf or junit for the 'test' command/
    );
    expect(capture(["test", "--format", "junit", "app"]).err.join("\n")).to.match(/needs '--report FILE'/);
    expect(capture(["build", "--report", "x", "app"]).err.join("\n")).to.match(/not valid/);
  });

  it("parses audit as a query over names, with --format for its output", () => {
    const options = parseCommandLine(["node", "fabr", "audit", "--format", "sarif", "app", "@npm:glob:10.0.0"]);
    expect(options.command).to.equal("audit");
    expect(options.format).to.equal("sarif");
    expect(options.targets).to.deep.equal(["app", "@npm:glob:10.0.0"]);
    expect(parseCommandLine(["node", "fabr", "audit", "--format=sarif", "app"]).format).to.equal("sarif");
    expect(parseCommandLine(["node", "fabr", "audit", "app"]).format).to.equal(undefined);
    expect(capture(["audit", "--format", "json", "app"]).err.join("\n")).to.match(/takes sarif/);
    expect(capture(["audit", "--format"]).err.join("\n")).to.match(/requires a format/);
    expect(capture(["deps", "--format", "sarif", "app"]).err.join("\n")).to.match(/not valid/);
    expect(capture(["audit"]).err.join("\n")).to.match(/requires/);
  });

  it("parses list-targets --operation, repeatable, with names and patterns after it", () => {
    const options = parseCommandLine(["node", "fabr", "list-targets", "--operation", "run", "--operation=test", "tools/*"]);
    expect(options.operations).to.deep.equal(["run", "test"]);
    expect(options.targets).to.deep.equal(["tools/*"]);
    expect(parseCommandLine(["node", "fabr", "list-targets"]).operations).to.equal(undefined);
    expect(capture(["list-targets", "--operation"]).err.join("\n")).to.match(/requires an operation/);
    expect(capture(["list-targetdefs", "--operation", "run"]).err.join("\n")).to.match(/not valid/);
  });

  it("asks for every mutable document to be re-checked with --refresh, for any command that fetches", () => {
    expect(parseCommandLine(["node", "fabr", "build", "foo"]).refresh).to.equal(false);
    expect(parseCommandLine(["node", "fabr", "deps", "--refresh", "foo"]).refresh).to.equal(true);
    expect(parseCommandLine(["node", "fabr", "--refresh", "foo"]).refresh).to.equal(true);
    expect(capture(["list-targets", "--refresh"]).err.join("\n")).to.match(/Option '--refresh' is not valid/);
  });

  it("treats arguments after -- as targets, even dash-prefixed ones", () => {
    const options = parseCommandLine(["node", "fabr", "cat", "--", "-weird", "pkg:-x.js"]);
    expect(options.command).to.equal("cat");
    expect(options.targets).to.deep.equal(["-weird", "pkg:-x.js"]);
  });

  it("does not consume -- itself as a target", () => {
    expect(parseCommandLine(["node", "fabr", "build", "--", "foo"]).targets).to.deep.equal(["foo"]);
  });

  it("shields a command word after --, so a target named like a command builds", () => {
    /* The deferred tail carries the `--` along, so the second pass reads the
     * shielded name as the positional it already was. */
    const options = parseCommandLine(["node", "fabr", "--", "test"]);
    expect(options.command).to.equal("build");
    expect(options.deferred).to.deep.equal(["--", "test"]);
    const plan = completeCommandLine(options, () => ["build"]);
    expect(plan.build).to.deep.equal(["test"]);
    expect(options.targets).to.deep.equal(["test"]);
  });

  it("treats a second -- as an ordinary positional", () => {
    expect(parseCommandLine(["node", "fabr", "cat", "--", "--", "x"]).targets).to.deep.equal(["--", "x"]);
  });

  it("still parses options that come before --", () => {
    const options = parseCommandLine(["node", "fabr", "ls", "-l", "--", "-x"]);
    expect(options.command).to.equal("ls");
    expect(options.longListing).to.be.true;
    expect(options.targets).to.deep.equal(["-x"]);
  });

  it("rejects a second target for a single-target command (shell)", () => {
    const { exit, out, err } = capture(["shell", "a", "b"]);
    expect(exit).to.equal(1);
    expect(err.join("\n")).to.match(/The 'shell' command takes a single target/);
    expect(out).to.deep.equal([]);
  });

  it("accepts a single target for shell", () => {
    expect(parseCommandLine(["node", "fabr", "shell", "a"]).targets).to.deep.equal(["a"]);
  });

  it("still forwards extra run positionals as program args, not a target error", () => {
    const options = parseCommandLine(["node", "fabr", "run", "tool", "a", "b"]);
    expect(options.targets).to.deep.equal(["tool"]);
    expect(options.runArgs).to.deep.equal(["a", "b"]);
  });

  it("accepts a valid command flag given before the command (-w test)", () => {
    const options = parseCommandLine(["node", "fabr", "-w", "test", "foo"]);
    expect(options.mode).to.equal(Mode.Watch);
  });

  describe("inferred commands", () => {
    /* What each target type supports, as the model would report it. */
    const OPERATIONS = new Map([
      ["lib", ["build", "run", "test"]],
      ["suite", ["test"]],
      ["server", ["run"]],
      ["anything", ["*"]],
    ]);
    const operationsOf = (name: string): string[] => OPERATIONS.get(name) ?? [];

    /** Parse without a command and finish against the fake model. */
    function plan(...args: string[]): ReturnType<typeof completeCommandLine> {
      return completeCommandLine(parseCommandLine(["node", "fabr", ...args]), operationsOf);
    }

    it("builds a target that supports building, even when it also runs and tests", () => {
      expect(plan("lib")).to.deep.equal({ build: ["lib"], test: [] });
    });

    it("tests a target whose type only tests", () => {
      expect(plan("suite")).to.deep.equal({ build: [], test: ["suite"] });
    });

    it("runs a target whose type only runs, and hands it the rest of the line", () => {
      expect(plan("server", "--port", "3000")).to.deep.equal({
        build: [],
        test: [],
        run: { target: "server", args: ["--port", "3000"] },
      });
    });

    it("takes a wildcard rule as building (it applies to any operation)", () => {
      expect(plan("anything")).to.deep.equal({ build: ["anything"], test: [] });
    });

    it("falls back to build for a name the model knows nothing about", () => {
      /* Which then fails as the ordinary unresolved-name/no-rule report. */
      expect(plan("nosuch")).to.deep.equal({ build: ["nosuch"], test: [] });
    });

    it("groups several targets by what each supports, running last", () => {
      expect(plan("lib", "suite", "server", "arg")).to.deep.equal({
        build: ["lib"],
        test: ["suite"],
        run: { target: "server", args: ["arg"] },
      });
    });

    it("applies fabr options found before the run target, not after it", () => {
      const options = parseCommandLine(["node", "fabr", "lib", "-q", "server", "-w"]);
      const result = completeCommandLine(options, operationsOf);
      expect(options.quiet).to.equal(true);
      expect(options.mode).to.equal(Mode.Normal);
      expect(result.run).to.deep.equal({ target: "server", args: ["-w"] });
    });

    it("takes a trace flag before or after the target (`fabr lib --trace`)", () => {
      for (const args of [
        ["lib", "--trace"],
        ["--trace", "lib"],
        ["lib", "--trace=out.json"],
      ]) {
        const options = parseCommandLine(["node", "fabr", ...args]);
        expect(completeCommandLine(options, operationsOf), args.join(" ")).to.deep.equal({ build: ["lib"], test: [] });
        expect(options.traceFile).to.equal(args.includes("--trace=out.json") ? "out.json" : "fabr-trace.json");
      }
    });

    it("takes a force flag from the deferred tail (`fabr lib -f`)", () => {
      /* Only the second pass sees it, which is why the driver re-reads the
       * run-wide options once the plan is complete. */
      const options = parseCommandLine(["node", "fabr", "lib", "-f"]);
      expect(options.force).to.equal(false);
      completeCommandLine(options, operationsOf);
      expect(options.force).to.equal(true);
    });

    it("rejects -f and -w even when they land in different parsing passes", () => {
      const { exit, err } = capture(["-f", "lib", "-w"], operationsOf);
      expect(exit).to.equal(1);
      expect(err[0]).to.match(/'-f' and '-w' cannot be combined/);
    });

    it("rejects an option no inferable command accepts", () => {
      const { exit, err } = capture(["lib", "-l"], operationsOf);
      expect(exit).to.equal(1);
      expect(err[0]).to.match(/Option '-l' is not valid without a command/);
    });

    describe("an operation a rule declares", () => {
      const declared = new Set(["lint"]);
      function planWith(...args: string[]): ReturnType<typeof completeCommandLine> {
        return completeCommandLine(parseCommandLine(["node", "fabr", ...args]), operationsOf, declared);
      }

      it("is a command building every target after it under the operation", () => {
        expect(planWith("lint", "lib", "suite")).to.deep.equal({
          build: [],
          test: [],
          operation: { name: "lint", targets: ["lib", "suite"] },
        });
      });

      it("takes the options build takes", () => {
        const options = parseCommandLine(["node", "fabr", "lint", "-w", "lib"]);
        completeCommandLine(options, operationsOf, declared);
        expect(options.mode).to.equal(Mode.Watch);
        expect(options.targets).to.deep.equal(["lib"]);
      });

      it("is a command over a target of the same name, which `--` reaches", () => {
        const operations = new Map([...OPERATIONS, ["lint", ["build"]]]);
        const options = parseCommandLine(["node", "fabr", "--", "lint"]);
        expect(completeCommandLine(options, name => operations.get(name) ?? [], declared)).to.deep.equal({
          build: ["lint"],
          test: [],
        });
      });

      it("is read as a target name where no rule declares it", () => {
        expect(planWith("lib", "lint")).to.deep.equal({ build: ["lib", "lint"], test: [] });
      });

      it("requires a target", () => {
        const { exit, err } = capture(["lint"], operationsOf, declared);
        expect(exit).to.equal(1);
        expect(err[0]).to.match(/The 'lint' command requires a target/);
      });
    });

    it("watches a run alongside other targets (they are independent chains)", () => {
      const options = parseCommandLine(["node", "fabr", "-w", "lib", "server"]);
      const result = completeCommandLine(options, operationsOf);
      expect(options.mode).to.equal(Mode.Watch);
      expect(result).to.deep.equal({ build: ["lib"], test: [], run: { target: "server", args: [] } });
    });
  });

  for (const flag of ["-h", "--help"]) {
    it(`prints the commands by group to stdout and exits 0 for ${flag}`, () => {
      const { exit, out, err } = capture([flag]);
      expect(exit).to.equal(0);
      const text = out.join("\n");
      expect(text).to.match(/^Usage: fabr \[command\]/);
      expect(text).to.match(/\nBuilding:\n {2}build /);
      expect(text).to.match(/\nInspecting:\n {2}ls /);
      /* Only the options of what a target's operation selects, and every command's. */
      expect(text).to.match(/\n {2}--trace\[=FILE\] /);
      expect(text).to.not.match(/--include-optional|--coverage/);
      expect(err).to.deep.equal([]);
    });
  }

  it("prints a command's help for 'help <command>', '<command> -h' and '-h <command>'", () => {
    const expected = capture(["help", "test"]);
    expect(expected.exit).to.equal(0);
    expect(expected.out.join("\n")).to.match(/^Usage: fabr test \[-w\] \[-u\]/);
    expect(expected.out.join("\n")).to.match(/\n {2}--coverage\[=DIR\] +Measure code coverage/);
    expect(expected.out.join("\n")).to.not.match(/--include-optional/);
    expect(capture(["test", "-h"]).out).to.deep.equal(expected.out);
    expect(capture(["-h", "test"]).out).to.deep.equal(expected.out);
  });

  it("describes an option as it applies to the command whose help it is in", () => {
    expect(capture(["help", "ls"]).out.join("\n")).to.match(/\n {2}-l +Show each file's hash and size/);
    expect(capture(["help", "list-targets"]).out.join("\n")).to.match(/\n {2}-l +Show where each is declared/);
  });

  it("prints the general help for '-h' after a command-less target", () => {
    const { exit, out } = capture(["foo", "-h"], () => ["build"]);
    expect(exit).to.equal(0);
    expect(out.join("\n")).to.match(/^Usage: fabr \[command\]/);
  });

  it("passes '-h' after a run's target to the program", () => {
    expect(parseCommandLine(["node", "fabr", "run", "tool", "-h"]).runArgs).to.deep.equal(["-h"]);
  });

  it("shows the help for the command given with an error found reading an option", () => {
    const { err } = capture(["test", "foo", "-t"]);
    expect(err).to.deep.equal(["Option '-t' requires a pattern\n", ...capture(["help", "test"]).out]);
  });

  it("refuses help for a command fabr does not have", () => {
    const { exit, err } = capture(["help", "nope"]);
    expect(exit).to.equal(1);
    expect(err[0]).to.match(/Unknown command 'nope'/);
  });

  it("lays every help page out within 80 columns", () => {
    for (const args of [["-h"], ...["build", "test", "run", "ls", "list-targets", "list-all", "audit"].map(c => ["help", c])]) {
      for (const line of capture(args).out.join("\n").split("\n")) {
        expect(line.length, `'${args.join(" ")}': ${line}`).to.be.at.most(80);
      }
    }
  });
});
