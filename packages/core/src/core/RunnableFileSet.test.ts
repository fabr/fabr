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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSet, IFile } from "./FileSet";
import { HostLink, SymlinkFile } from "./SymlinkFile";
import { FileSetRef } from "./FileSetRef";
import { IProjection } from "./Reference";
import { MemoryFile } from "./MemoryFS";
import { Name, NameBuilder } from "./Name";
import { parseName } from "../model/Parser";
import { manifestArguments, RunnableFileSet, startLaunch, toArgv, toRunnable } from "./RunnableFileSet";
import { Computable } from "./Computable";
import { ownerName, TREE_MOUNT } from "./BuildCache";

const NODE = new HostLink("node-hash", "/opt/node/bin/node");

describe("RunnableFileSet", () => {
  it("carries its launch descriptor and is a FileSet", () => {
    const runnable = RunnableFileSet.forEntry(new Map([["run.js", MemoryFile.from("x")]]), "run.js", ["--flag"], NODE);
    expect(runnable).to.be.instanceOf(FileSet);
    expect(runnable.args).to.deep.equal(["--flag"]);
    expect(runnable.interpreter).to.equal(NODE);
    expect(runnable.size).to.equal(1);
    expect(runnable.toCommandLine()).to.deep.equal([NODE, { installFile: "run.js" }, "--flag"]);
    expect(toArgv(runnable.toCommandLine())).to.deep.equal(["/opt/node/bin/node", "run.js", "--flag"]);
  });
});

describe("RunnableFileSet.toCommandLine", () => {
  it("places interpreter, entry, fixed args, then caller args", () => {
    const runnable = RunnableFileSet.forEntry(new Map(), "run.js", ["fixed"], NODE);
    expect(toArgv(runnable.toCommandLine(["extra"]))).to.deep.equal(["/opt/node/bin/node", "run.js", "fixed", "extra"]);
  });

  it("makes the entry itself the command when there is no interpreter", () => {
    const runnable = RunnableFileSet.forEntry(new Map(), "bin/tool", ["fixed"]);
    expect(toArgv(runnable.toCommandLine(["extra"]))).to.deep.equal(["bin/tool", "fixed", "extra"]);
    expect(toArgv(RunnableFileSet.forEntry(new Map(), "tool").toCommandLine())).to.deep.equal(["./tool"]);
  });

  it("anchors the install files against the install dir (for a cwd-independent launch)", () => {
    const withInterp = RunnableFileSet.forEntry(new Map(), "run.js", [], NODE);
    expect(toArgv(withInterp.toCommandLine(), "/staged")).to.deep.equal(["/opt/node/bin/node", path.resolve("/staged", "run.js")]);
    /* interpreter-less: the anchored (absolute) entry becomes argv[0] itself. */
    const bare = RunnableFileSet.forEntry(new Map(), "bin/tool", []);
    expect(toArgv(bare.toCommandLine(), "/staged")).to.deep.equal([path.resolve("/staged", "bin/tool")]);
  });

  it("runs through a runnable interpreter, reached by its hash in the tree pool beside the launch directory", async () => {
    const node = RunnableFileSet.forEntry(new Map([["bin/node", MemoryFile.from("node")]]), "bin/node", ["--flag"]);
    const ensured: string[] = [];
    const pool = { ensureTree: (files: FileSet) => (ensured.push(files.toManifestHash()), Computable.resolve("unused")) };
    const runnable = await new Promise<RunnableFileSet>((resolve, reject) =>
      RunnableFileSet.forEntry(new Map(), "run.js", ["fixed"]).launchedBy(node, pool).then(resolve, reject)
    );
    const hash = node.toManifestHash();
    const at = `${TREE_MOUNT}/${hash}`;
    expect(ensured).to.deep.equal([hash]);
    /* The install carries nothing of the pool's. */
    expect([...runnable]).to.deep.equal([]);
    expect(toArgv(runnable.toCommandLine(["x"]))).to.deep.equal([`${at}/bin/node`, "--flag", "run.js", "fixed", "x"]);
    /* Mounted below the launch directory, the entry moves and the pool does not. */
    expect(toArgv(runnable.toCommandLine([], { base: "tool" }))).to.deep.equal([`${at}/bin/node`, "--flag", "tool/run.js", "fixed"]);
    expect(toArgv(runnable.toCommandLine([], { base: "../tool", pool: `../${TREE_MOUNT}` }))).to.deep.equal([`../${at}/bin/node`, "--flag", "../tool/run.js", "fixed"]);
    expect(toArgv(runnable.toCommandLine(), "/staged/work")).to.deep.equal([path.resolve("/staged/work", at, "bin/node"), "--flag", path.resolve("/staged/work", "run.js"), "fixed"]);
    expect(path.resolve("/staged/work", at)).to.equal(`/staged/.fabr-tree/${hash}`);
  });

  it("runs through a program of the host where it lies, writing nothing to the tree pool", async () => {
    const host = new RunnableFileSet([], [], undefined, "", new FileSet(new Map<string, IFile>([["node", NODE]])));
    const ensured: string[] = [];
    const pool = { ensureTree: (files: FileSet) => (ensured.push(files.toManifestHash()), Computable.resolve("unused")) };
    const runnable = await new Promise<RunnableFileSet>((resolve, reject) =>
      RunnableFileSet.forEntry(new Map(), "run.js", ["fixed"]).launchedBy(host, pool).then(resolve, reject)
    );
    expect(ensured).to.deep.equal([]);
    expect(runnable.interpreter).to.equal(NODE);
    expect(toArgv(runnable.toCommandLine(["x"], { base: "tool" }))).to.deep.equal(["/opt/node/bin/node", "tool/run.js", "fixed", "x"]);
    /* A program of the host as the entry is the command, wherever the install is. */
    expect(host.toCommandLine(["-e", "1"], { base: "tool" })).to.deep.equal([NODE, "-e", "1"]);
    expect(toArgv(host.toCommandLine(["-e", "1"]), "/staged")).to.deep.equal(["/opt/node/bin/node", "-e", "1"]);
  });
});

describe("RunnableFileSet arguments naming install files", () => {
  it("names an install file wherever the install is reached, the program's own options before its entry", async () => {
    const java = RunnableFileSet.forEntry(new Map([["bin/java", MemoryFile.from("java")]]), "bin/java");
    const pool = { ensureTree: () => Computable.resolve("unused") };
    const modulePath = { join: ":", parts: [{ installFile: "lib/a.jar" }, { installFile: "lib/b.jar" }] };
    const program = await new Promise<RunnableFileSet>((resolve, reject) =>
      RunnableFileSet.forEntry(new Map(), "launcher.jar", [{ join: "", parts: ["--config=", { installFile: "etc/app.conf" }] }])
        .launchedBy(java, pool, [{ join: "", parts: ["--module-path=", modulePath] }, "-jar"])
        .then(resolve, reject)
    );
    const at = `${TREE_MOUNT}/${java.toManifestHash()}`;
    expect(toArgv(program.toCommandLine([], { base: "tool" }))).to.deep.equal([
      `${at}/bin/java`,
      "--module-path=tool/lib/a.jar:tool/lib/b.jar",
      "-jar",
      "tool/launcher.jar",
      "--config=tool/etc/app.conf",
    ]);
    expect(toArgv(program.toCommandLine(), "/staged")).to.deep.equal([
      path.resolve("/staged", at, "bin/java"),
      `--module-path=${path.resolve("/staged/lib/a.jar")}:${path.resolve("/staged/lib/b.jar")}`,
      "-jar",
      path.resolve("/staged", "launcher.jar"),
      `--config=${path.resolve("/staged/etc/app.conf")}`,
    ]);
  });
});

describe("manifestArguments and toArgv", () => {
  const cc = new HostLink("cc-hash", "/usr/bin/cc");
  const args = [
    "-c",
    cc,
    { installFile: "lib/a.jar" },
    { join: "=", parts: ["--path", { join: ":", parts: [{ installFile: "x" }, cc, "y"] }] },
  ];

  it("writes each kind of argument as key text, naming a program of the host by content and command", () => {
    expect(manifestArguments(args)).to.equal(
      JSON.stringify([
        "-c",
        { host: "cc-hash", command: "cc" },
        { installFile: "lib/a.jar" },
        { join: "=", parts: ["--path", { join: ":", parts: [{ installFile: "x" }, { host: "cc-hash", command: "cc" }, "y"] }] },
      ])
    );
  });

  it("writes no host path into the key text", () => {
    expect(manifestArguments(args)).not.to.include("/usr/bin");
    expect(manifestArguments([new HostLink("cc-hash", "/opt/other/cc")])).to.equal(manifestArguments([cc]));
  });

  it("tells apart the commands one program is run as, and text from what it might spell", () => {
    expect(manifestArguments([new HostLink("cc-hash", "/usr/bin/c++")])).not.to.equal(manifestArguments([cc]));
    expect(manifestArguments([JSON.stringify({ installFile: "x" })])).not.to.equal(manifestArguments([{ installFile: "x" }]));
    expect(manifestArguments([{ join: "", parts: ["a", "b"] }])).not.to.equal(manifestArguments(["ab"]));
  });

  it("writes each kind of argument as command-line text", () => {
    expect(toArgv(args)).to.deep.equal(["-c", "/usr/bin/cc", "lib/a.jar", "--path=x:/usr/bin/cc:y"]);
    expect(toArgv(args, "/staged")).to.deep.equal(["-c", "/usr/bin/cc", "/staged/lib/a.jar", "--path=/staged/x:/usr/bin/cc:y"]);
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
    expect(toArgv(selected!.toCommandLine())).to.deep.equal(["bin/tool"]);
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
    expect(toArgv(toRunnable(ref)!.toCommandLine())).to.deep.equal(["bin/tool"]);
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
    return new RunnableFileSet(new Map([["node_modules/thing/bin/tool", file]]), [], NODE, "node_modules/thing", surface);
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
      NODE,
      "",
      surface
    );
    const manyToOne = [{ pattern: parseName("*.js -> out.js"), prefix: "" }];
    expect(() => runnable.select(manyToOne)).to.throw(/Conflicting renamed files for out.js/);
  });
});

describe("startLaunch", () => {
  it("gives a launch with a teardown an identifier, and runs the teardown once when it ends", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-launch-"));
    try {
      const out = path.join(dir, "ended");
      const runnable = RunnableFileSet.forEntry(new Map([["run.sh", MemoryFile.from("")]]), "run.sh").withTeardown([
        process.execPath,
        "-e",
        "require('fs').appendFileSync(process.env.OUT, process.env.FABR_LAUNCH + '\\n')",
      ]);
      const launch = startLaunch(runnable, dir, { OUT: out });
      expect(launch.env?.FABR_LAUNCH).to.match(new RegExp(`^${ownerName()}-\\d+$`));
      launch.end();
      launch.end();
      expect(fs.readFileSync(out, "utf8")).to.equal(`${launch.env!.FABR_LAUNCH}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a launch with no teardown as it is", () => {
    const launch = startLaunch(RunnableFileSet.forEntry(new Map([["run.sh", MemoryFile.from("")]]), "run.sh"), "/nowhere", undefined);
    expect(launch.env).to.equal(undefined);
  });
});
