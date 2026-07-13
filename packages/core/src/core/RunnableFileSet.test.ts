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
import * as path from "path";
import { FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { Name, NameBuilder } from "./Name";
import { RunnableFileSet } from "./RunnableFileSet";

describe("RunnableFileSet", () => {
  it("carries its launch descriptor and is a FileSet", () => {
    const runnable = RunnableFileSet.forEntry(new Map([["run.js", MemoryFile.from("x")]]), "run.js", ["--flag"], "node");
    expect(runnable).to.be.instanceOf(FileSet);
    expect(runnable.args).to.deep.equal(["--flag"]);
    expect(runnable.interpreter).to.equal("node");
    expect(runnable.size).to.equal(1);
    expect(runnable.toCommandLine()).to.deep.equal(["node", "run.js", "--flag"]);
  });
});

describe("RunnableFileSet.toCommandLine", () => {
  it("places interpreter, entry, fixed args, then caller args", () => {
    const runnable = RunnableFileSet.forEntry(new Map(), "run.js", ["fixed"], "node");
    expect(runnable.toCommandLine(["extra"])).to.deep.equal(["node", "run.js", "fixed", "extra"]);
  });

  it("makes the entry itself the command when there is no interpreter", () => {
    const runnable = RunnableFileSet.forEntry(new Map(), "bin/tool", ["fixed"]);
    expect(runnable.toCommandLine(["extra"])).to.deep.equal(["bin/tool", "fixed", "extra"]);
  });

  it("anchors the entry against the install dir (for a cwd-independent launch)", () => {
    const withInterp = RunnableFileSet.forEntry(new Map(), "run.js", [], "node");
    expect(withInterp.toCommandLine([], { anchor: "/staged" })).to.deep.equal(["node", path.resolve("/staged", "run.js")]);
    /* interpreter-less: the anchored (absolute) entry becomes argv[0] itself. */
    const bare = RunnableFileSet.forEntry(new Map(), "bin/tool", []);
    expect(bare.toCommandLine([], { anchor: "/staged" })).to.deep.equal([path.resolve("/staged", "bin/tool")]);
  });
});

describe("RunnableFileSet.find with a rename", () => {
  it("renames the surface but stays a runnable, launching by the bin's rename-invariant target", async () => {
    /* forEntry gives a one-bin surface: command "tool" → SymlinkFile("bin/tool"). */
    const runnable = RunnableFileSet.forEntry(new Map([["bin/tool", MemoryFile.from("x")]]), "bin/tool");
    const rename = new NameBuilder().appendLiteralString("tool").name().withRenameTo(Name.fromLiteral("renamed"));

    const result = await runnable.find(rename);

    /* find on a runnable yields a runnable (not degraded to plain files)... */
    expect(result).to.be.instanceOf(RunnableFileSet);
    const rf = result as RunnableFileSet;
    /* ...with the find-surface command renamed... */
    expect([...rf.selected!].map(([name]) => name)).to.deep.equal(["renamed"]);
    /* ...but the launch entry is the bin's target, untouched by the rename. */
    expect(rf.toCommandLine()).to.deep.equal(["bin/tool"]);
  });
});

