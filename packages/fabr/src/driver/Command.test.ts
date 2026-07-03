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

import { Mode, parseCommandLine } from "./Command";

describe("Command", () => {
  it("defaults to the build command", () => {
    expect(parseCommandLine(["node", "fabr", "foo"])).toEqual({
      command: "build",
      mode: Mode.Normal,
      targets: ["foo"],
      properties: {},
    });
  });

  it("parses an explicit command", () => {
    expect(parseCommandLine(["node", "fabr", "test", "foo", "bar"])).toEqual({
      command: "test",
      mode: Mode.Normal,
      targets: ["foo", "bar"],
      properties: {},
    });
  });

  it("treats later command-words as targets", () => {
    expect(parseCommandLine(["node", "fabr", "build", "test"]).targets).toEqual(["test"]);
  });

  it("parses flags and defines alongside a command", () => {
    expect(parseCommandLine(["node", "fabr", "-w", "run", "foo", "-Dx=1"])).toEqual({
      command: "run",
      mode: Mode.Watch,
      targets: ["foo"],
      properties: { x: "1" },
    });
  });
});
