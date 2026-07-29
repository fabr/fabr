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
import { Mode, parseCommandLine } from "./Command";

/** Thrown by the stubbed process.exit to unwind parseCommandLine. */
class ExitSignal extends Error {}

/** Run parseCommandLine capturing an exit code and the stdout/stderr writes, so
 * the error/usage paths (which call process.exit) are testable in-process. */
function capture(args: string[]): { exit?: number; out: string[]; err: string[] } {
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
    parseCommandLine(["node", "fabr", ...args]);
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
  it("defaults to the build command", () => {
    expect(parseCommandLine(["node", "fabr", "foo"])).to.deep.equal({
      command: "build",
      mode: Mode.Normal,
      longListing: false,
      json: false,
      all: false,
      quiet: false,
      targets: ["foo"],
      properties: new Map(),
    });
  });

  it("parses an explicit command", () => {
    expect(parseCommandLine(["node", "fabr", "test", "foo", "bar"])).to.deep.equal({
      command: "test",
      mode: Mode.Normal,
      longListing: false,
      json: false,
      all: false,
      quiet: false,
      targets: ["foo", "bar"],
      properties: new Map(),
    });
  });

  it("treats later command-words as targets", () => {
    expect(parseCommandLine(["node", "fabr", "build", "test"]).targets).to.deep.equal(["test"]);
  });

  it("parses flags and defines alongside a command", () => {
    /* Not `run`: for `run`, options after the target pass through to the program */
    expect(parseCommandLine(["node", "fabr", "-w", "test", "foo", "-Dx=1"])).to.deep.equal({
      command: "test",
      mode: Mode.Watch,
      longListing: false,
      json: false,
      all: false,
      quiet: false,
      targets: ["foo"],
      properties: new Map([["x", "1"]]),
    });
  });

  it("parses the ls command with the long-listing flag", () => {
    expect(parseCommandLine(["node", "fabr", "ls", "-l", "foo", "bar"])).to.deep.equal({
      command: "ls",
      mode: Mode.Normal,
      longListing: true,
      json: false,
      all: false,
      quiet: false,
      targets: ["foo", "bar"],
      properties: new Map(),
    });
  });

  it("treats ls after another command as a target", () => {
    expect(parseCommandLine(["node", "fabr", "build", "ls"]).targets).to.deep.equal(["ls"]);
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

  it("sends an unrecognized-option error AND the usage to stderr, not stdout", () => {
    const { exit, out, err } = capture(["--bogus"]);
    expect(exit).to.equal(1);
    expect(err.join("\n")).to.match(/Unrecognized command-line option '--bogus'/);
    expect(err.join("\n")).to.match(/Usage: fabr/);
    expect(out).to.deep.equal([]);
  });

  it("prints usage to stdout and exits 0 with no target (the de-facto help)", () => {
    const { exit, out, err } = capture([]);
    expect(exit).to.equal(0);
    expect(out.join("\n")).to.match(/Usage: fabr/);
    expect(err).to.deep.equal([]);
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

  it("reports the flag as the user typed it (--quiet vs -q)", () => {
    expect(capture(["list-targets", "--quiet"]).err.join("\n")).to.match(
      /Option '--quiet' is not valid for the 'list-targets' command/
    );
  });

  it("treats arguments after -- as targets, even dash-prefixed ones", () => {
    const options = parseCommandLine(["node", "fabr", "cat", "--", "-weird", "pkg:-x.js"]);
    expect(options.command).to.equal("cat");
    expect(options.targets).to.deep.equal(["-weird", "pkg:-x.js"]);
  });

  it("does not consume -- itself as a target", () => {
    expect(parseCommandLine(["node", "fabr", "build", "--", "foo"]).targets).to.deep.equal(["foo"]);
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

  for (const flag of ["-h", "--help"]) {
    it(`prints per-command usage to stdout and exits 0 for ${flag}`, () => {
      const { exit, out, err } = capture([flag]);
      expect(exit).to.equal(0);
      const text = out.join("\n");
      expect(text).to.match(/Usage: fabr/);
      /* Each command lists its own options inline, e.g. `fabr run [-w] <target…>` */
      expect(text).to.match(/fabr run \[-w\] <target/);
      expect(text).to.match(/fabr ls \[-l\] <names>/);
      expect(err).to.deep.equal([]);
    });
  }
});
