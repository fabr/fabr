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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Computable } from "./Computable";
import { FileSet, IFile } from "./FileSet";
import { FSFileSource } from "./FSFileSource";
import { MemoryFile } from "./MemoryFS";
import { parseName } from "../model/Parser";
import { ISourcePathStep, SOURCE_PATH_PROVENANCE, sourcePathOf } from "./Provenance";
import { IWriteBackCandidate, IWriteBackObserver, WriteBackFileSet, writeBackCandidates, writeBackFile } from "./WriteBack";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** A fresh project directory per test, cleaned up after it. */
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-writeback-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** An offer as a rule makes one: content named in the inputs' own namespace,
 * plus the rewrite saying which input each name belongs to. Never a host path. */
function candidate(content: string, at: string): IWriteBackCandidate {
  return {
    files: FileSet.layout({ [at]: MemoryFile.from(content) }),
    belongsTo: parseName("**/__snapshots__/*.snap").withRenameTo(parseName("**/*")),
    origin: undefined,
  };
}

/** A tree whose files a reference from the project names, as the project's
 * own source does. */
class ProjectTree extends FSFileSource {
  public override get sourcePathPrefix(): string {
    return "./";
  }
}

describe("sourcePathOf", () => {
  it("names a file in a source query by its path from the project root", async () => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/a.txt"), "a");
    const files = await new ProjectTree(dir).find(parseName("src:*.txt"));
    /* The projection stripped `src/`, so the result name alone cannot say where
     * the file was read from — which is exactly what the provenance step
     * records. */
    expect([...files].map(([name]) => name)).to.deep.equal(["a.txt"]);
    expect(sourcePathOf(files.origin, "a.txt")).to.equal("./src/a.txt");
  });

  it("names nothing read from a tree no reference addresses", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const files = await new FSFileSource(dir).find(parseName("*.txt"));
    expect(sourcePathOf(files.origin, "a.txt")).to.equal(undefined);
  });

  it("follows a file through a union, a mount and a rename to its own source", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const files = await new ProjectTree(dir).find(parseName("*.txt"));
    /* Assembly rebases before delegating, so a file's origin survives being
     * unioned with generated content and mounted under a prefix. */
    const generated = new FileSet(new Map<string, IFile>([["b.txt", MemoryFile.from("b")]]));
    const install = FileSet.layout({ lib: [FileSet.unionAll(files, generated)] });
    expect(sourcePathOf(install.origin, "lib/a.txt")).to.equal("./a.txt");
    expect(install.mountedAt("top").sourcePathOf("top/lib/a.txt")).to.equal("./a.txt");
    expect(install.rename(name => name.replace(/\.txt$/, ".out")).sourcePathOf("lib/a.out")).to.equal("./a.txt");
    /* Generated content has no source path, and does not borrow one. */
    expect(sourcePathOf(install.origin, "lib/b.txt")).to.equal(undefined);
  });

  it("names content a reference names whole by that reference, where nothing beneath names it", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const tree = await new ProjectTree(dir).find(parseName("*.txt"));
    const generated = new FileSet(new Map<string, IFile>([["b.txt", MemoryFile.from("b")]]));
    const step: ISourcePathStep = { kind: SOURCE_PATH_PROVENANCE, sourcePath: "gen" };
    const built = FileSet.unionAll(tree, generated).withStep(step);
    expect(built.sourcePathOf("b.txt")).to.equal("gen:b.txt");
    /* A file passed through unchanged keeps its own. */
    expect(built.sourcePathOf("a.txt")).to.equal("./a.txt");
  });

  it("names a file two contributors hold by the least of their source paths, whatever the union's order", () => {
    const file = MemoryFile.from("same");
    const named = (sourcePath: string): FileSet => {
      const step: ISourcePathStep = { kind: SOURCE_PATH_PROVENANCE, sourcePath };
      return new FileSet(new Map<string, IFile>([["a.txt", file]]), step);
    };
    const forward = FileSet.unionAll(named("y"), named("x"));
    const backward = FileSet.unionAll(named("x"), named("y"));
    expect([forward.sourcePathOf("a.txt"), backward.sourcePathOf("a.txt")]).to.deep.equal(["x:a.txt", "x:a.txt"]);
    expect(forward.sourcePathsDigest).to.equal(backward.sourcePathsDigest);
  });

  it("digests what names the files: the same where every name is, different where any is not", () => {
    const content = new Map<string, IFile>([["b.txt", MemoryFile.from("b")]]);
    const named = (sourcePath: string): FileSet => {
      const step: ISourcePathStep = { kind: SOURCE_PATH_PROVENANCE, sourcePath };
      return new FileSet(content, step);
    };
    expect(named("gen").sourcePathsDigest).to.equal(named("gen").sourcePathsDigest);
    expect(named("gen").sourcePathsDigest).to.not.equal(named("gen2").sourcePathsDigest);
    expect(named("gen").mountedAt("lib").sourcePathsDigest).to.not.equal(named("gen2").mountedAt("lib").sourcePathsDigest);
    expect(new FileSet(content).sourcePathsDigest).to.equal("");
  });

  it("digests a merge by its contributors' naming, not their content", () => {
    const named = (sourcePath: string, files: [string, string][]): FileSet => {
      const step: ISourcePathStep = { kind: SOURCE_PATH_PROVENANCE, sourcePath };
      return new FileSet(new Map<string, IFile>(files.map(([name, text]) => [name, MemoryFile.from(text)])), step);
    };
    const merged = (a: [string, string][], b: [string, string][]): string =>
      FileSet.unionAll(named("x", a), named("y", b)).sourcePathsDigest;
    expect(merged([["a.txt", "one"]], [["b.txt", "b"]]), "an edit").to.equal(merged([["a.txt", "two"]], [["b.txt", "b"]]));
    /* At one mount, which contributor holds a name decides its source path. */
    expect(merged([["a.txt", "one"]], [["b.txt", "b"]]), "a move between contributors").to.not.equal(
      merged([["b.txt", "b"]], [["a.txt", "one"]])
    );
    /* At disjoint mounts the name alone decides. */
    const laidOut = (a: [string, string][]): string =>
      FileSet.layout({ x: named("x", a), y: named("y", [["b.txt", "b"]]) }).sourcePathsDigest;
    expect(laidOut([["a.txt", "one"]]), "a file added at a disjoint mount").to.equal(laidOut([["a.txt", "one"], ["c.txt", "c"]]));
  });

  it("digests a tree read and a rename by the prefixes their names follow, where one mapping fits", async () => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "a");
    const one = await new ProjectTree(dir).find(parseName("src:*.ts"));
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "b");
    const two = await new ProjectTree(dir).find(parseName("src:*.ts"));
    expect(two.sourcePathOf("b.ts")).to.equal("./src/b.ts");
    expect(one.sourcePathsDigest, "a file added").to.equal(two.sourcePathsDigest);
    const lib = await new ProjectTree(dir).find(parseName("src/*.ts"));
    expect(lib.sourcePathsDigest, "another projection").to.not.equal(two.sourcePathsDigest);
    const shifted = (set: FileSet): FileSet => set.rename(name => `out/${name}`);
    expect(shifted(one).sourcePathsDigest, "renamed alike").to.equal(shifted(two).sourcePathsDigest);
    const swapped = two.rename(name => (name === "a.ts" ? "b.ts" : "a.ts"));
    expect(swapped.sourcePathOf("a.ts")).to.equal("./src/b.ts");
    expect(swapped.sourcePathsDigest, "a renaming no mapping fits").to.not.equal(two.sourcePathsDigest);
  });

  it("says nothing about a file no chain explains", () => {
    expect(sourcePathOf(undefined, "a.txt")).to.equal(undefined);
  });
});

describe("writeBackCandidates", () => {
  it("collects what a built result offers, and nothing from a plain one", () => {
    const offered = candidate("x", "__snapshots__/a.ts.snap");
    const carrier = new WriteBackFileSet(new Map<string, IFile>(), [offered]);
    const plain = new FileSet(new Map<string, IFile>());
    expect(writeBackCandidates([carrier, plain])).to.deep.equal([offered]);
    expect(writeBackCandidates([plain])).to.deep.equal([]);
  });
});

describe("writeBackFile", () => {
  function observed(): { observer: IWriteBackObserver; touched: string[] } {
    const touched: string[] = [];
    return { observer: { content: () => undefined, touches: p => touched.push(p) }, touched };
  }

  it("writes the candidate's bytes at the destination via a temp sibling", async () => {
    const { observer } = observed();
    const destination = path.join(dir, "sub", "a.snap");
    const written = await toPromise(writeBackFile({ file: MemoryFile.from("fresh"), destination }, fs.realpathSync(dir), observer));
    expect(written).to.equal(destination);
    expect(fs.readFileSync(destination, "utf8")).to.equal("fresh");
  });

  it("gives writes to one destination distinct temp siblings", async () => {
    /* Two candidates in one batch may resolve to the same destination, so the
     * temp name must be unique per write, not just per process. */
    const { observer, touched } = observed();
    const destination = path.join(dir, "a.snap");
    const root = fs.realpathSync(dir);
    await Promise.all([
      toPromise(writeBackFile({ file: MemoryFile.from("one"), destination }, root, observer)),
      toPromise(writeBackFile({ file: MemoryFile.from("two"), destination }, root, observer)),
    ]);
    const temps = touched.filter(name => name.startsWith(`${destination}.fabr-writeback-`));
    expect(temps).to.have.lengthOf(2);
    expect(new Set(temps).size).to.equal(2);
  });
});
