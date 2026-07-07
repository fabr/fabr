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

describe("Command", () => {
  it("defaults to the build command", () => {
    expect(parseCommandLine(["node", "fabr", "foo"])).to.deep.equal({
      command: "build",
      mode: Mode.Normal,
      longListing: false,
      targets: ["foo"],
      properties: {},
    });
  });

  it("parses an explicit command", () => {
    expect(parseCommandLine(["node", "fabr", "test", "foo", "bar"])).to.deep.equal({
      command: "test",
      mode: Mode.Normal,
      longListing: false,
      targets: ["foo", "bar"],
      properties: {},
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
      targets: ["foo"],
      properties: { x: "1" },
    });
  });

  it("parses the ls command with the long-listing flag", () => {
    expect(parseCommandLine(["node", "fabr", "ls", "-l", "foo", "bar"])).to.deep.equal({
      command: "ls",
      mode: Mode.Normal,
      longListing: true,
      targets: ["foo", "bar"],
      properties: {},
    });
  });

  it("treats ls after another command as a target", () => {
    expect(parseCommandLine(["node", "fabr", "build", "ls"]).targets).to.deep.equal(["ls"]);
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
    expect(options.properties).to.deep.equal({ x: "1" });
    expect(options.targets).to.deep.equal(["mytool"]);
    expect(options.runArgs).to.deep.equal(["-Dy=2"]);
  });
});
