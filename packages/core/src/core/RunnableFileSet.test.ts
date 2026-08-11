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
import { FileSet, IFile } from "./FileSet";
import { SymlinkFile } from "./SymlinkFile";
import { FileSetRef, IProjection } from "./FileSetRef";
import { MemoryFile } from "./MemoryFS";
import { Name, NameBuilder } from "./Name";
import { parseName } from "../model/Parser";
import { RunnableFileSet, toRunnable } from "./RunnableFileSet";

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

describe("toRunnable", () => {
  const runnableWithBin = (): RunnableFileSet =>
    /* forEntry gives a one-bin surface: command "tool" → SymlinkFile("bin/tool"). */
    RunnableFileSet.forEntry(new Map([["bin/tool", MemoryFile.from("x")]]), "bin/tool");
  const renameToolTo = (to: string): Name =>
    new NameBuilder().appendLiteralString("tool").name().withRenameTo(Name.fromLiteral(to));

  it("passes an unprojected runnable through as itself", () => {
    const runnable = runnableWithBin();
    expect(toRunnable(runnable)).to.equal(runnable);
  });

  it("selects the renamed command but launches the bin's rename-invariant target", () => {
    const runnable = runnableWithBin();
    const ref = new FileSetRef(runnable, [{ pattern: renameToolTo("renamed"), prefix: "" }]);

    /* The rename applies to what the reference SELECTS... */
    expect([...ref.locate().values()]).to.deep.equal(["renamed"]);

    /* ...but collapsing yields an ordinary runnable launching the bin's target,
     * untouched by the rename. */
    const selected = toRunnable(ref);
    expect(selected).to.be.instanceOf(RunnableFileSet);
    expect(selected!.toCommandLine()).to.deep.equal(["bin/tool"]);
  });

  it("yields no runnable when the projection matched nothing — the lenient miss", () => {
    const ref = new FileSetRef(runnableWithBin(), [{ pattern: Name.fromLiteral("absent"), prefix: "" }]);
    expect(toRunnable(ref)).to.equal(undefined);
  });

  it("yields no runnable for a ref over something that is not one", () => {
    const files = new FileSet(new Map<string, IFile>([["a.js", MemoryFile.from("x")]]));
    expect(toRunnable(new FileSetRef(files, [{ pattern: Name.fromLiteral("a.js"), prefix: "" }]))).to.equal(undefined);
    expect(toRunnable(files)).to.equal(undefined);
  });

  it("composes: a further find matches the previous step's output", () => {
    /* The second step names "renamed" — which only the first step produces. */
    const ref = new FileSetRef(runnableWithBin(), [{ pattern: renameToolTo("renamed"), prefix: "" }]).find(
      Name.fromLiteral("renamed")
    );

    expect(ref.projections).to.have.lengthOf(2);
    expect(toRunnable(ref)!.toCommandLine()).to.deep.equal(["bin/tool"]);
  });
});


describe("RunnableFileSet.locate", () => {
  const project = (selector: Name): IProjection[] => [{ pattern: selector, prefix: "" }];
  const literal = (text: string): Name => Name.fromLiteral(text);

  it("resolves a bin by command name to the file it targets, not the command", () => {
    /* forEntry gives a one-bin surface: command "tool" → SymlinkFile("bin/tool"). */
    const runnable = RunnableFileSet.forEntry(new Map([["bin/tool", MemoryFile.from("x")]]), "bin/tool");
    expect([...runnable.locate(project(literal("tool")))]).to.deep.equal([["bin/tool", "tool"]]);
  });

  it("resolves the same entry by path against a full surface — one key either way", () => {
    /* An npm-style surface (makeNpmRunnable): files by path AND a bin by command. */
    const bin = new SymlinkFile("bin/tool");
    const file = MemoryFile.from("x");
    const surface = new FileSet(new Map<string, IFile>([["tool", bin], ["bin/tool", file]]));
    const runnable = new RunnableFileSet(new Map([["bin/tool", file]]), [], undefined, "", surface);

    expect([...runnable.locate(project(literal("bin/tool")))]).to.deep.equal([["bin/tool", "bin/tool"]]);
    /* Same underlying entry reached by command name — same key, its own name. */
    expect([...runnable.locate(project(literal("tool")))]).to.deep.equal([["bin/tool", "tool"]]);
  });

  it("keeps a rename in the name while the key stays the launchable path", () => {
    const runnable = RunnableFileSet.forEntry(new Map([["bin/tool", MemoryFile.from("x")]]), "bin/tool");
    const rename = new NameBuilder().appendLiteralString("tool").name().withRenameTo(Name.fromLiteral("renamed"));
    expect([...runnable.locate(project(rename))]).to.deep.equal([["bin/tool", "renamed"]]);
  });

  it("is empty when the projection matches nothing on the surface", () => {
    const runnable = RunnableFileSet.forEntry(new Map([["bin/tool", MemoryFile.from("x")]]), "bin/tool");
    expect(runnable.locate(project(literal("absent"))).size).to.equal(0);
  });
});

describe("RunnableFileSet.select", () => {
  const project = (selector: string): IProjection[] => [{ pattern: parseName(selector), prefix: "" }];
  /* An npm-style runnable: the install is keyed by mount path, the surface by
   * command (a bin symlink) AND by in-package path. */
  const npmStyle = (): RunnableFileSet => {
    const file = MemoryFile.from("#!/usr/bin/env node\n");
    const surface = new FileSet(
      new Map<string, IFile>([
        ["tool", new SymlinkFile("node_modules/thing/bin/tool")],
        ["bin/tool", file],
      ])
    );
    return new RunnableFileSet(new Map([["node_modules/thing/bin/tool", file]]), [], "node", "node_modules/thing", surface);
  };

  it("selects through the launch surface, yielding the file a bin targets", () => {
    /* The install path is `node_modules/thing/bin/tool`; a runnable is addressed
     * by what it offers to launch, so the reference names `tool`. */
    expect([...npmStyle().select(project("tool"))].map(([name]) => name)).to.deep.equal(["tool"]);
    expect([...npmStyle().select(project("bin/tool"))].map(([name]) => name)).to.deep.equal(["bin/tool"]);
  });

  it("does not select by install path — that is not how a runnable is addressed", () => {
    expect(npmStyle().select(project("node_modules/thing/bin/tool")).isEmpty()).to.equal(true);
  });

  it("agrees with locate: same matches, the other reading", () => {
    const runnable = npmStyle();
    expect([...runnable.select(project("tool"))].map(([name]) => name)).to.deep.equal([
      ...runnable.locate(project("tool")).values(),
    ]);
  });

  it("raises a conflict when two entries land on one name", () => {
    /* A collapse-to-one-name rename is legal to *write* (the grammar exempts a
     * wildcard-free template), so whether it is legal is decided here, against
     * the files it actually selects: matching two is FileSet.rename's conflict,
     * never silently keeping whichever file came last. */
    const surface = new FileSet(
      new Map<string, IFile>([["one.js", MemoryFile.from("1")], ["two.js", MemoryFile.from("2")]])
    );
    const runnable = new RunnableFileSet(
      new Map([["one.js", MemoryFile.from("1")], ["two.js", MemoryFile.from("2")]]),
      [],
      "node",
      "",
      surface
    );
    const manyToOne = [{ pattern: parseName("*.js -> out.js"), prefix: "" }];
    expect(() => runnable.select(manyToOne)).to.throw(/Conflicting renamed files for out.js/);
  });
});
